import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

export const SESSION_STATES = ['CREATED', 'PAID', 'STARTING', 'CHARGING', 'STOPPING', 'COMPLETED', 'BILLED', 'FAILED', 'INTERRUPTED', 'CANCELLED'];
export const ACTIVE_STATES = ['PAID', 'STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'];

const TariffSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true }, // stable id shared by all versions
    name: { type: String, required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ['draft', 'scheduled', 'published', 'archived'], default: 'draft' },
    currency: { type: String, default: 'INR' },
    energyPaisePerKwh: { type: Number, required: true }, // e.g. 1800 = Rs 18/kWh
    sessionFeePaise: { type: Number, default: 0 },
    timePaisePerMin: { type: Number, default: 0 },
    minFeePaise: { type: Number, default: 0 },
    idle: { paisePerMin: { type: Number, default: 0 }, graceMin: { type: Number, default: 15 }, capPaise: { type: Number, default: 0 } },
    tod: [{ startHour: Number, endHour: Number, energyPaisePerKwh: Number, label: String }], // time-of-day bands (IST hours)
    memberDiscountBps: { type: Number, default: 0 },
    fleetDiscountBps: { type: Number, default: 0 },
    roamingEnergyPaisePerKwh: Number,
    v2gExportPaisePerKwh: { type: Number, default: 0 }, // credit per kWh returned to the grid [Confirm]
    activeFrom: { type: Date, default: Date.now },
    publishedAt: Date,
    publishReason: String,
    createdBy: { type: Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
TariffSchema.index({ tenant: 1, key: 1, version: 1 }, { unique: true });

const SessionSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', required: true, index: true },
    site: { type: Types.ObjectId, ref: 'Site' },
    charger: { type: Types.ObjectId, ref: 'Charger', required: true, index: true },
    ocppId: { type: String, index: true },
    connectorNumber: Number,
    evseId: Number,
    connectorId: Number,
    driver: { type: Types.ObjectId, ref: 'User', index: true },
    guestPhone: { type: String, index: true },
    channel: { type: String, enum: ['qr', 'app', 'roaming', 'fleet', 'admin', 'rfid', 'uei', 'pnc'], default: 'qr' },
    accessTokenHash: String, // full-control token held by the browser that paid
    viewTokenHash: String, // read-only token used in SMS/WhatsApp links (QR-07)
    state: { type: String, enum: SESSION_STATES, default: 'CREATED', index: true },
    history: [{ state: String, at: Date, note: String, _id: false }],
    prepaidPaise: { type: Number, default: 0 },
    postpaid: { type: Boolean, default: false }, // fleet / autopay / roaming
    capPaise: Number, // the hard money limit for this session (prepaid or fleet limit)
    payment: { type: Types.ObjectId, ref: 'Payment' },
    tariff: Schema.Types.Mixed, // full snapshot of the tariff version active at start (DIS-07, CHG-11)
    tariffId: { type: Types.ObjectId, ref: 'Tariff' },
    idToken: { type: String, index: true },
    remoteStartId: { type: Number, index: true },
    transactionId: { type: String, index: true },
    paidAt: Date,
    startRequestedAt: Date,
    plugDeadline: Date,
    startDeadline: Date,
    startedAt: Date,
    stopRequestedAt: Date,
    stopRequestedBy: String,
    endedAt: Date,
    chargingEndedAt: Date, // energy stopped flowing (for idle fee)
    meter: {
      startWh: Number,
      lastWh: Number,
      lastAt: Date,
      segmentBaseWh: { type: Number, default: 0 }, // energy carried over from previous segments after a meter reset (CHG-04)
      segmentStartWh: Number,
      lastEnergyAt: Date, // last time energy increased
    },
    energyWh: { type: Number, default: 0 },
    exportedWh: { type: Number, default: 0 }, // V2G: energy returned to the grid (OCPP 2.1)
    exportMeter: { startWh: Number, lastWh: Number },
    chargingNeeds: Schema.Types.Mixed, // ISO 15118 NotifyEVChargingNeeds
    live: { powerW: Number, socPct: Number, updatedAt: Date, zeroPowerSince: Date, chargingState: String },
    seqSeen: { type: [String], default: [] }, // processed TransactionEvent keys: seqNo or timestamp (CHG-07)
    maxSeq: { type: Number, default: -1 },
    pluggedAt: Date,
    availableSince: Date, // connector went Available while the session was still open (STP-06)
    suggestSwitchTo: Number, // driver plugged into a different connector (STA-09)
    stopRetries: { type: Number, default: 0 },
    startChecked: { type: Boolean, default: false },
    unlockTried: { type: Boolean, default: false },
    pendingEvents: { type: [Schema.Types.Mixed], default: [] },
    rejectedReadings: { type: Number, default: 0 },
    costs: {
      energyPaise: { type: Number, default: 0 },
      sessionFeePaise: { type: Number, default: 0 },
      timePaise: { type: Number, default: 0 },
      idlePaise: { type: Number, default: 0 },
      discountPaise: { type: Number, default: 0 },
      taxablePaise: { type: Number, default: 0 },
      gstPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, default: 0 },
      absorbedPaise: { type: Number, default: 0 }, // overrun absorbed by platform (CHG-10)
      energyExact: { type: Number, default: 0 }, // fractional paise accrued per meter delta at the band rate in force
    },
    refundPaise: { type: Number, default: 0 },
    commissionPaise: Number,
    tenantSharePaise: Number,
    siteHostSharePaise: Number,
    invoice: { type: Types.ObjectId, ref: 'Invoice' },
    failureReason: String,
    stopReason: String,
    flags: { type: [String], default: [] }, // late_start, meter_rejected, offline_final, review, overrun, reversal...
    reviewNeeded: { type: Boolean, default: false, index: true },
    interruptedAt: Date,
    alertsSent: { type: [String], default: [] },
    rating: { stars: Number, comment: String, at: Date },
    fleet: { type: Types.ObjectId, ref: 'Fleet' },
    promo: { code: String, kind: String, value: Number, max: Number, discountPaise: Number },
    reservation: { type: Types.ObjectId, ref: 'Reservation' },
    roaming: { partner: { type: Types.ObjectId, ref: 'RoamingPartner' }, protocol: String, externalId: String, tokenUid: String, authRef: String, responseUrl: String, resultSent: Boolean },
    settledInPayout: { type: Types.ObjectId, ref: 'Payout' },
    chargerTime: { startedAt: Date, endedAt: Date }, // charger-reported times kept alongside server times (RES-07)
    paymentCancelledAt: Date,
    notes: [{ by: { type: Types.ObjectId, ref: 'User' }, text: String, at: Date, _id: false }],
  },
  { timestamps: true },
);
SessionSchema.index({ state: 1, updatedAt: 1 });
SessionSchema.index({ tenant: 1, createdAt: -1 });

const PaymentSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    session: { type: Types.ObjectId, ref: 'Session', index: true },
    provider: { type: String, default: 'mock' },
    orderId: { type: String, required: true, unique: true },
    idempotencyKey: { type: String, index: { unique: true, sparse: true } }, // PAY-09: double tap
    amountPaise: { type: Number, required: true },
    paidPaise: Number,
    status: { type: String, enum: ['created', 'captured', 'failed', 'cancelled', 'expired'], default: 'created', index: true },
    gatewayPaymentId: String,
    method: String,
    failureReason: String,
    capturedAt: Date,
    lastPolledAt: Date,
    reversed: { type: Boolean, default: false },
    refundedPaise: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const WebhookEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true }, // PAY-05 / SEC-06
  provider: String,
  type: String,
  receivedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

const RefundSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    session: { type: Types.ObjectId, ref: 'Session', index: true },
    payment: { type: Types.ObjectId, ref: 'Payment', index: true },
    amountPaise: { type: Number, required: true },
    reasonCode: String,
    reason: String,
    kind: { type: String, enum: ['auto', 'admin', 'duplicate', 'late_payment'], default: 'auto' },
    status: { type: String, enum: ['pending', 'processing', 'succeeded', 'failed', 'finance_queue'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: String,
    gatewayRefundId: String,
    initiatedBy: { type: Types.ObjectId, ref: 'User' },
    approval: { type: Types.ObjectId, ref: 'Approval' },
    succeededAt: Date,
  },
  { timestamps: true },
);

const InvoiceLineSchema = new Schema(
  { description: String, quantity: Number, unit: String, ratePaise: Number, taxablePaise: Number, gstPaise: Number, totalPaise: Number },
  { _id: false },
);

const InvoiceSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    kind: { type: String, enum: ['driver', 'commission', 'credit_note', 'fleet_monthly'], default: 'driver' },
    session: { type: Types.ObjectId, ref: 'Session', index: true },
    payout: { type: Types.ObjectId, ref: 'Payout' },
    fleet: { type: Types.ObjectId, ref: 'Fleet' },
    number: { type: String, index: { unique: true, sparse: true } },
    fy: String,
    seq: Number,
    status: { type: String, enum: ['pending', 'issued', 'failed', 'cancelled'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    supplier: { name: String, gstin: String, address: String },
    buyer: { name: String, phone: String, gstin: String, email: String },
    lines: [InvoiceLineSchema],
    taxablePaise: Number,
    gstPaise: Number,
    totalPaise: Number,
    gstRateBps: Number,
    issuedAt: Date,
    replaces: { type: Types.ObjectId, ref: 'Invoice' }, // credit note -> original
    replacedBy: { type: Types.ObjectId, ref: 'Invoice' },
    lastError: String,
  },
  { timestamps: true },
);

// Atomic counters for gap-free sequential numbering (BIL-10).
const CounterSchema = new Schema({ key: { type: String, unique: true }, seq: { type: Number, default: 0 } });

export const Tariff = model('Tariff', TariffSchema);
export const Session = model('Session', SessionSchema);
export const Payment = model('Payment', PaymentSchema);
export const WebhookEvent = model('WebhookEvent', WebhookEventSchema);
export const Refund = model('Refund', RefundSchema);
export const Invoice = model('Invoice', InvoiceSchema);
export const Counter = model('Counter', CounterSchema);

export async function nextSeq(key) {
  const c = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return c.seq;
}
