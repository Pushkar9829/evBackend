import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

const MembershipSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', required: true },
    role: { type: String, required: true },
    siteIds: [{ type: Types.ObjectId, ref: 'Site' }], // scope for site-level roles
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const VehicleSchema = new Schema({
  label: String,
  make: String,
  model: String,
  vehicleType: { type: String, enum: ['2W', '3W', 'car', 'bus'], default: 'car' },
  connectorTypes: [String],
  batteryKwh: Number,
  registration: String,
  // ISO 15118 Plug & Charge: contract identity issued by us as the eMSP
  pnc: { emaid: String, certSerial: String, issuedAt: Date, revokedAt: Date },
});

const UserSchema = new Schema(
  {
    phone: { type: String, index: { unique: true, sparse: true } },
    email: { type: String, lowercase: true, trim: true, index: { unique: true, sparse: true } },
    passwordHash: String,
    name: String,
    platformRole: { type: String, default: null }, // super_admin | platform_support | platform_finance
    memberships: [MembershipSchema],
    status: { type: String, enum: ['active', 'blocked', 'deleted'], default: 'active' },
    blockedReason: String,
    language: { type: String, default: 'en' },
    gstin: String,
    businessName: String,
    vehicles: [VehicleSchema],
    favourites: [{ type: Types.ObjectId, ref: 'Charger' }],
    savedMethods: [{ kind: String, label: String, gatewayToken: String, addedAt: Date }], // token stored by gateway, never card data (PAY-14)
    notificationPrefs: { push: { type: Boolean, default: true }, sms: { type: Boolean, default: true }, whatsapp: { type: Boolean, default: false }, email: { type: Boolean, default: false } },
    pushTokens: [{ token: String, platform: String, valid: { type: Boolean, default: true } }],
    lastAmountPaise: Number,
    lastChargerId: { type: Types.ObjectId, ref: 'Charger' },
    fleet: { type: Types.ObjectId, ref: 'Fleet' },
    autopay: { mandateId: String, status: { type: String, enum: ['none', 'active', 'revoked'], default: 'none' }, maxPaise: Number },
    rfidCards: [{ uid: String, blocked: { type: Boolean, default: false }, addedAt: Date }],
    hostTenant: { type: Types.ObjectId, ref: 'Tenant' }, // Individual Host mode
    twoFactorEnabled: { type: Boolean, default: true },
    sessionVersion: { type: Number, default: 0 }, // bump to revoke tokens
    lastLoginAt: Date,
    deletedAt: Date,
  },
  { timestamps: true },
);

UserSchema.methods.membershipFor = function membershipFor(tenantId) {
  return this.memberships.find((m) => String(m.tenant) === String(tenantId));
};

UserSchema.methods.toPublic = function toPublic() {
  const o = this.toObject();
  delete o.passwordHash;
  delete o.savedMethods;
  delete o.pushTokens;
  return o;
};

// Per-number OTP state: current code, resend timing, wrong-attempt lockout (ACC-02..04).
const OtpStateSchema = new Schema(
  {
    phone: { type: String, required: true },
    purpose: { type: String, required: true }, // login | admin_2fa | change_phone | guest_stop | delete_account
    codeHash: String,
    expiresAt: Date,
    sentAt: Date,
    sends: [Date],
    wrongCount: { type: Number, default: 0 },
    lockedUntil: Date,
    meta: Schema.Types.Mixed,
  },
  { timestamps: true },
);
OtpStateSchema.index({ phone: 1, purpose: 1 }, { unique: true });

export const User = model('User', UserSchema);
export const OtpState = model('OtpState', OtpStateSchema);
