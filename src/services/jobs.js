// Background job loop (BullMQ/Redis in the AWS design; a simple in-process scheduler here).
import { Charger, Complaint, Reservation, FirmwareRollout, Session } from '../models/index.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { tickSessions } from './sessionEngine.js';
import { retryDueRefunds } from './refunds.js';
import { retryFailedInvoices } from './invoices.js';
import { raiseAlert } from './alerts.js';
import { runPayouts, reconcile } from './finance.js';
import { registry } from '../ocpp/registry.js';
import { markOffline } from '../ocpp/brain.js';
import { sendCommand } from '../ocpp/commands.js';
import { pushPendingCdrs } from '../roaming/ocpi/client.js';
import { cluster } from '../ocpp/cluster.js';

const timers = [];
const running = new Set();

function every(name, ms, fn) {
  const run = async () => {
    if (running.has(name) || !cluster().isLeader()) return; // with several nodes only the leader runs jobs
    running.add(name);
    try {
      await fn();
    } catch (e) {
      logger.error(`job ${name} failed`, e);
    } finally {
      running.delete(name);
    }
  };
  timers.push(setInterval(run, ms));
}

/** Chargers we think are online but whose socket is gone or silent for 2 heartbeats. */
export async function sweepOffline() {
  const limit = new Date(Date.now() - config.charging.heartbeatIntervalSec * 2 * 1000);
  const online = await Charger.find({ online: true }).select('ocppId tenant lastSeen');
  for (const c of online) {
    const conn = registry.get(c.ocppId);
    if ((!conn || conn.closed) && cluster().remoteOwner(c.ocppId) && c.lastSeen >= limit) continue; // held by another node
    if (!conn || conn.closed || c.lastSeen < limit) {
      if (conn && !conn.closed) conn.close(4001, 'heartbeat timeout');
      else await markOffline(c);
    }
  }
}

/** Uptime % over the last 30 days and a simple quality score (shown to drivers, used for roaming eligibility). */
export async function updateQuality() {
  const chargers = await Charger.find({ deletedAt: null }).select('online uptime createdAt connectedAt lastSuccessfulChargeAt');
  const now = Date.now();
  for (const c of chargers) {
    const windowStart = c.uptime?.windowStart || c.createdAt;
    const span = Math.max(1, (now - new Date(windowStart).getTime()) / 1000);
    const live = c.online && c.uptime?.lastTransitionAt ? (now - c.uptime.lastTransitionAt.getTime()) / 1000 : 0;
    const pct = Math.min(100, Math.round((((c.uptime?.onlineSeconds || 0) + live) / span) * 1000) / 10);
    const failed = await Session.countDocuments({ charger: c._id, state: 'FAILED', createdAt: { $gt: new Date(now - 7 * 86400_000) } });
    const ok = await Session.countDocuments({ charger: c._id, state: 'BILLED', createdAt: { $gt: new Date(now - 7 * 86400_000) } });
    const successPct = ok + failed ? (ok / (ok + failed)) * 100 : 100;
    await Charger.updateOne({ _id: c._id }, { $set: { 'uptime.scorePct': pct, qualityScore: Math.round(pct * 0.6 + successPct * 0.4) } });
  }
}

export async function complaintSla() {
  const overdue = await Complaint.find({ status: { $in: ['open', 'in_progress'] }, slaDueAt: { $lt: new Date() } }).limit(100);
  for (const c of overdue) {
    await raiseAlert({ tenant: c.tenant, type: 'complaint_sla', message: `Complaint ${c._id} breached its SLA`, dedupeKey: `sla:${c._id}` });
  }
}

export async function expireReservations() {
  await Reservation.updateMany({ status: { $in: ['pending', 'active'] }, expiresAt: { $lt: new Date() } }, { $set: { status: 'expired' } });
}

/** Staged firmware rollout: 1 charger, then 10%, then all (Admin 3.3). */
export async function advanceRollouts() {
  const rollouts = await FirmwareRollout.find({ stage: { $in: ['stage1', 'stage10', 'all'] } });
  for (const r of rollouts) {
    const total = r.chargerIds.length;
    const targets = r.stage === 'stage1' ? 1 : r.stage === 'stage10' ? Math.max(1, Math.ceil(total * 0.1)) : total;
    const sent = r.chargerIds.slice(0, targets);
    const doneCount = r.done.length;
    for (const id of sent) {
      if (r.done.some((d) => String(d) === String(id)) || r.sentTo?.includes?.(String(id))) continue;
      const ch = await Charger.findById(id).lean();
      if (!ch) continue;
      await sendCommand(ch, 'UpdateFirmware', { requestId: Date.now() % 1e9, firmware: { location: r.location, retrieveDateTime: new Date().toISOString() } }, { reason: `rollout ${r._id}`, bulkId: String(r._id), stage: r.stage });
      await FirmwareRollout.updateOne({ _id: r._id }, { $addToSet: { sentTo: String(id) } });
    }
    if (doneCount >= targets) {
      const next = r.stage === 'stage1' ? 'stage10' : r.stage === 'stage10' ? 'all' : 'done';
      await FirmwareRollout.updateOne({ _id: r._id }, { $set: { stage: next } });
    }
  }
}

let lastDaily = '';
async function daily() {
  const d = new Date().toISOString().slice(0, 10);
  const hour = new Date().getUTCHours();
  if (d === lastDaily || hour < 20) return; // ~01:30 IST
  lastDaily = d;
  const yesterday = new Date(Date.now() - 86400_000);
  await reconcile(yesterday);
  await runPayouts();
}

export function startJobs() {
  if (!config.jobsEnabled) return;
  every('sessions', 5000, tickSessions);
  every('refunds', 10000, retryDueRefunds);
  every('invoices', 30000, retryFailedInvoices);
  every('cdrs', 30000, pushPendingCdrs);
  every('offline', 30000, sweepOffline);
  every('quality', 120000, updateQuality);
  every('sla', 60000, complaintSla);
  every('reservations', 30000, expireReservations);
  every('rollouts', 15000, advanceRollouts);
  every('daily', 600000, daily);
  logger.info('background jobs started');
}

export function stopJobs() {
  while (timers.length) clearInterval(timers.pop());
}
