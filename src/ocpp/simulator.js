// Virtual charger for development and QA (Requirements 3 "Testing", UX doc Part 2).
// Speaks OCPP 2.0.1 or 1.6J over a real WebSocket and can inject faults: drop the connection,
// delay / duplicate / reorder messages, wrong meter values, register reset, reject start/stop, etc.
import WebSocket from 'ws';
import { randomId } from '../lib/util.js';

const now = () => new Date(Date.now() + (VirtualCharger.clockOffsetMs || 0)).toISOString();

export class VirtualCharger {
  constructor({ url, ocppId, password, protocol = 'ocpp2.0.1', connectors = [{ number: 1, maxPowerKw: 7.4 }], vendor = 'SimCo', model = 'Sim-AC', firmware = '1.0.0', meterIntervalSec = 5, speed = 60, connectionTimeoutSec = 120 }) {
    Object.assign(this, { url, ocppId, password, protocol, vendor, model, firmware, meterIntervalSec, speed, connectionTimeoutSec });
    this.connectors = connectors.map((c) => ({
      number: c.number, maxPowerKw: c.maxPowerKw || 7.4, status: 'Available', plugged: false, tx: null, meterWh: c.meterWh ?? 1_000_000, evSuspended: false, locked: false,
    }));
    this.ws = null;
    this.pending = new Map();
    this.queue = []; // messages buffered while offline
    this.log = [];
    this.faults = { rejectStart: false, neverStart: false, rejectStop: false, delayMs: 0, duplicateNext: false, reorderNext: false, wrongMeterNext: null, unlockFails: false, ignoreCalls: false };
    this.online = false;
    this.wantOnline = false;
    this.seq = {};
    this.txCounter = 0;
    this.pendingStarts = {}; // connector -> {idToken, remoteStartId, at}
    this.timer = null;
    this.reservations = {};
    this.configuration = { HeartbeatInterval: '300', TxUpdatedInterval: String(meterIntervalSec), MeterValueSampleInterval: String(meterIntervalSec), AuthorizeRemoteStart: 'false' };
    this.firmwareStatus = null;
    this.listeners = new Set();
  }

  get is16() {
    return this.protocol === 'ocpp1.6';
  }

  record(dir, frame) {
    this.log.push({ at: new Date().toISOString(), dir, frame });
    if (this.log.length > 200) this.log.shift();
    for (const l of this.listeners) l({ dir, frame });
  }

