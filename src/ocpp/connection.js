// One live charger WebSocket: OCPP-J framing [2,id,action,payload] / [3,id,payload] / [4,id,code,desc,details].
import { randomId } from '../lib/util.js';
import { logger } from '../lib/logger.js';
import { OcppMessage } from '../models/index.js';
import { validate } from './schemas.js';
import { inbound16, outbound16, newAdapterState } from './adapter16.js';
import { countMessage } from './registry.js';

const CALL = 2;
const RESULT = 3;
const ERROR = 4;

export class OcppError extends Error {
  constructor(code, description, details = {}) {
    super(description);
    this.code = code;
    this.details = details;
  }
}

export class ChargerConnection {
  constructor(ws, { charger, protocol, onCall, onClose }) {
    this.ws = ws;
    this.charger = charger; // mongoose doc snapshot (id, tenant, ocppId)
    this.ocppId = charger.ocppId;
    this.protocol = protocol;
    this.onCall = onCall;
    this.pending = new Map();
    this.adapterState = newAdapterState();
    this.connectedAt = new Date();
    this.closed = false;
    ws.on('message', (data) => this.receive(data));
    ws.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new OcppError('Offline', 'Connection closed'));
      }
      this.pending.clear();
      onClose?.(this);
    });
    ws.on('error', (e) => logger.warn(`ocpp ws error ${this.ocppId}: ${e.message}`));
  }

  log(direction, messageType, action, uniqueId, payload) {
    countMessage(direction);
    OcppMessage.create({ ocppId: this.ocppId, charger: this.charger._id, tenant: this.charger.tenant, direction, messageType, action, uniqueId, payload }).catch(() => {});
  }

  rawSend(frame) {
    if (this.ws.readyState !== 1) throw new OcppError('Offline', 'Charger is not connected');
    this.ws.send(JSON.stringify(frame));
  }

  async receive(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return this.sendError('?', this.protocol === 'ocpp1.6' ? 'FormationViolation' : 'FormatViolation', 'Invalid JSON');
    }
    if (!Array.isArray(msg)) return undefined;
    const [type, id] = msg;
    if (type === CALL) {
      const [, , action, payload] = msg;
      this.log('in', CALL, action, id, payload);
      return this.handleCall(id, action, payload || {});
    }
    if (type === RESULT || type === ERROR) {
      const p = this.pending.get(id);
      this.log('in', type, p?.action, id, type === RESULT ? msg[2] : { code: msg[2], description: msg[3], details: msg[4] });
      if (!p) return undefined;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (type === RESULT) p.resolve(msg[2]);
      else p.reject(new OcppError(msg[2], msg[3], msg[4]));
    }
    return undefined;
  }

  async handleCall(id, action, payload) {
    const errs = validate(this.protocol, action, payload);
    if (errs === undefined && !['DataTransfer'].includes(action)) {
      // Unknown to the schema table: still let the adapter/brain decide, else NotImplemented.
    } else if (errs) {
      return this.sendError(id, this.protocol === 'ocpp1.6' ? 'FormationViolation' : 'FormatViolation', errs.join('; '));
    }
    try {
      let a = action;
      let p = payload;
      let respond = (r) => r;
      if (this.protocol === 'ocpp1.6') {
        const m = await inbound16(this, action, payload);
        if (!m) return this.sendError(id, 'NotImplemented', `${action} not supported`);
        ({ action: a, payload: p, respond } = m);
      }
      const result = await this.onCall(this, a, p);
      if (result === undefined) return this.sendError(id, 'NotImplemented', `${action} not supported`);
      const out = respond(result);
      this.log('out', RESULT, action, id, out);
      this.rawSend([RESULT, id, out]);
    } catch (e) {
      logger.error(`ocpp ${this.ocppId} ${action} handler failed`, e);
      this.sendError(id, e instanceof OcppError ? e.code : 'InternalError', e.message);
    }
    return undefined;
  }

  sendError(id, code, description, details = {}) {
    this.log('out', ERROR, undefined, id, { code, description });
    try {
      this.rawSend([ERROR, id, code, description, details]);
    } catch {
      /* closed */
    }
  }

  /** Send a 2.0.1 command; translated for 1.6J chargers. Resolves with a 2.0.1-shaped response. */
  call(action, payload, timeoutMs = 30000) {
    let a = action;
    let p = payload;
    let map = (r) => r;
    if (this.protocol === 'ocpp1.6') {
      const m = outbound16(this, action, payload);
      if (m.local) return Promise.resolve(m.local);
      ({ action: a, payload: p } = m);
      map = m.mapResponse;
    }
    const id = randomId(8);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OcppError('Timeout', `${a} timed out`));
      }, timeoutMs);
      this.pending.set(id, { action: a, timer, resolve: (r) => resolve(map(r || {})), reject });
      try {
        this.log('out', CALL, a, id, p);
        this.rawSend([CALL, id, a, p]);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close(code = 1000, reason = 'closing') {
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }
}
