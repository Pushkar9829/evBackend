// Monthly billing runs (Requirements 1 + 5):
//   - Fleet: one GST invoice per fleet per supplier (tenant) per month, instead of per-session invoices.
//   - SaaS plan fee: monthly fee per charger for company tenants, deducted from the next payout.
import { Adjustment, Charger, Fleet, Invoice, Session, Tenant, nextSeq } from '../models/index.js';
import { config } from '../config.js';
import { financialYear } from '../lib/util.js';
import { gstOn } from '../lib/money.js';
import { logger } from '../lib/logger.js';

const PLATFORM = { name: 'ChargeX Platform Pvt Ltd', gstin: process.env.PLATFORM_GSTIN || '27AAAAA0000A1Z5', address: 'Mumbai, Maharashtra' };

/** [start, end) of a YYYY-MM month in IST. */
export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - 5.5 * 3600_000);
  const end = new Date(Date.UTC(y, m, 1) - 5.5 * 3600_000);
  return { start, end };
}

export const previousMonth = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const p = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
  return p.toISOString().slice(0, 7);
};

export async function issueFleetInvoices(month) {
  const { start, end } = monthRange(month);
  const sessions = await Session.find({ fleet: { $ne: null }, state: 'BILLED', endedAt: { $gte: start, $lt: end }, fleetInvoice: null, 'costs.totalPaise': { $gt: 0 } }).lean();
  const groups = new Map();
  for (const s of sessions) {
    const k = `${s.fleet}|${s.tenant}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const [k, list] of groups) {
    const [fleetId, tenantId] = k.split('|');
    const [fleet, tenant] = await Promise.all([Fleet.findById(fleetId).lean(), Tenant.findById(tenantId).lean()]);
    const fy = financialYear(end);
    const seq = await nextSeq(`inv:${tenant._id}:${fy}`);
    const inv = await Invoice.create({
      tenant: tenant._id,
      kind: 'fleet_monthly',
      fleet: fleet._id,
      supplier: { name: tenant.legalName || tenant.name, gstin: tenant.gstin, address: tenant.address },
      buyer: { name: fleet.name, gstin: fleet.gstin, email: fleet.billingEmail },
      lines: list.map((s) => ({ description: `${new Date(s.endedAt).toISOString().slice(0, 10)} ${s.ocppId}#${s.connectorNumber} · ${(s.energyWh / 1000).toFixed(3)} kWh`, quantity: s.energyWh / 1000, unit: 'kWh', ratePaise: s.tariff?.lockedEnergyPaisePerKwh || s.tariff?.energyPaisePerKwh, taxablePaise: s.costs.taxablePaise, gstPaise: s.costs.gstPaise, totalPaise: s.costs.totalPaise })),
      taxablePaise: list.reduce((a, s) => a + s.costs.taxablePaise, 0),
      gstPaise: list.reduce((a, s) => a + s.costs.gstPaise, 0),
      totalPaise: list.reduce((a, s) => a + s.costs.totalPaise, 0),
      gstRateBps: config.gstRateBps,
      status: 'issued',
      issuedAt: new Date(),
      fy,
      seq,
      number: `${tenant.invoicePrefix || 'INV'}/${fy}/${String(seq).padStart(6, '0')}`,
      period: month,
    });
    await Session.updateMany({ _id: { $in: list.map((s) => s._id) } }, { $set: { fleetInvoice: inv._id } });
    out.push(inv);
  }
  return out;
}

/** Monthly plan fee per charger for company tenants: platform invoice + payout deduction (idempotent per month). */
export async function billPlanFees(month) {
  const tenants = await Tenant.find({ type: 'company', status: { $ne: 'pending_kyc' }, 'plan.monthlyFeePerChargerPaise': { $gt: 0 } }).lean();
  const out = [];
  for (const t of tenants) {
    const ref = `saas:${t._id}:${month}`;
    if (await Adjustment.exists({ ref })) continue;
    const chargers = await Charger.countDocuments({ tenant: t._id, deletedAt: null });
    if (!chargers) continue;
    const taxable = chargers * t.plan.monthlyFeePerChargerPaise;
    const gst = gstOn(taxable);
    const fy = financialYear();
    const seq = await nextSeq(`inv:platform:${fy}`);
    const inv = await Invoice.create({
      tenant: t._id, kind: 'saas_fee', supplier: PLATFORM, buyer: { name: t.legalName || t.name, gstin: t.gstin },
      lines: [{ description: `${t.plan.name || 'Plan'} fee ${month}: ${chargers} charger(s)`, quantity: chargers, unit: 'charger', ratePaise: t.plan.monthlyFeePerChargerPaise, taxablePaise: taxable, gstPaise: gst, totalPaise: taxable + gst }],
      taxablePaise: taxable, gstPaise: gst, totalPaise: taxable + gst, gstRateBps: config.gstRateBps, status: 'issued', issuedAt: new Date(), fy, seq, number: `CHX-SAAS/${fy}/${String(seq).padStart(6, '0')}`, period: month,
    });
    // System-generated from the agreed plan, so it is applied without a second approval.
    out.push(await Adjustment.create({ tenant: t._id, amountPaise: -(taxable + gst), reason: `SaaS plan fee ${month} (${chargers} chargers, invoice ${inv.number})`, status: 'applied', ref }));
  }
  return out;
}

export async function runMonthlyBilling(month = previousMonth()) {
  const fleet = await issueFleetInvoices(month);
  const saas = await billPlanFees(month);
  logger.info(`monthly billing ${month}: ${fleet.length} fleet invoice(s), ${saas.length} plan fee(s)`);
  return { month, fleetInvoices: fleet.length, planFees: saas.length };
}