  connect() {
    this.wantOnline = true;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.url}/${encodeURIComponent(this.ocppId)}`, [this.protocol], {
        headers: { Authorization: `Basic ${Buffer.from(`${this.ocppId}:${this.password}`).toString('base64')}` },
      });
      this.ws = ws;
      let opened = false;
      ws.on('open', async () => {
        opened = true;
        this.online = true;
        try {
          await this.boot();
          await this.flushQueue();
          this.startLoop();
          resolve(this);
        } catch (e) {
          reject(e);
        }
      });
      ws.on('message', (d) => this.onMessage(d));
      ws.on('unexpected-response', (_req, res) => {
        reject(new Error(`Connection rejected: HTTP ${res.statusCode}`));
      });
      ws.on('close', () => {
        this.online = false;
        this.stopLoop();
        for (const p of this.pending.values()) p.reject(new Error('closed'));
        this.pending.clear();
        if (!opened) return;
        if (this.wantOnline && this.autoReconnectMs) setTimeout(() => this.wantOnline && this.connect().catch(() => {}), this.autoReconnectMs);
      });
      ws.on('error', (e) => {
        if (!opened) reject(e);
      });
    });
  }

  async disconnect({ keepWanting = false } = {}) {
    this.wantOnline = keepWanting;
    this.stopLoop();
    if (this.ws) {
      const ws = this.ws;
      await new Promise((r) => {
        if (ws.readyState === WebSocket.CLOSED) return r();
        ws.once('close', r);
        ws.close();
        return undefined;
      });
    }
    this.online = false;
  }

  /** Simulate losing internet: messages queue up and are delivered after reconnect (CHG-05). */
  async dropConnection(forMs = 0) {
    await this.disconnect();
    if (forMs > 0) setTimeout(() => this.connect().catch(() => {}), forMs);
  }

  async flushQueue() {
    const q = this.queue;
    this.queue = [];
    for (const m of q) await this.call(m.action, m.payload, { queued: true }).catch(() => {});
  }

  send(frame) {
    const write = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.record('out', frame);
        this.ws.send(JSON.stringify(frame));
      }
    };
    if (this.faults.delayMs) setTimeout(write, this.faults.delayMs);
    else write();
  }

  call(action, payload, { queued = false, noQueue = false } = {}) {
    if (!this.online) {
      if (!noQueue && ['TransactionEvent', 'StartTransaction', 'StopTransaction', 'MeterValues', 'StatusNotification'].includes(action)) this.queue.push({ action, payload });
      return Promise.resolve(null);
    }
    const id = randomId(6);
    const frame = [2, id, action, payload];
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, action });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve(null);
        }
      }, 20000);
    });
    if (this.faults.reorderNext && !queued && action !== 'BootNotification') {
      // hold this one back and send it after the next message (CHG-08)
      this.faults.reorderNext = false;
      this.heldFrame = frame;
      setTimeout(() => {
        if (this.heldFrame === frame) {
          this.heldFrame = null;
          this.send(frame);
        }
      }, 400);
      return p;
    }
    this.send(frame);
    if (this.heldFrame && this.heldFrame !== frame) {
      const h = this.heldFrame;
      this.heldFrame = null;
      setTimeout(() => this.send(h), 50);
    }
    if (this.faults.duplicateNext && action !== 'BootNotification') {
      this.faults.duplicateNext = false;
      setTimeout(() => this.send([2, randomId(6), action, payload]), 30); // CHG-07: same payload, new message id
    }
    return p;
  }

  async onMessage(data) {
    const msg = JSON.parse(String(data));
    this.record('in', msg);
    const [type, id] = msg;
    if (type === 3 || type === 4) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.resolve(type === 3 ? msg[2] : { error: msg[2], description: msg[3] });
      return;
    }
    if (type !== 2) return;
    const [, , action, payload] = msg;
    if (this.faults.ignoreCalls) return;
    const result = await this.handle(action, payload || {});
    this.send([3, id, result]);
  }

  async boot() {
    const res = this.is16
      ? await this.call('BootNotification', { chargePointVendor: this.vendor, chargePointModel: this.model, firmwareVersion: this.firmware, chargePointSerialNumber: `SN-${this.ocppId}` })
      : await this.call('BootNotification', { reason: 'PowerUp', chargingStation: { vendorName: this.vendor, model: this.model, firmwareVersion: this.firmware, serialNumber: `SN-${this.ocppId}` } });
    for (const c of this.connectors) await this.sendStatus(c);
    return res;
  }

  conn(n) {
    return this.connectors.find((c) => c.number === Number(n)) || this.connectors[0];
  }

  statusOf(c) {
    if (c.faulted) return 'Faulted';
    if (c.unavailable) return 'Unavailable';
    if (c.reserved) return 'Reserved';
    if (this.is16) {
      if (c.tx) return c.evSuspended ? 'SuspendedEV' : 'Charging';
      if (c.plugged) return c.finishing ? 'Finishing' : 'Preparing';
      return 'Available';
    }
    return c.plugged || c.tx ? 'Occupied' : 'Available';
  }

  sendStatus(c) {
    const status = this.statusOf(c);
    c.status = status;
    return this.is16
      ? this.call('StatusNotification', { connectorId: c.number, errorCode: c.faulted ? 'GroundFailure' : 'NoError', status, timestamp: now() })
      : this.call('StatusNotification', { timestamp: now(), connectorStatus: status, evseId: c.number, connectorId: 1 });
  }

  meterSample(c, { context } = {}) {
    let wh = c.meterWh;
    if (this.faults.wrongMeterNext === 'backwards') wh = c.meterWh - 5000;
    if (this.faults.wrongMeterNext === 'jump') wh = c.meterWh + 900_000;
    if (this.faults.wrongMeterNext) this.faults.wrongMeterNext = null;
    const powerW = c.tx && !c.evSuspended ? c.maxPowerKw * 1000 : 0;
    if (this.is16) {
      return [{ timestamp: now(), sampledValue: [
        { value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context: context || 'Sample.Periodic' },
        { value: String(powerW), measurand: 'Power.Active.Import', unit: 'W' },
        ...(c.soc !== undefined ? [{ value: String(Math.round(c.soc)), measurand: 'SoC', unit: 'Percent' }] : []),
      ] }];
    }
    return [{ timestamp: now(), sampledValue: [
      { value: wh, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' }, context: context || 'Sample.Periodic' },
      { value: powerW, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
      ...(c.soc !== undefined ? [{ value: Math.round(c.soc), measurand: 'SoC', unitOfMeasure: { unit: 'Percent' } }] : []),
    ] }];
  }

  nextSeq(c) {
    this.seq[c.tx.id] = (this.seq[c.tx.id] ?? -1) + 1;
    return this.seq[c.tx.id];
  }

  async startTx(c, { idToken, remoteStartId }) {
    if (c.tx) return;
    if (this.is16) {
      let ready;
      c.tx = { id: null, idToken, startedAt: Date.now(), ready: new Promise((r) => { ready = r; }) };
      const r = await this.call('StartTransaction', { connectorId: c.number, idTag: idToken, meterStart: c.meterWh, timestamp: now() });
      c.tx.id = r?.transactionId ?? `pending-${Date.now()}`;
      ready();
    } else {
      this.txCounter += 1;
      c.tx = { id: `${this.ocppId}-${Date.now()}-${this.txCounter}`, idToken, remoteStartId, startedAt: Date.now() };
      await this.call('TransactionEvent', {
        eventType: 'Started', timestamp: now(), triggerReason: remoteStartId ? 'RemoteStart' : 'Authorized', seqNo: this.nextSeq(c),
        transactionInfo: { transactionId: c.tx.id, chargingState: 'Charging', remoteStartId },
        idToken: { idToken, type: 'Central' }, evse: { id: c.number, connectorId: 1 }, meterValue: this.meterSample(c, { context: 'Transaction.Begin' }),
      });
    }
    await this.sendStatus(c);
  }

  async endTx(c, reason = 'Local') {
    if (!c.tx) return;
    const tx = c.tx;
    c.tx = null;
    if (this.is16) {
      await this.call('StopTransaction', { transactionId: Number(tx.id), meterStop: c.meterWh, timestamp: now(), reason, idTag: tx.idToken });
    } else {
      this.seq[tx.id] = (this.seq[tx.id] ?? -1) + 1;
      await this.call('TransactionEvent', {
        eventType: 'Ended', timestamp: now(), triggerReason: reason === 'Remote' ? 'RemoteStop' : reason === 'EVDisconnected' ? 'EVCommunicationLost' : 'StopAuthorized', seqNo: this.seq[tx.id],
        transactionInfo: { transactionId: tx.id, stoppedReason: reason, chargingState: c.plugged ? 'EVConnected' : 'Idle' }, evse: { id: c.number, connectorId: 1 },
        meterValue: this.meterSample(c, { context: 'Transaction.End' }),
      });
    }
    c.finishing = c.plugged;
    await this.sendStatus(c);
  }

  startLoop() {
    this.stopLoop();
    this.timer = setInterval(() => this.tick().catch(() => {}), this.meterIntervalSec * 1000);
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Advance energy on charging connectors and report meter values. */
  async tick() {
    for (const c of this.connectors) {
      if (!c.tx) continue;
      if (!c.evSuspended) {
        const hours = (this.meterIntervalSec * this.speed) / 3600; // speed: 60 => one interval = one minute of charging
        c.meterWh += Math.round(c.maxPowerKw * 1000 * hours);
        if (c.soc !== undefined) c.soc = Math.min(100, c.soc + (c.maxPowerKw * hours * 100) / (c.batteryKwh || 40));
      }
      await this.sendMeter(c);
    }
  }

  async sendMeter(c) {
    if (!c.tx) return;
    if (c.tx.id === null) await c.tx.ready; // 1.6J: wait for the CSMS-assigned transaction id
    if (!c.tx) return;
    if (this.is16) {
      await this.call('MeterValues', { connectorId: c.number, transactionId: Number(c.tx.id), meterValue: this.meterSample(c) });
    } else {
      await this.call('TransactionEvent', {
        eventType: 'Updated', timestamp: now(), triggerReason: 'MeterValuePeriodic', seqNo: this.nextSeq(c),
        transactionInfo: { transactionId: c.tx.id, chargingState: c.evSuspended ? 'SuspendedEV' : 'Charging' }, evse: { id: c.number, connectorId: 1 }, meterValue: this.meterSample(c),
      });
    }
  }

  // ------------------------------------------------------------- driver/physical actions

  async plugIn(n = 1) {
    const c = this.conn(n);
    c.plugged = true;
    c.finishing = false;
    await this.sendStatus(c);
    const pend = this.pendingStarts[c.number];
    // EV connection timeout: a remote start waiting for a cable expires like on a real charger
    if (pend && Date.now() - pend.at > this.connectionTimeoutSec * 1000) delete this.pendingStarts[c.number];
    else if (pend && !this.faults.neverStart) {
      delete this.pendingStarts[c.number];
      await this.startTx(c, pend);
    }
  }

  async unplug(n = 1) {
    const c = this.conn(n);
    c.plugged = false;
    c.finishing = false;
    if (c.tx) await this.endTx(c, 'EVDisconnected');
    else await this.sendStatus(c);
  }

  async emergencyStop(n = 1) {
    const c = this.conn(n);
    if (c.tx) await this.endTx(c, 'EmergencyStop');
  }

  async setFault(n = 1, on = true) {
    const c = this.conn(n);
    c.faulted = on;
    if (on && c.tx) await this.endTx(c, 'Other');
    await this.sendStatus(c);
  }

  async resetMeterRegister(n = 1) {
    // charger reboot that resets the energy register (CHG-04)
    const c = this.conn(n);
    c.meterWh = 0;
    await this.sendMeter(c);
  }

  async swipeRfid(n, uid) {
    const auth = this.is16 ? await this.call('Authorize', { idTag: uid }) : await this.call('Authorize', { idToken: { idToken: uid, type: 'ISO14443' } });
    const status = this.is16 ? auth?.idTagInfo?.status : auth?.idTokenInfo?.status;
    if (status === 'Accepted') await this.startTx(this.conn(n), { idToken: uid });
    return status;
  }

  // ------------------------------------------------------------- CSMS commands

  async handle(action, p) {
    const map16 = { RemoteStartTransaction: 'RequestStartTransaction', RemoteStopTransaction: 'RequestStopTransaction', GetConfiguration: 'GetVariables', ChangeConfiguration: 'SetVariables', GetDiagnostics: 'GetLog' };
    const a = this.is16 ? map16[action] || action : action;
    switch (a) {
      case 'RequestStartTransaction': {
        if (this.faults.rejectStart) return { status: 'Rejected' };
        const n = this.is16 ? p.connectorId : p.evseId;
        const c = this.conn(n);
        if (c.faulted || c.unavailable || c.tx) return { status: 'Rejected' };
        const idToken = this.is16 ? p.idTag : p.idToken.idToken;
        if (c.plugged && !this.faults.neverStart) setTimeout(() => this.startTx(c, { idToken, remoteStartId: p.remoteStartId }).catch(() => {}), 200);
        else if (!this.faults.neverStart) this.pendingStarts[c.number] = { idToken, remoteStartId: p.remoteStartId, at: Date.now() };
        return { status: 'Accepted' };
      }
      case 'RequestStopTransaction': {
        if (this.faults.rejectStop) return { status: 'Rejected' };
        const c = this.connectors.find((x) => x.tx && String(x.tx.id) === String(p.transactionId));
        if (!c) return { status: 'Rejected' };
        setTimeout(() => this.endTx(c, 'Remote').catch(() => {}), this.faults.slowStopMs || 200);
        return { status: 'Accepted' };
      }
      case 'GetTransactionStatus': {
        const ongoing = this.connectors.some((c) => c.tx && (!p.transactionId || c.tx.id === p.transactionId));
        return { ongoingIndicator: ongoing, messagesInQueue: this.queue.length > 0 };
      }
      case 'Reset':
        setTimeout(async () => {
          await this.disconnect({ keepWanting: true });
          setTimeout(() => this.connect().catch(() => {}), 500);
        }, 200);
        return { status: 'Accepted' };
      case 'ChangeAvailability': {
        const n = this.is16 ? p.connectorId : p.evse?.id;
        const inop = (this.is16 ? p.type : p.operationalStatus) === 'Inoperative';
        const targets = n ? [this.conn(n)] : this.connectors;
        for (const c of targets) {
          c.unavailable = inop;
          setTimeout(() => this.sendStatus(c).catch(() => {}), 100);
        }
        return { status: 'Accepted' };
      }
      case 'UnlockConnector':
        if (this.faults.unlockFails) return { status: this.is16 ? 'UnlockFailed' : 'UnlockFailed' };
        return { status: 'Unlocked' };
      case 'GetVariables':
        if (this.is16) {
          const keys = p.key?.length ? p.key : Object.keys(this.configuration);
          return { configurationKey: keys.filter((k) => k in this.configuration).map((k) => ({ key: k, readonly: false, value: this.configuration[k] })), unknownKey: keys.filter((k) => !(k in this.configuration)) };
        }
        return { getVariableResult: p.getVariableData.map((d) => ({ attributeStatus: 'Accepted', component: d.component, variable: d.variable, attributeValue: this.configuration[d.variable.name] ?? '0' })) };
      case 'SetVariables':
        if (this.is16) {
          this.configuration[p.key] = p.value;
          return { status: 'Accepted' };
        }
        return { setVariableResult: p.setVariableData.map((d) => { this.configuration[d.variable.name] = String(d.attributeValue); return { attributeStatus: 'Accepted', component: d.component, variable: d.variable }; }) };
      case 'TriggerMessage': {
        const msg = p.requestedMessage;
        setTimeout(async () => {
          if (msg === 'StatusNotification') for (const c of this.connectors) await this.sendStatus(c);
          if (msg === 'Heartbeat') await this.call('Heartbeat', {});
          if (msg === 'BootNotification') await this.boot();
          if (msg === 'MeterValues' || msg === 'TransactionEvent') for (const c of this.connectors) await this.sendMeter(c);
        }, 100);
        return { status: 'Accepted' };
      }
      case 'UpdateFirmware':
        setTimeout(async () => {
          for (const s of ['Downloading', 'Downloaded', 'Installing', 'Installed']) {
            this.firmwareStatus = s;
            await this.call('FirmwareStatusNotification', this.is16 ? { status: s } : { status: s, requestId: p.requestId });
          }
          this.firmware = String(p.firmware?.location || p.location || '').split('/').pop() || this.firmware;
        }, 200);
        return this.is16 ? {} : { status: 'Accepted' };
      case 'GetLog':
        setTimeout(() => this.call(this.is16 ? 'DiagnosticsStatusNotification' : 'LogStatusNotification', this.is16 ? { status: 'Uploaded' } : { status: 'Uploaded', requestId: p.requestId }).catch(() => {}), 200);
        return this.is16 ? { fileName: `${this.ocppId}-diag.log` } : { status: 'Accepted', filename: `${this.ocppId}-diag.log` };
      case 'SendLocalList':
        this.localList = p;
        return { status: 'Accepted' };
      case 'SetChargingProfile':
        this.chargingProfile = p;
        return { status: 'Accepted' };
      case 'ClearChargingProfile':
        this.chargingProfile = null;
        return { status: 'Accepted' };
      case 'ReserveNow': {
        const c = this.conn(this.is16 ? p.connectorId : p.evseId);
        if (c.tx || c.faulted) return { status: 'Occupied' };
        c.reserved = true;
        this.reservations[this.is16 ? p.reservationId : p.id] = c.number;
        setTimeout(() => this.sendStatus(c).catch(() => {}), 100);
        return { status: 'Accepted' };
      }
      case 'CancelReservation': {
        const n = this.reservations[p.reservationId];
        if (!n) return { status: 'Rejected' };
        const c = this.conn(n);
        c.reserved = false;
        delete this.reservations[p.reservationId];
        setTimeout(() => this.sendStatus(c).catch(() => {}), 100);
        return { status: 'Accepted' };
      }
      case 'DataTransfer':
        return { status: 'Accepted' };
      default:
        return this.is16 ? {} : { status: 'Rejected' };
    }
  }

  state() {
    return {
      ocppId: this.ocppId,
      protocol: this.protocol,
      online: this.online,
      queued: this.queue.length,
      faults: this.faults,
      firmware: this.firmware,
      connectors: this.connectors.map((c) => ({ number: c.number, status: c.status, plugged: c.plugged, meterWh: c.meterWh, tx: c.tx ? { id: c.tx.id, startedAt: c.tx.startedAt } : null, evSuspended: c.evSuspended, faulted: !!c.faulted, maxPowerKw: c.maxPowerKw, pendingStart: !!this.pendingStarts[c.number] })),
      log: this.log.slice(-40),
    };
  }
}

VirtualCharger.clockOffsetMs = 0;
