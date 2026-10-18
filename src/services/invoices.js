import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';
import { Invoice, Session, Tenant, User, nextSeq } from '../models/index.js';
import { config } from '../config.js';
import { financialYear } from '../lib/util.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { computeBill } from './tariffs.js';

const PLATFORM = { name: 'ChargeX Platform Pvt Ltd', gstin: process.env.PLATFORM_GSTIN || '27AAAAA0000A1Z5', address: 'Mumbai, Maharashtra' };

/** Sequential per tenant per financial year, allocated atomically: no gaps or duplicates under concurrency (BIL-10). */
async function allocateNumber(prefix, scopeKey, date = new Date()) {
  const fy = financialYear(date);
  const seq = await nextSeq(`${scopeKey}:${fy}`);
  return { fy, seq, number: `${prefix}/${fy}/${String(seq).padStart(6, '0')}` };
}

/** Create the driver invoice for a billed session. Safe to call repeatedly (retry job). */
export async function issueSessionInvoice(sessionId) {
  const session = await Session.findById(sessionId);
  if (!session || session.state !== 'BILLED' || !(session.costs?.totalPaise > 0)) return null;
  let inv = session.invoice ? await Invoice.findById(session.invoice) : await Invoice.findOne({ session: session._id, kind: 'driver', status: { $ne: 'cancelled' } });
  if (inv?.status === 'issued') return inv;
  const tenant = await Tenant.findById(session.tenant).lean();
  const driver = session.driver ? await User.findById(session.driver).lean() : null;
  const bill = computeBill(session);
  if (!inv) {
    inv = new Invoice({
      tenant: session.tenant,
      kind: 'driver',
      session: session._id,
      // [Confirm with CA] supplier on the driver invoice: tenant (default here) vs platform.
      supplier: { name: tenant.legalName || tenant.name, gstin: tenant.gstin, address: tenant.address },
      buyer: { name: driver?.businessName || driver?.name || 'Guest driver', phone: session.guestPhone || driver?.phone, gstin: driver?.gstin },
      lines: bill.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, ratePaise: l.ratePaise, taxablePaise: l.taxablePaise, gstPaise: l.gstPaise, totalPaise: l.totalPaise })),
      taxablePaise: bill.taxablePaise,
      gstPaise: bill.gstPaise,
      totalPaise: bill.totalPaise,
      gstRateBps: session.tariff?.gstRateBps ?? config.gstRateBps,
    });
  }
  inv.attempts += 1;
  try {
    if (process.env.FAIL_INVOICES === '1') throw new Error('Invoice service unavailable (simulated)');
    if (!inv.number) Object.assign(inv, await allocateNumber(tenant.invoicePrefix || 'INV', `inv:${tenant._id}`, session.endedAt || new Date()));
    inv.status = 'issued';
    inv.issuedAt = new Date();
    await inv.save();
    session.invoice = inv._id;
    await session.save();
    return inv;
  } catch (e) {
    // Session stays completed; the retry job issues it later (BIL-07).
    inv.status = 'failed';
    inv.lastError = e.message;
    await inv.save().catch(() => {});
    logger.warn(`invoice for session ${session._id} failed: ${e.message}`);
    return inv;
  }
}

export async function retryFailedInvoices() {
  const pending = await Invoice.find({ kind: 'driver', status: { $in: ['failed', 'pending'] }, attempts: { $lt: 10 } }).limit(50).select('session');
  for (const i of pending) await issueSessionInvoice(i.session);
  const missing = await Session.find({ state: 'BILLED', invoice: null, 'costs.totalPaise': { $gt: 0 } }).limit(50).select('_id');
  for (const s of missing) await issueSessionInvoice(s._id);
  return pending.length + missing.length;
}

/** Correct a GSTIN: credit note against the original + a new invoice; never an edit (Admin 3.4). */
export async function reissueWithGstin(invoiceId, gstin, buyerName) {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(gstin || '')) throw badRequest('BAD_GSTIN', 'Enter a valid 15-character GSTIN.');
  const orig = await Invoice.findById(invoiceId);
  if (!orig || orig.status !== 'issued' || orig.kind === 'credit_note') throw badRequest('INVOICE_NOT_ISSUED', 'Only issued invoices can be corrected.');
  const tenant = await Tenant.findById(orig.tenant).lean();
  const cn = new Invoice({
    tenant: orig.tenant, kind: 'credit_note', session: orig.session, supplier: orig.supplier, buyer: orig.buyer,
    lines: orig.lines.map((l) => ({ ...l.toObject(), taxablePaise: -l.taxablePaise, gstPaise: -l.gstPaise, totalPaise: -l.totalPaise })),
    taxablePaise: -orig.taxablePaise, gstPaise: -orig.gstPaise, totalPaise: -orig.totalPaise, gstRateBps: orig.gstRateBps, replaces: orig._id, status: 'issued', issuedAt: new Date(),
    ...(await allocateNumber(`${tenant.invoicePrefix || 'INV'}-CN`, `cn:${tenant._id}`)),
  });
  await cn.save();
  const fresh = new Invoice({
    tenant: orig.tenant, kind: orig.kind, session: orig.session, supplier: orig.supplier,
    buyer: { ...orig.buyer.toObject(), gstin, name: buyerName || orig.buyer.name },
    lines: orig.lines, taxablePaise: orig.taxablePaise, gstPaise: orig.gstPaise, totalPaise: orig.totalPaise, gstRateBps: orig.gstRateBps,
    status: 'issued', issuedAt: new Date(), ...(await allocateNumber(tenant.invoicePrefix || 'INV', `inv:${tenant._id}`)),
  });
  await fresh.save();
  orig.status = 'cancelled';
  orig.replacedBy = fresh._id;
  await orig.save();
  if (orig.session) await Session.updateOne({ _id: orig.session }, { $set: { invoice: fresh._id } });
  return { creditNote: cn, invoice: fresh };
}

