import { Tariff, Tenant } from '../models/index.js';
import { config } from '../config.js';
import { gstOn, splitInclusive, roundPaise } from '../lib/money.js';
import { notFound } from '../lib/errors.js';

/** Latest published version of a tariff key that is active now (versioned tariffs, Requirements 5). */
export async function activeTariff(tenantId, key, at = new Date()) {
  const q = { tenant: tenantId, status: { $in: ['published', 'scheduled'] }, activeFrom: { $lte: at } };
  let t = key ? await Tariff.findOne({ ...q, key }).sort({ version: -1 }) : null;
  if (!t) t = await Tariff.findOne({ ...q, key: 'default' }).sort({ version: -1 });
  if (!t) t = await Tariff.findOne(q).sort({ activeFrom: -1, version: -1 });
  return t;
}

export async function tariffForConnector(charger, connector, at = new Date()) {
  const t = await activeTariff(charger.tenant, connector?.tariffKey || charger.tariffKey, at);
  if (!t) throw notFound('No tariff is set for this charger.');
  return t;
}

export function snapshot(tariff, tenant) {
  const o = tariff.toObject ? tariff.toObject() : { ...tariff };
  return {
    _id: o._id,
    key: o.key,
    name: o.name,
    version: o.version,
    energyPaisePerKwh: o.energyPaisePerKwh,
    sessionFeePaise: o.sessionFeePaise || 0,
    timePaisePerMin: o.timePaisePerMin || 0,
    minFeePaise: o.minFeePaise || 0,
    idle: o.idle || { paisePerMin: 0, graceMin: 15, capPaise: 0 },
    tod: o.tod || [],
    memberDiscountBps: o.memberDiscountBps || 0,
    fleetDiscountBps: o.fleetDiscountBps || 0,
    roamingEnergyPaisePerKwh: o.roamingEnergyPaisePerKwh,
    pricesIncludeGst: !!tenant?.pricesIncludeGst,
    gstRateBps: config.gstRateBps,
  };
}

/** IST hour for time-of-day bands. */
const istHour = (d) => new Date(new Date(d).getTime() + 5.5 * 3600_000).getUTCHours();

export function energyRateAt(t, at = new Date(), { roaming = false } = {}) {
  if (roaming && t.roamingEnergyPaisePerKwh) return t.roamingEnergyPaisePerKwh;
  const h = istHour(at);
  const band = (t.tod || []).find((b) => (b.startHour <= b.endHour ? h >= b.startHour && h < b.endHour : h >= b.startHour || h < b.endHour));
  return band ? band.energyPaisePerKwh : t.energyPaisePerKwh;
}

const lineGst = (taxable, rate, inclusive) => (inclusive ? splitInclusive(taxable, rate) : { taxable, gst: gstOn(taxable, rate) });

/**
 * Compute the bill for a session from its tariff snapshot.
 * Energy cost is accrued per meter delta (exact, ToD-aware) in session.costs.energyExact.
 * GST is computed per line and the total never exceeds the cap (golden rule 2).
 * Zero energy => nothing is charged (golden rule 3, BIL-01).
 */
