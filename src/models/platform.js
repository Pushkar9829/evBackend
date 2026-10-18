import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

// Singleton platform settings: kill switches, maintenance banner, app version gate (Admin 3.6/3.7).
const PlatformSettingsSchema = new Schema(
  {
    key: { type: String, default: 'platform', unique: true },
    pauseNewPayments: { type: Boolean, default: false },
    pauseReason: String,
    gatewayDown: { type: Boolean, default: false }, // set by health monitor (PAY-11)
    maintenanceBanner: { active: { type: Boolean, default: false }, message: String },
    minAppVersion: { type: String, default: '1.0.0' },
    supportPhone: { type: String, default: '1800-000-0000' },
    supportEmail: { type: String, default: 'support@chargex.in' },
    featureFlags: { type: Map, of: Boolean, default: {} }, // global defaults; tenant flags override
    adminSessionTimeoutMin: { type: Number, default: 480 },
    adminIpAllowList: [String],
    defaultCommission: { kind: { type: String, default: 'percent' }, value: { type: Number, default: 1000 } },
    hostSuggestedPricePaisePerKwh: { type: Number, default: 1800 },
    ueiKeys: { publicKey: String, privateKey: String },
    pki: { rootCert: String, rootKey: String, moCert: String, moKey: String },
  },
  { timestamps: true },
);

const ContentSchema = new Schema(
  {
    kind: { type: String, enum: ['banner', 'faq', 'terms', 'privacy', 'support'], required: true },
    title: String,
    body: String,
    lang: { type: String, default: 'en' },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    tenant: { type: Types.ObjectId, ref: 'Tenant' },
  },
  { timestamps: true },
);

// Templates per language linked to DLT template ids; unapproved SMS templates are blocked (NOT-02).
const NotificationTemplateSchema = new Schema(
  {
    key: { type: String, required: true }, // session_started | session_completed | refund_initiated | otp | amount_80 | fault ...
    channel: { type: String, enum: ['sms', 'whatsapp', 'push', 'email'], required: true },
    lang: { type: String, default: 'en' },
    body: { type: String, required: true },
    dltTemplateId: String,
    approved: { type: Boolean, default: false },
  },
  { timestamps: true },
);
NotificationTemplateSchema.index({ key: 1, channel: 1, lang: 1 }, { unique: true });

const PromoCodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    tenant: { type: Types.ObjectId, ref: 'Tenant' },
    kind: { type: String, enum: ['percent', 'flat'], default: 'percent' },
    value: Number, // bps or paise
    maxDiscountPaise: Number,
    perUserLimit: { type: Number, default: 1 },
    budgetPaise: Number,
    usedPaise: { type: Number, default: 0 },
    uses: [{ user: { type: Types.ObjectId, ref: 'User' }, phone: String, at: Date, discountPaise: Number, _id: false }],
    expiresAt: Date,
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const FleetSchema = new Schema(
  {
    name: { type: String, required: true },
    gstin: String,
    billingEmail: String,
    managers: [{ type: Types.ObjectId, ref: 'User' }],
    drivers: [{ user: { type: Types.ObjectId, ref: 'User' }, spendLimitPaise: Number, monthSpentPaise: { type: Number, default: 0 }, monthKey: String, active: { type: Boolean, default: true }, _id: false }],
    vehicles: [{ registration: String, vehicleType: String, label: String }],
    creditLimitPaise: { type: Number, default: 1000000 },
    outstandingPaise: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: true },
);

const PayoutSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    periodStart: Date,
    periodEnd: Date,
    sessionCount: Number,
    grossPaise: Number, // total billed to drivers (incl GST)
    gstCollectedPaise: Number,
    commissionPaise: Number,
    gstOnCommissionPaise: Number,
    adjustmentsPaise: { type: Number, default: 0 },
    siteHostSharePaise: { type: Number, default: 0 },
    netPaise: Number,
    status: { type: String, enum: ['draft', 'held', 'released', 'paid', 'failed'], default: 'draft', index: true },
    scheduledFor: Date,
    paidAt: Date,
    gatewayTransferId: String,
    commissionInvoice: { type: Types.ObjectId, ref: 'Invoice' },
    holdReason: String,
    lines: [{ session: { type: Types.ObjectId, ref: 'Session' }, totalPaise: Number, commissionPaise: Number, tenantSharePaise: Number, _id: false }],
  },
  { timestamps: true },
);

const AdjustmentSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    amountPaise: { type: Number, required: true }, // + credit to tenant, - debit
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending_approval', 'applied', 'rejected', 'settled'], default: 'pending_approval' },
    approval: { type: Types.ObjectId, ref: 'Approval' },
    payout: { type: Types.ObjectId, ref: 'Payout' },
    createdBy: { type: Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

const ReconciliationRunSchema = new Schema(
  {
    date: { type: String, index: true }, // YYYY-MM-DD
    totals: Schema.Types.Mixed,
    mismatches: [{ kind: String, ref: String, tenant: { type: Types.ObjectId, ref: 'Tenant' }, detail: String, _id: false }],
    status: { type: String, enum: ['ok', 'mismatch'], default: 'ok' },
  },
  { timestamps: true },
);

export const PlatformSettings = model('PlatformSettings', PlatformSettingsSchema);
export const Content = model('Content', ContentSchema);
export const NotificationTemplate = model('NotificationTemplate', NotificationTemplateSchema);
export const PromoCode = model('PromoCode', PromoCodeSchema);
export const Fleet = model('Fleet', FleetSchema);
export const Payout = model('Payout', PayoutSchema);
export const Adjustment = model('Adjustment', AdjustmentSchema);
export const ReconciliationRun = model('ReconciliationRun', ReconciliationRunSchema);
