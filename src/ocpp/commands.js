// Command centre: every command is logged with its live result (Accepted / Rejected / Timed out / Offline).
import { Charger, CommandLog } from '../models/index.js';
import { registry } from './registry.js';
import { OcppError } from './connection.js';
import { cluster } from './cluster.js';

const STATUS_OK = new Set(['Accepted', 'Unlocked', 'Scheduled', 'AcceptedCanceled', 'RebootRequired']);

/**
 * Send a 2.0.1 command to a charger. Returns { status, response } and never throws for charger-side
 * outcomes, so callers can branch on Accepted / Rejected / TimedOut / Offline.
 */
export async function sendCommand(chargerOrOcppId, action, payload = {}, { by, reason, timeoutMs, bulkId, stage, log = true } = {}) {
  const charger = typeof chargerOrOcppId === 'string' ? await Charger.findOne({ ocppId: chargerOrOcppId }).lean() : chargerOrOcppId;
  const ocppId = charger?.ocppId || chargerOrOcppId;
  const entry = log ? await CommandLog.create({ tenant: charger?.tenant, charger: charger?._id, ocppId, action, payload, requestedBy: by, reason, bulkId, stage }) : null;
  const conn = registry.get(ocppId);
  let status;
  let response;
  const viaCluster = (!conn || conn.closed) && cluster().enabled && registry.isConnected(ocppId);
  if ((!conn || conn.closed) && !viaCluster) {
    status = 'Offline';
  } else {
    try {
      response = viaCluster ? await cluster().call(ocppId, action, payload, timeoutMs) : await conn.call(action, payload, timeoutMs);
      const s = response?.status || response?.getVariableResult?.[0]?.attributeStatus || response?.setVariableResult?.[0]?.attributeStatus;
      status = s === undefined ? 'Accepted' : STATUS_OK.has(s) ? 'Accepted' : 'Rejected';
      if (action === 'GetTransactionStatus') status = 'Accepted';
    } catch (e) {
      status = e.code === 'Timeout' ? 'TimedOut' : e.code === 'Offline' ? 'Offline' : 'Error';
      response = { error: e.message, code: e.code };
    }
  }
  if (entry) await CommandLog.updateOne({ _id: entry._id }, { $set: { status, response } });
  return { status, response, commandId: entry?._id };
}

export const isOnline = (ocppId) => registry.isConnected(ocppId);
