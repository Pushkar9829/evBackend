import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

const TenantSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    type: { type: String, enum: ['company', 'host'], default: 'company' },
    status: { type: String, enum: ['pending_kyc', 'active', 'suspended'], default: 'active' },
    suspendedReason: String,
    contact: { name: String, phone: String, email: String },
    address: String,
    gstin: String,
    legalName: String,
    kyc: { pan: String, gstin: String, status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' }, notes: String },
    plan: { name: { type: String, default: 'standard' }, monthlyFeePerChargerPaise: { type: Number, default: 0 } },
    bank: { accountName: String, accountNumberLast4: String, ifsc: String, gatewayAccountId: String },
    payoutDelayDays: { type: Number, default: 2, min: 0, max: 30 },
    payoutHold: { type: Boolean, default: false },
    invoicePrefix: { type: String, default: 'INV' },
    pricesIncludeGst: { type: Boolean, default: false },
    branding: { appName: String, logoUrl: String, primaryColor: String, accentColor: String, visibleTenantIds: [{ type: Types.ObjectId, ref: 'Tenant' }] },
    featureFlags: { type: Map, of: Boolean, default: {} },
    ocpiPartyId: String, // e.g. ABC -> IN*ABC
    complaintSlaHours: { type: Number, default: 24 },
    alertContacts: { emails: [String], phones: [String] },
  },
  { timestamps: true },
);

// Commission rules are effective from a date; the rule active when a session started applies.
const CommissionRuleSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', required: true, index: true },
    kind: { type: String, enum: ['percent', 'per_kwh', 'fixed'], required: true },
    value: { type: Number, required: true }, // percent: basis points; per_kwh: paise per kWh; fixed: paise per session
    effectiveFrom: { type: Date, required: true },
    createdBy: { type: Types.ObjectId, ref: 'User' },
    note: String,
  },
  { timestamps: true },
);

const SiteSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true },
    address: String,
    city: { type: String, index: true },
    state: String,
    pincode: String,
    location: { lat: Number, lng: Number },
    photos: [String],
    timings: { type: String, default: '24x7' },
    amenities: [String],
    howToReach: String, // basements, malls (UX 1.3)
    siteHost: { type: Types.ObjectId, ref: 'User' },
    revenueShareBps: { type: Number, default: 0 },
    powerLimitKw: Number, // smart charging site cap
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true },
);

export const Tenant = model('Tenant', TenantSchema);
export const CommissionRule = model('CommissionRule', CommissionRuleSchema);
export const Site = model('Site', SiteSchema);
