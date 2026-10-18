// Message checker. A compact, versioned schema table for the messages we act on.
// Full OCA JSON schemas can be dropped in per version later; the shape of this table mirrors them.
// Syntax: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'datetime', prefix '?' = optional,
// nested objects as plain objects, arrays of objects as [ {...} ].

const idToken = { idToken: 'string', type: '?string' };
const sampled = [{ value: 'number', measurand: '?string', unitOfMeasure: '?object', context: '?string', phase: '?string' }];
const meterValue = [{ timestamp: 'datetime', sampledValue: sampled }];

const v201 = {
  BootNotification: { reason: 'string', chargingStation: { model: 'string', vendorName: 'string', firmwareVersion: '?string', serialNumber: '?string' } },
  Heartbeat: {},
  StatusNotification: { timestamp: 'datetime', connectorStatus: 'string', evseId: 'integer', connectorId: 'integer' },
  Authorize: { idToken },
  TransactionEvent: {
    eventType: 'string',
    timestamp: 'datetime',
    triggerReason: 'string',
    seqNo: 'integer',
    offline: '?boolean',
    transactionInfo: { transactionId: 'string', chargingState: '?string', stoppedReason: '?string', remoteStartId: '?integer' },
    idToken: '?object',
    evse: '?object',
    meterValue: '?array',
  },
  MeterValues: { evseId: 'integer', meterValue },
  FirmwareStatusNotification: { status: 'string', requestId: '?integer' },
  LogStatusNotification: { status: 'string', requestId: '?integer' },
  SecurityEventNotification: { type: 'string', timestamp: 'datetime' },
  NotifyEvent: { generatedAt: 'datetime', seqNo: 'integer', eventData: 'array' },
  NotifyReport: { requestId: 'integer', generatedAt: 'datetime', seqNo: 'integer' },
  DataTransfer: { vendorId: 'string' },
  ReservationStatusUpdate: { reservationId: 'integer', reservationUpdateStatus: 'string' },
};

const v16 = {
  BootNotification: { chargePointVendor: 'string', chargePointModel: 'string', firmwareVersion: '?string', chargePointSerialNumber: '?string' },
  Heartbeat: {},
  StatusNotification: { connectorId: 'integer', errorCode: 'string', status: 'string', timestamp: '?datetime' },
  Authorize: { idTag: 'string' },
  StartTransaction: { connectorId: 'integer', idTag: 'string', meterStart: 'integer', timestamp: 'datetime', reservationId: '?integer' },
  StopTransaction: { transactionId: 'integer', meterStop: 'integer', timestamp: 'datetime', reason: '?string', idTag: '?string' },
  MeterValues: { connectorId: 'integer', transactionId: '?integer', meterValue: [{ timestamp: 'datetime', sampledValue: [{ value: 'string', measurand: '?string', unit: '?string', context: '?string' }] }] },
  DiagnosticsStatusNotification: { status: 'string' },
  FirmwareStatusNotification: { status: 'string' },
  DataTransfer: { vendorId: 'string' },
};

export const SCHEMAS = { 'ocpp2.0.1': v201, 'ocpp1.6': v16 };

const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function check(spec, value, path, errors) {
  if (typeof spec === 'string') {
    const optional = spec.startsWith('?');
    const t = optional ? spec.slice(1) : spec;
    if (value === undefined || value === null) {
      if (!optional) errors.push(`${path} is required`);
      return;
    }
    const ok = {
      string: typeof value === 'string',
      number: typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))),
      integer: Number.isInteger(value),
      boolean: typeof value === 'boolean',
      object: typeof value === 'object' && !Array.isArray(value),
      array: Array.isArray(value),
      datetime: isDate(value),
    }[t];
    if (!ok) errors.push(`${path} must be ${t}`);
    return;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be array`);
      return;
    }
    value.forEach((item, i) => check(spec[0], item, `${path}[${i}]`, errors));
    return;
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    errors.push(`${path} must be object`);
    return;
  }
  for (const [k, s] of Object.entries(spec)) check(s, value[k], path ? `${path}.${k}` : k, errors);
}

/** Returns null when valid, or a list of problems. Unknown actions return undefined (NotImplemented). */
export function validate(protocol, action, payload) {
  const spec = SCHEMAS[protocol]?.[action];
  if (!spec) return undefined;
  const errors = [];
  check(spec, payload ?? {}, '', errors);
  return errors.length ? errors : null;
}
