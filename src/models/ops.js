import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

// Permanent audit log: who, what, before/after, reason, IP, time. Cannot be edited or deleted (Admin 3.8).
const AuditLogSchema = new Schema({
  actor: { type: Types.ObjectId, ref: 'User' },
  actorName: String,
  actorRole: String,
  tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
  action: { type: String, index: true },
  entity: String,
  entityId: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  reason: String,
  ip: String,
  at: { type: Date, default: Date.now, index: true },
});
const immutable = function blockMutation(next) {
  next(new Error('Audit log entries are permanent and cannot be modified'));
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'deleteOne', 'deleteMany', 'findOneAndReplace', 'replaceOne']) {
  AuditLogSchema.pre(op, immutable);
}
AuditLogSchema.pre('save', function onlyNew(next) {
  if (!this.isNew) return next(new Error('Audit log entries are permanent and cannot be modified'));
  return next();
});

// Maker-checker approvals for risky actions.
const ApprovalSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    type: { type: String, required: true }, // refund | payout_hold | payout_release | adjustment | bulk_firmware | commission | critical_config | force_close
    payload: Schema.Types.Mixed,
    summary: String,
    amountPaise: Number,
    reason: String,
    requestedBy: { type: Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'executed', 'failed'], default: 'pending', index: true },
    decidedBy: { type: Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: String,
    result: Schema.Types.Mixed,
    scope: { type: String, enum: ['tenant', 'platform'], default: 'tenant' },
  },
  { timestamps: true },
);

const AlertSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    type: { type: String, index: true }, // charger_offline | charger_fault | failed_session | payment_failure | refund_failure | reconciliation | security | stale_meter | late_start | gateway_down | stop_rejected
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
    charger: { type: Types.ObjectId, ref: 'Charger' },
    session: { type: Types.ObjectId, ref: 'Session' },
    message: String,
    data: Schema.Types.Mixed,
    status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
    dedupeKey: { type: String, index: true },
    count: { type: Number, default: 1 },
    lastAt: { type: Date, default: Date.now },
    resolvedBy: { type: Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

const ComplaintSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    session: { type: Types.ObjectId, ref: 'Session' },
    charger: { type: Types.ObjectId, ref: 'Charger' },
    driver: { type: Types.ObjectId, ref: 'User' },
    phone: String,
    category: { type: String, enum: ['did_not_start', 'overcharged', 'stopped_early', 'refund_missing', 'spot_blocked', 'charger_damaged', 'app_issue', 'other'], default: 'other' },
    description: String,
    status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
    autoDetected: { type: Boolean, default: false },
    slaDueAt: Date,
    resolvedAt: Date,
    resolution: String,
    notes: [{ by: { type: Types.ObjectId, ref: 'User' }, text: String, at: Date, _id: false }],
    refund: { type: Types.ObjectId, ref: 'Refund' },
  },
  { timestamps: true },
);

const NotificationSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: 'User', index: true },
    phone: String,
    session: { type: Types.ObjectId, ref: 'Session', index: true },
    channel: { type: String, enum: ['push', 'sms', 'whatsapp', 'email', 'inapp'] },
    template: String,
    lang: String,
    body: String,
    eventAt: Date, // logical time of the event, used to keep ordering (NOT-03)
    status: { type: String, enum: ['sent', 'failed', 'blocked', 'suppressed'], default: 'sent' },
    error: String,
    dedupeKey: { type: String, index: { unique: true, sparse: true } },
  },
  { timestamps: true },
);

const SecurityEventSchema = new Schema({
  type: { type: String, index: true },
  ip: String,
  details: Schema.Types.Mixed,
  tenant: { type: Types.ObjectId, ref: 'Tenant' },
  at: { type: Date, default: Date.now, index: true },
});

// Data rights requests (DPDP Act): export or deletion, tracked to completion (Admin 3.4).
const DataRequestSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: 'User' },
    phone: String, // guests (no account) are identified by their verified phone number
    kind: { type: String, enum: ['delete', 'export'], default: 'delete' },
    status: { type: String, enum: ['received', 'in_progress', 'completed', 'rejected'], default: 'received', index: true },
    source: { type: String, enum: ['self_service', 'driver_request', 'guest_request', 'support'], default: 'driver_request' },
    reason: String,
    notes: String,
    dueAt: Date,
    handledBy: { type: Types.ObjectId, ref: 'User' },
    history: [{ status: String, at: Date, by: { type: Types.ObjectId, ref: 'User' }, note: String, _id: false }],
    result: Schema.Types.Mixed,
    completedAt: Date,
  },
  { timestamps: true },
);

export const AuditLog = model('AuditLog', AuditLogSchema);
export const Approval = model('Approval', ApprovalSchema);
export const Alert = model('Alert', AlertSchema);
export const Complaint = model('Complaint', ComplaintSchema);
export const Notification = model('Notification', NotificationSchema);
export const SecurityEvent = model('SecurityEvent', SecurityEventSchema);
export const DataRequest = model('DataRequest', DataRequestSchema);