export function computeBill(session, { at = new Date(), capPaise } = {}) {
  const t = session.tariff;
  const rate = t.gstRateBps ?? config.gstRateBps;
  const inclusive = !!t.pricesIncludeGst;
  const energyWh = session.energyWh || 0;
  const lines = [];
  if (energyWh <= 0) {
    return { lines, energyPaise: 0, sessionFeePaise: 0, timePaise: 0, idlePaise: 0, discountPaise: 0, taxablePaise: 0, gstPaise: 0, totalPaise: 0, absorbedPaise: 0 };
  }

  const energyPaise = roundPaise(session.costs?.energyExact || (energyWh * t.energyPaisePerKwh) / 1000);
  lines.push({ code: 'energy', description: `Energy ${(energyWh / 1000).toFixed(3)} kWh`, quantity: energyWh / 1000, unit: 'kWh', ratePaise: t.energyPaisePerKwh, amount: energyPaise });

  if (t.sessionFeePaise) lines.push({ code: 'session_fee', description: 'Session fee', quantity: 1, unit: 'session', ratePaise: t.sessionFeePaise, amount: t.sessionFeePaise });

  const chargeEnd = session.chargingEndedAt || session.endedAt || at;
  if (t.timePaisePerMin && session.startedAt) {
    const mins = Math.max(0, Math.ceil((new Date(chargeEnd) - new Date(session.startedAt)) / 60000));
    if (mins) lines.push({ code: 'time', description: `Time ${mins} min`, quantity: mins, unit: 'min', ratePaise: t.timePaisePerMin, amount: mins * t.timePaisePerMin });
  }

  // Idle fee after the grace period, capped (Phase 2, BIL-14).
  if (t.idle?.paisePerMin && session.chargingEndedAt) {
    const idleEnd = session.endedAt || at;
    const idleMin = Math.floor((new Date(idleEnd) - new Date(session.chargingEndedAt)) / 60000) - (t.idle.graceMin || 0);
    if (idleMin > 0) {
      let idle = idleMin * t.idle.paisePerMin;
      if (t.idle.capPaise) idle = Math.min(idle, t.idle.capPaise);
      lines.push({ code: 'idle', description: `Idle fee ${idleMin} min`, quantity: idleMin, unit: 'min', ratePaise: t.idle.paisePerMin, amount: idle });
    }
  }

  let subtotal = lines.reduce((s, l) => s + l.amount, 0);
  if (t.minFeePaise && subtotal < t.minFeePaise) {
    lines.push({ code: 'min_fee', description: 'Minimum fee adjustment', quantity: 1, unit: 'session', ratePaise: t.minFeePaise - subtotal, amount: t.minFeePaise - subtotal });
    subtotal = t.minFeePaise;
  }

  let discountBps = 0;
  if (session.channel === 'fleet') discountBps = t.fleetDiscountBps || 0;
  else if (session.driver) discountBps = t.memberDiscountBps || 0;
  let promoDiscount = 0;
  if (session.promo?.kind === 'percent') promoDiscount = roundPaise((subtotal * (session.promo.value || 0)) / 10000);
  else if (session.promo?.kind === 'flat') promoDiscount = session.promo.value || 0;
  if (session.promo?.max) promoDiscount = Math.min(promoDiscount, session.promo.max);
  let discount = roundPaise((subtotal * discountBps) / 10000) + promoDiscount;
  discount = Math.min(discount, subtotal);
  if (discount) lines.push({ code: 'discount', description: 'Discount', quantity: 1, unit: 'session', ratePaise: -discount, amount: -discount });

  // GST per line
  let out = lines.map((l) => {
    const g = lineGst(l.amount, rate, inclusive);
    return { ...l, taxablePaise: g.taxable, gstPaise: g.gst, totalPaise: g.taxable + g.gst };
  });
  let total = out.reduce((s, l) => s + l.totalPaise, 0);

  // Cap: never charge more than the driver prepaid (CHG-09/10). The overrun is absorbed by the platform.
  let absorbed = 0;
  const cap = capPaise ?? session.capPaise;
  if (cap !== undefined && cap !== null && total > cap) {
    absorbed = total - cap;
    const energy = out.find((l) => l.code === 'energy');
    const others = out.filter((l) => l !== energy).reduce((s, l) => s + l.totalPaise, 0);
    const energyTotal = Math.max(0, cap - others);
    const split = splitInclusive(energyTotal, rate);
    energy.taxablePaise = split.taxable;
    energy.gstPaise = split.gst;
    energy.totalPaise = energyTotal;
    energy.description += ' (limited to prepaid amount)';
    if (others > cap) {
      // pathological: fees alone exceed cap — scale everything down to the cap
      out = out.map((l) => ({ ...l, totalPaise: 0, taxablePaise: 0, gstPaise: 0 }));
      const s2 = splitInclusive(cap, rate);
      out[0] = { ...out[0], taxablePaise: s2.taxable, gstPaise: s2.gst, totalPaise: cap };
    }
    total = out.reduce((s, l) => s + l.totalPaise, 0);
  }

  const sum = (code) => out.filter((l) => l.code === code).reduce((s, l) => s + l.totalPaise, 0);
  return {
    lines: out,
    energyPaise: sum('energy'),
    sessionFeePaise: sum('session_fee'),
    timePaise: sum('time'),
    idlePaise: sum('idle'),
    discountPaise: -sum('discount'),
    taxablePaise: out.reduce((s, l) => s + l.taxablePaise, 0),
    gstPaise: out.reduce((s, l) => s + l.gstPaise, 0),
    totalPaise: total,
    absorbedPaise: absorbed,
  };
}

/** Preview the cost for sample sessions before publishing (Admin 3.6). */
export function previewTariff(t, samples = [5, 10, 20, 30]) {
  return samples.map((k) => {
    const wh = k * 1000;
    const fake = { tariff: { ...t, gstRateBps: config.gstRateBps }, energyWh: wh, costs: { energyExact: (wh * t.energyPaisePerKwh) / 1000 }, startedAt: new Date(Date.now() - 3600_000), endedAt: new Date() };
    const b = computeBill(fake);
    return { kwh: k, totalPaise: b.totalPaise, gstPaise: b.gstPaise, taxablePaise: b.taxablePaise };
  });
}

/** Estimated kWh and minutes for each amount (UX 1.3 smart amount suggestions). */
export function estimateForAmount(t, amountPaise, maxPowerKw = 7.4, inclusive = false) {
  const rate = config.gstRateBps;
  const net = inclusive ? amountPaise : Math.floor((amountPaise * 10000) / (10000 + rate));
  const forEnergy = Math.max(0, net - (t.sessionFeePaise || 0));
  const perKwh = (t.energyPaisePerKwh || 1) + (t.timePaisePerMin || 0) * (60 / Math.max(maxPowerKw, 1));
  const kwhEst = forEnergy / perKwh;
  const minutes = Math.round((kwhEst / Math.max(maxPowerKw, 0.5)) * 60);
  return { amountPaise, kwh: Math.round(kwhEst * 100) / 100, minutes };
}

export async function nextTariffVersion(tenantId, key) {
  const last = await Tariff.findOne({ tenant: tenantId, key }).sort({ version: -1 }).lean();
  return (last?.version || 0) + 1;
}

export async function tenantPricesIncludeGst(tenantId) {
  const t = await Tenant.findById(tenantId).select('pricesIncludeGst').lean();
  return !!t?.pricesIncludeGst;
}
