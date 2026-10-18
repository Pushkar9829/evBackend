// In-process fleet of virtual chargers, controlled from the CMS "Simulator" page.
// They connect to this same server over a real WebSocket, so the full OCPP path is exercised
// (also on Render, where they dial 127.0.0.1:<PORT>).
import bcrypt from 'bcryptjs';
import { Charger } from '../models/index.js';
import { config } from '../config.js';
import { randomToken } from '../lib/util.js';
import { badRequest, notFound } from '../lib/errors.js';
import { VirtualCharger } from '../ocpp/simulator.js';

const sims = new Map();
let localPort = config.port;
let tls = null; // { port, ca } when the mutual-TLS listener runs
export const setSimulatorPort = (p) => {
  localPort = p;
};
export const setSimulatorTls = (port, ca) => {
  tls = port ? { port, ca } : null;
};

export const getSim = (ocppId) => sims.get(ocppId);
export const listSims = () => [...sims.values()].map((s) => s.state());

export async function startSim(chargerId, { meterIntervalSec = 5, speed = 60 } = {}) {
  const charger = await Charger.findById(chargerId);
  if (!charger) throw notFound('Charger not found.');
  const existing = sims.get(charger.ocppId);
  if (existing?.online) return existing;
  // A simulator needs the plain password, so it rotates the charger password (simulated chargers only).
  const password = randomToken(12);
  charger.passwordHash = await bcrypt.hash(password, 8);
  charger.isSimulated = true;
  await charger.save();
  const sim = existing || new VirtualCharger({
    url: `ws://127.0.0.1:${localPort}/ocpp`,
    ocppId: charger.ocppId,
    password,
    protocol: charger.protocol,
    vendor: charger.vendor || 'SimCo',
    model: charger.model || (charger.connectors.some((c) => c.powerType === 'DC') ? 'Sim-DC' : 'Sim-AC'),
    firmware: charger.firmware || '1.0.0',
    connectors: charger.connectors.map((c) => ({ number: c.number, maxPowerKw: c.maxPowerKw })),
    meterIntervalSec,
    speed,
    tlsUrl: tls ? `wss://localhost:${tls.port}/ocpp` : undefined,
    ca: tls?.ca,
  });
  sim.password = password;
  sim.protocol = charger.protocol;
  sim.autoReconnectMs = 3000;
  sims.set(charger.ocppId, sim);
  await sim.connect();
  return sim;
}

export async function stopSim(ocppId) {
  const sim = sims.get(ocppId);
  if (!sim) return;
  await sim.disconnect();
  sims.delete(ocppId);
}

export async function stopAllSims() {
  for (const id of [...sims.keys()]) await stopSim(id);
}

/** Physical actions and fault injection (UX doc Part 2 simulator requirements). */
export async function simAction(ocppId, action, args = {}) {
  const sim = sims.get(ocppId);
  if (!sim) throw notFound('Simulator is not running for this charger.');
  const n = Number(args.connector || 1);
  switch (action) {
    case 'plug': await sim.plugIn(n); break;
    case 'unplug': await sim.unplug(n); break;
    case 'emergency_stop': await sim.emergencyStop(n); break;
    case 'fault': await sim.setFault(n, true); break;
    case 'clear_fault': await sim.setFault(n, false); break;
    case 'ev_suspend': sim.conn(n).evSuspended = true; break;
    case 'ev_resume': sim.conn(n).evSuspended = false; break;
    case 'drop': await sim.dropConnection(Number(args.forMs || 10000)); break;
    case 'reconnect': await sim.connect(); break;
    case 'meter_now': await sim.tick(); break;
    case 'meter_reset': await sim.resetMeterRegister(n); break;
    case 'meter_backwards': sim.faults.wrongMeterNext = 'backwards'; break;
    case 'meter_jump': sim.faults.wrongMeterNext = 'jump'; break;
    case 'duplicate_next': sim.faults.duplicateNext = true; break;
    case 'reorder_next': sim.faults.reorderNext = true; break;
    case 'set_soc': sim.conn(n).soc = Number(args.soc ?? 30); break;
    case 'rfid': return { status: await sim.swipeRfid(n, String(args.uid)) };
    case 'pnc_plug': {
      // A car with an ISO 15118 contract plugs in: hash data comes from the certificate we issued.
      const { IssuedCertificate } = await import('./pki.js');
      const cert = await IssuedCertificate.findOne({ kind: 'ContractCertificate', emaid: String(args.emaid) }).lean();
      const hashData = cert ? { hashAlgorithm: 'SHA256', issuerNameHash: cert.issuerNameHash, issuerKeyHash: cert.issuerKeyHash, serialNumber: cert.serial } : undefined;
      return sim.plugInPnc(n, { emaid: String(args.emaid), hashData });
    }
    case 'request_certificate': await sim.requestCertificate(); break;
    case 'reconnect_tls':
      if (!sim.tlsUrl) throw badRequest('NO_TLS', 'Start the server with OCPP_TLS_PORT to use Security Profile 3.');
      sim.useTls = true;
      await sim.disconnect({ keepWanting: true });
      await sim.connect();
      break;
    case 'fault_flags':
      for (const k of ['rejectStart', 'neverStart', 'rejectStop', 'unlockFails', 'ignoreCalls']) if (k in args) sim.faults[k] = !!args[k];
      if ('delayMs' in args) sim.faults.delayMs = Number(args.delayMs) || 0;
      break;
    default:
      throw badRequest('UNKNOWN_ACTION', `Unknown simulator action ${action}`);
  }
  return sim.state();
}
