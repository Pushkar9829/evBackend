// Map our chargers/sessions to OCPI 2.2.1 objects. One OCPI endpoint represents several parties:
// each tenant is a CPO with its own party id (e.g. IN*ABC).
import { config } from '../../config.js';

export const ocpiTime = (d) => new Date(d || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const partyOf = (tenant) => (tenant?.ocpiPartyId || (tenant?.slug || 'CPO').replace(/[^a-z]/gi, '').slice(0, 3)).toUpperCase().padEnd(3, 'X');

const STANDARD = {
  CCS2: 'IEC_62196_T2_COMBO', Type2: 'IEC_62196_T2', CHAdeMO: 'CHADEMO', GBT: 'GBT_DC', Type1: 'IEC_62196_T1',
  // [Confirm] Indian 2W/3W standards have no exact OCPI code yet
  Bharat_AC001: 'IEC_60309_2_single_16', Bharat_DC001: 'GBT_DC', LEV_DC: 'GBT_DC', Type6: 'IEC_62196_T2', '3PIN': 'DOMESTIC_D',
};

export function evseStatus(charger, connector) {
  if (charger.deletedAt || !charger.roamingEnabled) return 'REMOVED';
  if (!charger.online) return 'UNKNOWN';
  if (!charger.inService) return 'INOPERATIVE';
  return { Available: 'AVAILABLE', Occupied: 'CHARGING', Reserved: 'RESERVED', Unavailable: 'INOPERATIVE', Faulted: 'OUTOFORDER' }[connector.status] || 'UNKNOWN';
}

export const evseUid = (charger, evseId) => `${charger.ocppId}*${evseId}`;
export const parseEvseUid = (uid) => {
  const i = String(uid).lastIndexOf('*');
  return { ocppId: uid.slice(0, i), evseId: Number(uid.slice(i + 1)) };
};

export function tariffId(tenant, tariff) {
  return `${partyOf(tenant)}-${tariff?.key || 'default'}`;
}

export function toLocation(site, chargers, tenant, tariff) {
  const party = partyOf(tenant);
  const evses = [];
  for (const ch of chargers) {
    const byEvse = new Map();
    for (const c of ch.connectors) {
      if (!byEvse.has(c.evseId)) byEvse.set(c.evseId, []);
      byEvse.get(c.evseId).push(c);
    }
    for (const [evseId, conns] of byEvse) {
      evses.push({
        uid: evseUid(ch, evseId),
        evse_id: `${config.ocpi.countryCode}*${party}*E${ch.ocppId.replace(/[^A-Za-z0-9]/g, '')}*${evseId}`,
        status: conns.map((c) => evseStatus(ch, c)).sort((a, b) => (a === 'AVAILABLE' ? -1 : b === 'AVAILABLE' ? 1 : 0))[0],
        capabilities: ['REMOTE_START_STOP_CAPABLE', 'UNLOCK_CAPABLE', 'RESERVABLE'],
        connectors: conns.map((c) => ({
          id: String(c.number),
          standard: STANDARD[c.type] || 'IEC_62196_T2',
          format: c.powerType === 'DC' ? 'CABLE' : 'SOCKET',
          power_type: c.powerType === 'DC' ? 'DC' : 'AC_3_PHASE',
          max_voltage: c.powerType === 'DC' ? 500 : 415,
          max_amperage: Math.round((c.maxPowerKw * 1000) / (c.powerType === 'DC' ? 500 : 415 * 1.732)),
          max_electric_power: Math.round(c.maxPowerKw * 1000),
          tariff_ids: [tariffId(tenant, tariff)],
          last_updated: ocpiTime(c.statusAt || ch.updatedAt),
        })),
        physical_reference: `${ch.label || ch.ocppId} #${evseId}`,
        last_updated: ocpiTime(ch.updatedAt),
      });
    }
  }
  return {
    country_code: config.ocpi.countryCode,
    party_id: party,
    id: String(site._id),
    publish: true,
    name: site.name,
    address: site.address || site.name,
    city: site.city || '',
    postal_code: site.pincode,
    state: site.state,
    country: 'IND',
    coordinates: { latitude: String(site.location?.lat ?? 0), longitude: String(site.location?.lng ?? 0) },
    evses,
    operator: { name: tenant.name },
    time_zone: 'Asia/Kolkata',
    opening_times: { twentyfourseven: (site.timings || '24x7') === '24x7' },
    last_updated: ocpiTime(site.updatedAt),
  };
}

export function toTariff(tenant, t, partner) {
  const markup = 1 + (partner?.tariffMarkupBps || 0) / 10000;
  const energy = (t.roamingEnergyPaisePerKwh || t.energyPaisePerKwh) * markup;
  const elements = [{ price_components: [{ type: 'ENERGY', price: Math.round(energy) / 100, vat: (config.gstRateBps / 100), step_size: 1 }] }];
  if (t.sessionFeePaise) elements.push({ price_components: [{ type: 'FLAT', price: t.sessionFeePaise / 100, vat: config.gstRateBps / 100, step_size: 1 }] });
  if (t.timePaisePerMin) elements.push({ price_components: [{ type: 'TIME', price: (t.timePaisePerMin * 60) / 100, vat: config.gstRateBps / 100, step_size: 60 }] });
  return { country_code: config.ocpi.countryCode, party_id: partyOf(tenant), id: tariffId(tenant, t), currency: 'INR', type: 'REGULAR', elements, last_updated: ocpiTime(t.updatedAt) };
}

const SESSION_STATUS = { CREATED: 'PENDING', PAID: 'PENDING', STARTING: 'PENDING', CHARGING: 'ACTIVE', STOPPING: 'ACTIVE', INTERRUPTED: 'ACTIVE', COMPLETED: 'COMPLETED', BILLED: 'COMPLETED', FAILED: 'INVALID', CANCELLED: 'INVALID' };

export function toSession(s, tenant) {
  return {
    country_code: config.ocpi.countryCode,
    party_id: partyOf(tenant),
    id: String(s._id),
    start_date_time: ocpiTime(s.startedAt || s.createdAt),
    end_date_time: s.endedAt ? ocpiTime(s.endedAt) : undefined,
    kwh: Math.round(s.energyWh || 0) / 1000,
    cdr_token: { uid: s.roaming?.tokenUid || s.idToken, type: 'APP_USER', contract_id: s.roaming?.tokenUid || s.idToken, country_code: config.ocpi.countryCode, party_id: 'XXX' },
    auth_method: 'COMMAND',
    authorization_reference: s.roaming?.authRef,
    location_id: String(s.site),
    evse_uid: `${s.ocppId}*${s.evseId}`,
    connector_id: String(s.connectorNumber),
    currency: 'INR',
    total_cost: s.costs ? { excl_vat: (s.costs.taxablePaise || 0) / 100, incl_vat: (s.costs.totalPaise || 0) / 100 } : undefined,
    status: SESSION_STATUS[s.state] || 'PENDING',
    last_updated: ocpiTime(s.updatedAt),
  };
}

export function toCdr(s, tenant, site, tariff) {
  return {
    country_code: config.ocpi.countryCode,
    party_id: partyOf(tenant),
    id: `CDR-${s._id}`,
    start_date_time: ocpiTime(s.startedAt || s.createdAt),
    end_date_time: ocpiTime(s.endedAt || s.updatedAt),
    session_id: String(s._id),
    cdr_token: { uid: s.roaming?.tokenUid || s.idToken, type: 'APP_USER', contract_id: s.roaming?.tokenUid || s.idToken, country_code: config.ocpi.countryCode, party_id: 'XXX' },
    auth_method: 'COMMAND',
    authorization_reference: s.roaming?.authRef,
    cdr_location: {
      id: String(site?._id || s.site), name: site?.name, address: site?.address || '', city: site?.city || '', country: 'IND',
      coordinates: { latitude: String(site?.location?.lat ?? 0), longitude: String(site?.location?.lng ?? 0) },
      evse_uid: `${s.ocppId}*${s.evseId}`, evse_id: `${s.ocppId}*${s.evseId}`, connector_id: String(s.connectorNumber), connector_standard: 'IEC_62196_T2', connector_format: 'SOCKET', connector_power_type: 'AC_3_PHASE',
    },
    currency: 'INR',
    tariffs: tariff ? [toTariff(tenant, tariff)] : [],
    charging_periods: [{ start_date_time: ocpiTime(s.startedAt || s.createdAt), dimensions: [{ type: 'ENERGY', volume: Math.round(s.energyWh || 0) / 1000 }] }],
    total_cost: { excl_vat: (s.costs?.taxablePaise || 0) / 100, incl_vat: (s.costs?.totalPaise || 0) / 100 },
    total_energy: Math.round(s.energyWh || 0) / 1000,
    total_time: s.startedAt && s.endedAt ? Math.round(((new Date(s.endedAt) - new Date(s.startedAt)) / 3600_000) * 1000) / 1000 : 0,
    last_updated: ocpiTime(),
  };
}
