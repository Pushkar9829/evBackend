// Charger brain: OCPP 2.0.1 message handlers. 1.6J chargers arrive here already translated.
import { Charger, FirmwareRollout } from '../models/index.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { raiseAlert, resolveAlerts } from '../services/alerts.js';
import { events } from '../services/events.js';
import { authorizeToken, onConnectorStatus, onTransactionEvent } from '../services/sessionEngine.js';
import { sendCommand } from './commands.js';

const reload = (conn) => Charger.findById(conn.charger._id);

export async function handleCall(conn, action, p) {
  switch (action) {
    case 'BootNotification': {
      const cs = p.chargingStation;
      await Charger.updateOne(
        { _id: conn.charger._id },
        { $set: { vendor: cs.vendorName, model: cs.model, firmware: cs.firmwareVersion, serial: cs.serialNumber, bootedAt: new Date(), bootStatus: 'Accepted', lastSeen: new Date(), online: true } },
      );
      // Onboarding step 4: automatic test reads configuration + status, then marks "Ready for public".
      setTimeout(() => onboardingTest(conn).catch((e) => logger.warn(`onboarding test ${conn.ocppId}: ${e.message}`)), 500);
      return { currentTime: new Date().toISOString(), interval: config.charging.heartbeatIntervalSec, status: 'Accepted' };
    }
    case 'Heartbeat':
      await Charger.updateOne({ _id: conn.charger._id }, { $set: { lastSeen: new Date(), online: true } });
      return { currentTime: new Date().toISOString() };
    case 'StatusNotification': {
      const charger = await reload(conn);
      await Charger.updateOne({ _id: charger._id }, { $set: { lastSeen: new Date() } });
      if (p.evseId === 0) return {}; // whole-station status (1.6 connector 0)
      const c = charger.connectorByEvse(p.evseId, p.connectorId);
      if (!c) return {};
      const prev = c.status;
      const set = { 'connectors.$.status': p.connectorStatus, 'connectors.$.statusAt': new Date() };
      if (p.raw16) {
        set['connectors.$.rawStatus'] = p.raw16.status;
        set['connectors.$.errorCode'] = p.raw16.errorCode === 'NoError' ? undefined : p.raw16.errorCode;
      }
      await Charger.updateOne({ _id: charger._id, 'connectors.number': c.number }, { $set: set });
      c.status = p.connectorStatus;
      if (p.raw16) c.errorCode = p.raw16.errorCode;
      await onConnectorStatus(charger, c, p.connectorStatus, prev);
      events.emit('charger', { chargerId: charger._id, ocppId: charger.ocppId, tenant: charger.tenant, connector: c.number, status: p.connectorStatus });
      return {};
    }
    case 'Authorize': {
      const charger = await reload(conn);
      const status = await authorizeToken(charger, p.idToken?.idToken);
      return { idTokenInfo: { status } };
    }
    case 'TransactionEvent': {
      const charger = await reload(conn);
      await Charger.updateOne({ _id: charger._id }, { $set: { lastSeen: new Date() } });
      await onTransactionEvent(charger, p);
      const status = p.idToken?.idToken ? await authorizeToken(charger, p.idToken.idToken) : undefined;
      return status && p.eventType === 'Started' ? { idTokenInfo: { status: status === 'Invalid' ? 'Accepted' : status } } : {};
    }
    case 'MeterValues':
      await Charger.updateOne({ _id: conn.charger._id }, { $set: { lastSeen: new Date() } });
      return {};
    case 'FirmwareStatusNotification': {
      await Charger.updateOne({ _id: conn.charger._id }, { $set: { 'configCache.firmwareStatus': p.status, 'configCache.firmwareStatusAt': new Date() } });
      if (p.status === 'Installed') await FirmwareRollout.updateMany({ chargerIds: conn.charger._id, stage: { $nin: ['done', 'cancelled'] } }, { $addToSet: { done: conn.charger._id } });
      if (['InstallationFailed', 'DownloadFailed', 'InvalidSignature'].includes(p.status)) {
        await raiseAlert({ tenant: conn.charger.tenant, type: 'firmware_failed', charger: conn.charger._id, message: `Firmware update failed on ${conn.ocppId}: ${p.status}` });
      }
      return {};
    }
    case 'LogStatusNotification':
      await Charger.updateOne({ _id: conn.charger._id }, { $set: { 'configCache.logStatus': p.status, 'configCache.logStatusAt': new Date() } });
      return {};
    case 'SecurityEventNotification':
      await raiseAlert({ tenant: conn.charger.tenant, type: 'security', severity: 'warning', charger: conn.charger._id, message: `Security event on ${conn.ocppId}: ${p.type}` });
      return {};
    case 'NotifyEvent':
    case 'NotifyReport':
      return {};
    case 'ReservationStatusUpdate': {
      const { Reservation } = await import('../models/index.js');
      await Reservation.updateOne({ charger: conn.charger._id, reservationId: p.reservationId }, { $set: { status: p.reservationUpdateStatus === 'Expired' ? 'expired' : 'cancelled' } });
      return {};
    }
    case 'DataTransfer':
      return { status: 'UnknownVendorId' };
    default:
      return undefined;
  }
}

/** Read basic configuration + ask for fresh status; ready for public when both succeed. */
async function onboardingTest(conn) {
  const charger = await reload(conn);
  if (!charger) return;
  const vars = await sendCommand(charger, 'GetVariables', {
    getVariableData: [
      { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
      { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedInterval' } },
    ],
  }, { reason: 'onboarding test', timeoutMs: 15000 });
  const trig = await sendCommand(charger, 'TriggerMessage', { requestedMessage: 'StatusNotification' }, { reason: 'onboarding test', timeoutMs: 15000 });
  const ok = vars.status !== 'Offline' && vars.status !== 'TimedOut' && trig.status === 'Accepted';
  await Charger.updateOne(
    { _id: charger._id },
    { $set: { onboardingReport: { at: new Date(), getVariables: vars.status, trigger: trig.status, variables: vars.response?.getVariableResult }, ...(ok ? { readyForPublic: true } : {}) } },
  );
}

export async function markOnline(charger) {
  const now = new Date();
  await Charger.updateOne({ _id: charger._id }, { $set: { online: true, connectedAt: now, lastSeen: now, 'uptime.lastTransitionAt': now } });
  await resolveAlerts({ dedupeKey: `offline:${charger.ocppId}` });
  events.emit('charger', { chargerId: charger._id, ocppId: charger.ocppId, tenant: charger.tenant, online: true });
}

export async function markOffline(charger) {
  const c = await Charger.findById(charger._id);
  if (!c) return;
  const now = new Date();
  const since = c.uptime?.lastTransitionAt || c.connectedAt || now;
  const add = c.online ? Math.max(0, (now - since) / 1000) : 0;
  await Charger.updateOne({ _id: c._id }, { $set: { online: false, 'uptime.lastTransitionAt': now }, $inc: { 'uptime.onlineSeconds': add } });
  await raiseAlert({ tenant: c.tenant, type: 'charger_offline', severity: 'warning', charger: c._id, message: `${c.ocppId} went offline`, dedupeKey: `offline:${c.ocppId}` });
  events.emit('charger', { chargerId: c._id, ocppId: c.ocppId, tenant: c.tenant, online: false });
}
