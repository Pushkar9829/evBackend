// OCPP 1.6J adapter. Translates 1.6J messages from the client's chargers into 2.0.1 shapes so the
// charger brain only ever sees 2.0.1, and translates 2.0.1 commands back to 1.6J.
import { nextSeq } from '../models/index.js';

const STATUS_16_TO_201 = {
  Available: 'Available',
  Preparing: 'Occupied',
  Charging: 'Occupied',
  SuspendedEV: 'Occupied',
  SuspendedEVSE: 'Occupied',
  Finishing: 'Occupied',
  Reserved: 'Reserved',
  Unavailable: 'Unavailable',
  Faulted: 'Faulted',
};
const CHARGING_STATE = { Charging: 'Charging', SuspendedEV: 'SuspendedEV', SuspendedEVSE: 'SuspendedEVSE', Preparing: 'EVConnected', Finishing: 'EVConnected' };

const toWhSampled = (sv) => ({
  value: Number(sv.value),
  measurand: sv.measurand || 'Energy.Active.Import.Register',
  unitOfMeasure: sv.unit ? { unit: sv.unit } : undefined,
  context: sv.context,
  phase: sv.phase,
});

/**
 * Inbound: returns { action, payload, respond(result201) => result16 } in 2.0.1 terms.
 * `conn.adapterState` keeps per-connection memory (connector raw statuses, tx -> connector).
 */