/** Platform commission invoice to a tenant for a payout period. */
export async function issueCommissionInvoice(payout) {
  const tenant = await Tenant.findById(payout.tenant).lean();
  const inv = new Invoice({
    tenant: payout.tenant,
    kind: 'commission',
    payout: payout._id,
    supplier: PLATFORM,
    buyer: { name: tenant.legalName || tenant.name, gstin: tenant.gstin },
    lines: [{ description: `Platform commission ${payout.periodStart.toISOString().slice(0, 10)} to ${payout.periodEnd.toISOString().slice(0, 10)}`, quantity: payout.sessionCount, unit: 'sessions', ratePaise: 0, taxablePaise: payout.commissionPaise, gstPaise: payout.gstOnCommissionPaise, totalPaise: payout.commissionPaise + payout.gstOnCommissionPaise }],
    taxablePaise: payout.commissionPaise,
    gstPaise: payout.gstOnCommissionPaise,
    totalPaise: payout.commissionPaise + payout.gstOnCommissionPaise,
    gstRateBps: config.gstRateBps,
    status: 'issued',
    issuedAt: new Date(),
    ...(await allocateNumber('CHX-COM', 'inv:platform')),
  });
  await inv.save();
  return inv;
}

const rs = (p) => `Rs ${(p / 100).toFixed(2)}`;

/** Stream a simple GST invoice PDF. */
/** Render the invoice PDF to a Buffer (email attachments). */
export function invoicePdfBuffer(inv) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (c) => chunks.push(c));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    invoicePdf(inv, sink);
  });
}

export function invoicePdf(inv, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  if (res.setHeader) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(inv.number || 'invoice').replace(/\//g, '-')}.pdf"`);
  }
  doc.pipe(res);
  const title = inv.kind === 'credit_note' ? 'CREDIT NOTE' : 'TAX INVOICE';
  doc.fontSize(18).text(title, { align: 'right' });
  doc.fontSize(10).text(`No: ${inv.number || '-'}`, { align: 'right' }).text(`Date: ${(inv.issuedAt || inv.createdAt).toISOString().slice(0, 10)}`, { align: 'right' });
  doc.moveDown();
  doc.fontSize(11).text(`Supplier: ${inv.supplier?.name || ''}`).fontSize(9).text(`GSTIN: ${inv.supplier?.gstin || 'N/A'}`).text(inv.supplier?.address || '');
  doc.moveDown(0.5);
  doc.fontSize(11).text(`Bill to: ${inv.buyer?.name || ''}`).fontSize(9).text(inv.buyer?.gstin ? `GSTIN: ${inv.buyer.gstin}` : `Phone: ${inv.buyer?.phone ? `${inv.buyer.phone.slice(0, 2)}******${inv.buyer.phone.slice(-2)}` : '-'}`);
  doc.moveDown();
  const top = doc.y;
  const cols = [48, 260, 340, 420, 490];
  doc.fontSize(9).text('Description', cols[0], top).text('Taxable', cols[1], top).text(`GST ${(inv.gstRateBps || 1800) / 100}%`, cols[2], top).text('Total', cols[3], top);
  doc.moveTo(48, top + 14).lineTo(547, top + 14).stroke();
  let y = top + 20;
  for (const l of inv.lines) {
    doc.text(l.description, cols[0], y, { width: 200 }).text(rs(l.taxablePaise), cols[1], y).text(rs(l.gstPaise), cols[2], y).text(rs(l.totalPaise), cols[3], y);
    y += 18;
  }
  doc.moveTo(48, y).lineTo(547, y).stroke();
  y += 8;
  doc.fontSize(10).text('Taxable value', cols[1] - 100, y).text(rs(inv.taxablePaise), cols[3], y);
  y += 14;
  doc.text('CGST + SGST / IGST', cols[1] - 100, y).text(rs(inv.gstPaise), cols[3], y);
  y += 14;
  doc.fontSize(12).text('Total', cols[1] - 100, y).text(rs(inv.totalPaise), cols[3], y);
  doc.fontSize(8).text('Computer-generated invoice. Energy to 3 decimals, money to 2 decimals.', 48, 760);
  doc.end();
}
