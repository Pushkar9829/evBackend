import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

// A roaming counterparty: an OCPI 2.2.1 platform or a UEI (Beckn) network participant.
const RoamingPartnerSchema = new Schema(
  {
    name: { type: String, required: true },
    protocol: { type: String, enum: ['ocpi', 'uei'], required: true },
    roles: { type: [String], default: ['EMSP'] }, // their roles: EMSP (roaming IN) / CPO (roaming OUT)
    countryCode: { type: String, default: 'IN' },
    partyId: String,
    status: { type: String, enum: ['pending', 'registered', 'suspended'], default: 'pending' },
    enabled: { type: Boolean, default: true }, // Admin 3.7: roaming on/off per partner
    // OCPI credentials
    tokenA: { type: String, index: true }, // we issue for their first registration call
    tokenB: String, // they gave us; we use it to call them
    tokenC: { type: String, index: true }, // we gave them after handshake; they use it to call us
    versionsUrl: String, // their versions endpoint
    endpoints: { type: Map, of: String, default: {} }, // module -> url (their side)
    // UEI / Beckn
    subscriberId: String,
    subscriberUrl: String,
    signingPublicKey: String,
    sharedSecret: String, // HMAC secret for the simple signing used in this build
    tenantsShared: [{ type: Types.ObjectId, ref: 'Tenant' }], // which tenants' chargers are published (empty = all roaming-enabled)
    tariffMarkupBps: { type: Number, default: 0 },
    settlement: { cycle: { type: String, default: 'monthly' }, marginBps: { type: Number, default: 0 } },
  },
  { timestamps: true },
);

const RoamingTokenSchema = new Schema(
  {
    partner: { type: Types.ObjectId, ref: 'RoamingPartner', index: true },
    uid: { type: String, required: true },
    type: { type: String, default: 'APP_USER' },
    contractId: String,
    issuer: String,
    valid: { type: Boolean, default: true },
    whitelist: { type: String, default: 'ALLOWED' },
    lastUpdated: Date,
    raw: Schema.Types.Mixed,
  },
  { timestamps: true },
);
RoamingTokenSchema.index({ partner: 1, uid: 1 }, { unique: true });

const CdrSchema = new Schema(
  {
    partner: { type: Types.ObjectId, ref: 'RoamingPartner', index: true },
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    session: { type: Types.ObjectId, ref: 'Session', index: true },
    direction: { type: String, enum: ['out', 'in'], default: 'out' }, // out = we are CPO; in = partner CPO billed us
    cdrId: { type: String, required: true, unique: true },
    data: Schema.Types.Mixed,
    totalCostPaise: Number,
    energyWh: Number,
    status: { type: String, enum: ['pending', 'sent', 'failed', 'acknowledged', 'received'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: String,
    month: String, // YYYY-MM for settlement
  },
  { timestamps: true },
);

const RoamingCommandSchema = new Schema(
  {
    partner: { type: Types.ObjectId, ref: 'RoamingPartner', index: true },
    command: String, // START_SESSION | STOP_SESSION | UNLOCK_CONNECTOR | RESERVE_NOW
    request: Schema.Types.Mixed,
    responseUrl: String,
    session: { type: Types.ObjectId, ref: 'Session' },
    status: { type: String, enum: ['received', 'accepted', 'rejected', 'result_sent', 'result_failed'], default: 'received' },
    result: String,
  },
  { timestamps: true },
);

const SettlementSchema = new Schema(
  {
    partner: { type: Types.ObjectId, ref: 'RoamingPartner', index: true },
    month: String,
    ourCdrCount: Number,
    ourTotalPaise: Number,
    theirTotalPaise: Number,
    theirCdrCount: Number,
    status: { type: String, enum: ['open', 'matched', 'disputed', 'invoiced', 'paid'], default: 'open' },
    disputedCdrIds: [String],
    notes: String,
    invoiceNumber: String,
  },
  { timestamps: true },
);
SettlementSchema.index({ partner: 1, month: 1 }, { unique: true });

// Locations from partner CPOs we can show to our drivers (roaming OUT / eMSP).
const PartnerLocationSchema = new Schema(
  {
    partner: { type: Types.ObjectId, ref: 'RoamingPartner', index: true },
    locationId: String,
    name: String,
    address: String,
    city: String,
    coordinates: { lat: Number, lng: Number },
    evses: [Schema.Types.Mixed],
    tariffs: [Schema.Types.Mixed],
    raw: Schema.Types.Mixed,
    lastUpdated: Date,
  },
  { timestamps: true },
);
PartnerLocationSchema.index({ partner: 1, locationId: 1 }, { unique: true });

// UEI (Beckn) transaction record: search -> select -> init -> confirm -> status -> update(stop)
const UeiOrderSchema = new Schema(
  {
    partner: { type: Types.ObjectId, ref: 'RoamingPartner' },
    transactionId: { type: String, index: true },
    orderId: { type: String, index: true },
    charger: { type: Types.ObjectId, ref: 'Charger' },
    connectorNumber: Number,
    session: { type: Types.ObjectId, ref: 'Session' },
    stage: String,
    quotePaise: Number,
    context: Schema.Types.Mixed,
  },
  { timestamps: true },
);

export const RoamingPartner = model('RoamingPartner', RoamingPartnerSchema);
export const RoamingToken = model('RoamingToken', RoamingTokenSchema);
export const Cdr = model('Cdr', CdrSchema);
export const RoamingCommand = model('RoamingCommand', RoamingCommandSchema);
export const Settlement = model('Settlement', SettlementSchema);
export const PartnerLocation = model('PartnerLocation', PartnerLocationSchema);
export const UeiOrder = model('UeiOrder', UeiOrderSchema);