export async function inbound16(conn, action, p) {
  const st = conn.adapterState;
  switch (action) {
    case 'BootNotification':
      return {
        action,
        payload: { reason: 'PowerUp', chargingStation: { vendorName: p.chargePointVendor, model: p.chargePointModel, firmwareVersion: p.firmwareVersion, serialNumber: p.chargePointSerialNumber } },
        respond: (r) => ({ status: r.status, currentTime: r.currentTime, interval: r.interval }),
      };
    case 'Heartbeat':
      return { action, payload: {}, respond: (r) => r };
    case 'StatusNotification': {
      st.raw[p.connectorId] = p.status;
      return {
        action,
        payload: { timestamp: p.timestamp || new Date().toISOString(), connectorStatus: STATUS_16_TO_201[p.status] || 'Unavailable', evseId: p.connectorId, connectorId: p.connectorId === 0 ? 0 : 1, raw16: { status: p.status, errorCode: p.errorCode } },
        respond: () => ({}),
      };
    }
    case 'Authorize':
      return { action, payload: { idToken: { idToken: p.idTag, type: 'ISO14443' } }, respond: (r) => ({ idTagInfo: { status: r.idTokenInfo?.status || 'Invalid' } }) };
    case 'StartTransaction': {
      // 1.6: the CSMS assigns the integer transaction id.
      const txId = await nextSeq('ocpp16:tx');
      st.tx[txId] = { connectorId: p.connectorId, idTag: p.idTag, seq: 0 };
      return {
        action: 'TransactionEvent',
        payload: {
          eventType: 'Started',
          timestamp: p.timestamp,
          triggerReason: 'Authorized',
          seqNo: 0,
          transactionInfo: { transactionId: String(txId), chargingState: 'Charging' },
          idToken: { idToken: p.idTag, type: 'ISO14443' },
          evse: { id: p.connectorId, connectorId: 1 },
          meterValue: [{ timestamp: p.timestamp, sampledValue: [{ value: p.meterStart, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' }, context: 'Transaction.Begin' }] }],
          reservationId: p.reservationId,
        },
        respond: (r) => ({ transactionId: txId, idTagInfo: { status: r.idTokenInfo?.status || 'Accepted' } }),
      };
    }
    case 'MeterValues': {
      if (!p.transactionId) return { action: 'MeterValues', payload: { evseId: p.connectorId, meterValue: p.meterValue.map((m) => ({ timestamp: m.timestamp, sampledValue: m.sampledValue.map(toWhSampled) })) }, respond: () => ({}) };
      const t = st.tx[p.transactionId] || (st.tx[p.transactionId] = { connectorId: p.connectorId, seq: 0 });
      const raw = st.raw[p.connectorId];
      return {
        action: 'TransactionEvent',
        payload: {
          eventType: 'Updated',
          timestamp: p.meterValue[0]?.timestamp || new Date().toISOString(),
          triggerReason: 'MeterValuePeriodic',
          seqNo: undefined, // 1.6 has no sequence numbers: dedupe by timestamp+value in the engine
          transactionInfo: { transactionId: String(p.transactionId), chargingState: CHARGING_STATE[raw] || 'Charging' },
          evse: { id: p.connectorId, connectorId: 1 },
          meterValue: p.meterValue.map((m) => ({ timestamp: m.timestamp, sampledValue: m.sampledValue.map(toWhSampled) })),
        },
        respond: () => ({}),
      };
    }
    case 'StopTransaction': {
      const t = st.tx[p.transactionId];
      delete st.tx[p.transactionId];
      return {
        action: 'TransactionEvent',
        payload: {
          eventType: 'Ended',
          timestamp: p.timestamp,
          triggerReason: p.reason === 'Remote' ? 'RemoteStop' : p.reason === 'EVDisconnected' ? 'EVCommunicationLost' : 'StopAuthorized',
          seqNo: undefined,
          transactionInfo: { transactionId: String(p.transactionId), stoppedReason: p.reason || 'Local', chargingState: 'Idle' },
          idToken: p.idTag ? { idToken: p.idTag } : undefined,
          evse: t ? { id: t.connectorId, connectorId: 1 } : undefined,
          meterValue: [{ timestamp: p.timestamp, sampledValue: [{ value: p.meterStop, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' }, context: 'Transaction.End' }] }],
        },
        respond: () => ({ idTagInfo: { status: 'Accepted' } }),
      };
    }
    case 'DiagnosticsStatusNotification':
      return { action: 'LogStatusNotification', payload: { status: p.status }, respond: () => ({}) };
    case 'FirmwareStatusNotification':
      return { action, payload: { status: p.status }, respond: () => ({}) };
    case 'DataTransfer':
      return { action, payload: p, respond: (r) => r };
    default:
      return null;
  }
}

/** Outbound: map a 2.0.1 command to 1.6J. Returns { action, payload, mapResponse } or { local } for emulated commands. */
export function outbound16(conn, action, p) {
  switch (action) {
    case 'RequestStartTransaction':
      return { action: 'RemoteStartTransaction', payload: { idTag: p.idToken.idToken, connectorId: p.evseId }, mapResponse: (r) => ({ status: r.status }) };
    case 'RequestStopTransaction':
      return { action: 'RemoteStopTransaction', payload: { transactionId: Number(p.transactionId) }, mapResponse: (r) => ({ status: r.status }) };
    case 'Reset':
      return { action: 'Reset', payload: { type: p.type === 'Immediate' ? 'Hard' : 'Soft' }, mapResponse: (r) => ({ status: r.status }) };
    case 'ChangeAvailability':
      return { action: 'ChangeAvailability', payload: { connectorId: p.evse?.id || 0, type: p.operationalStatus }, mapResponse: (r) => ({ status: r.status }) };
    case 'UnlockConnector':
      return { action: 'UnlockConnector', payload: { connectorId: p.evseId }, mapResponse: (r) => ({ status: r.status === 'NotSupported' ? 'UnlockFailed' : r.status }) };
    case 'GetVariables':
      return {
        action: 'GetConfiguration',
        payload: { key: p.getVariableData.map((d) => d.variable.name) },
        mapResponse: (r) => ({
          getVariableResult: [
            ...(r.configurationKey || []).map((k) => ({ attributeStatus: 'Accepted', component: { name: 'Config' }, variable: { name: k.key }, attributeValue: k.value, readonly: k.readonly })),
            ...(r.unknownKey || []).map((k) => ({ attributeStatus: 'UnknownVariable', component: { name: 'Config' }, variable: { name: k } })),
          ],
        }),
      };
    case 'SetVariables': {
      const d = p.setVariableData[0];
      return { action: 'ChangeConfiguration', payload: { key: d.variable.name, value: String(d.attributeValue) }, mapResponse: (r) => ({ setVariableResult: [{ attributeStatus: r.status === 'NotSupported' ? 'UnknownVariable' : r.status, component: d.component, variable: d.variable }] }) };
    }
    case 'TriggerMessage':
      return {
        action: 'TriggerMessage',
        payload: { requestedMessage: p.requestedMessage === 'TransactionEvent' ? 'MeterValues' : p.requestedMessage, connectorId: p.evse?.id },
        mapResponse: (r) => ({ status: r.status }),
      };
    case 'UpdateFirmware':
      return { action: 'UpdateFirmware', payload: { location: p.firmware.location, retrieveDate: p.firmware.retrieveDateTime }, mapResponse: () => ({ status: 'Accepted' }) };
    case 'GetLog':
      return { action: 'GetDiagnostics', payload: { location: p.log.remoteLocation }, mapResponse: (r) => ({ status: 'Accepted', filename: r.fileName }) };
    case 'SendLocalList':
      return {
        action: 'SendLocalList',
        payload: { listVersion: p.versionNumber, updateType: p.updateType, localAuthorizationList: (p.localAuthorizationList || []).map((e) => ({ idTag: e.idToken.idToken, idTagInfo: e.idTokenInfo ? { status: e.idTokenInfo.status } : undefined })) },
        mapResponse: (r) => ({ status: r.status }),
      };
    case 'SetChargingProfile':
      return {
        action: 'SetChargingProfile',
        payload: {
          connectorId: p.evseId,
          csChargingProfiles: {
            chargingProfileId: p.chargingProfile.id,
            stackLevel: p.chargingProfile.stackLevel,
            chargingProfilePurpose: p.chargingProfile.chargingProfilePurpose === 'ChargingStationMaxProfile' ? 'ChargePointMaxProfile' : p.chargingProfile.chargingProfilePurpose,
            chargingProfileKind: p.chargingProfile.chargingProfileKind,
            chargingSchedule: p.chargingProfile.chargingSchedule?.[0] || p.chargingProfile.chargingSchedule,
          },
        },
        mapResponse: (r) => ({ status: r.status }),
      };
    case 'ReserveNow':
      return { action: 'ReserveNow', payload: { connectorId: p.evseId, expiryDate: p.expiryDateTime, idTag: p.idToken.idToken, reservationId: p.id }, mapResponse: (r) => ({ status: r.status }) };
    case 'CancelReservation':
      return { action: 'CancelReservation', payload: { reservationId: p.reservationId }, mapResponse: (r) => ({ status: r.status }) };
    case 'GetTransactionStatus': {
      // No 1.6 equivalent: answer from what the adapter knows about live transactions.
      const ongoing = Object.keys(conn.adapterState.tx).some((id) => !p.transactionId || id === String(p.transactionId));
      return { local: { ongoingIndicator: ongoing, messagesInQueue: false } };
    }
    case 'DataTransfer':
      return { action, payload: p, mapResponse: (r) => r };
    default:
      return { action, payload: p, mapResponse: (r) => r };
  }
}

export const newAdapterState = () => ({ raw: {}, tx: {} });
