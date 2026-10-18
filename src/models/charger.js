import mongoose from 'mongoose';
import { config } from '../config.js';

const { Schema, model, Types } = mongoose;

export const CONNECTOR_TYPES = ['CCS2', 'Type2', 'Bharat_AC001', 'Bharat_DC001', 'LEV_DC', 'Type6', 'CHAdeMO', 'GBT', 'Type1', '3PIN'];
export const CONNECTOR_STATUSES = ['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted'];

const ConnectorSchema = new Schema(
  {
    number: { type: Number, required: true }, // public connector number printed on the charger / QR
    evseId: { type: Number, required: true }, // OCPP 2.0.1 EVSE
    connectorId: { type: Number, default: 1 }, // connector within the EVSE
    type: { type: String, enum: CONNECTOR_TYPES, default: 'Type2' },
    powerType: { type: String, enum: ['AC', 'DC'], default: 'AC' },
    maxPowerKw: { type: Number, default: 7.4 },
    vehicleTypes: { type: [String], default: ['car'] }, // 2W / 3W / car
    status: { type: String, enum: CONNECTOR_STATUSES, default: 'Unavailable' },
    statusAt: Date,
    // raw 1.6 status (Preparing/Charging/SuspendedEV/Finishing...) kept for diagnostics
    rawStatus: String,
    errorCode: String,
    activeSession: { type: Types.ObjectId, ref: 'Session', default: null }, // connector lock: first confirmed payment wins (PAY-10)
    reservedUntil: Date,
    tariffKey: String, // optional connector-level tariff override
  },
  { _id: false },
);

const ChargerSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', required: true, index: true },
    site: { type: Types.ObjectId, ref: 'Site', required: true, index: true },
    ocppId: { type: String, required: true, unique: true, trim: true },
    label: String,
    passwordHash: String,
    protocol: { type: String, enum: ['ocpp2.0.1', 'ocpp1.6'], default: 'ocpp2.0.1' },
    vendor: String,
    model: String,
    serial: String,
    firmware: String,
    connectors: [ConnectorSchema],
    online: { type: Boolean, default: false },
    lastSeen: Date,
    connectedAt: Date,
    bootedAt: Date,
    bootStatus: String,
    inService: { type: Boolean, default: true }, // ChangeAvailability / maintenance mode
    readyForPublic: { type: Boolean, default: false }, // after automatic onboarding test
    onboardingReport: Schema.Types.Mixed,
    tariffKey: String,
    roamingEnabled: { type: Boolean, default: false },
    roamingEnabledAt: Date,
    roamingChangedAt: Date,
    uptime: { onlineSeconds: { type: Number, default: 0 }, windowStart: Date, lastTransitionAt: Date, scorePct: { type: Number, default: 100 } },
    lastSuccessfulChargeAt: Date,
    qualityScore: { type: Number, default: 100 },
    rating: { avg: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    photos: [String],
    authFailures: { type: Number, default: 0 },
    lastAuthFailureAt: Date,
    localAuthListVersion: { type: Number, default: 0 },
    configCache: Schema.Types.Mixed,
    isSimulated: { type: Boolean, default: false },
    deletedAt: Date,
    // Clock skew between the charger's timestamps and ours, in seconds (RES-07)
    clockSkewSec: Number,
  },
  { timestamps: true },
);

ChargerSchema.methods.connector = function connector(number) {
  return this.connectors.find((c) => c.number === Number(number));
};
ChargerSchema.methods.connectorByEvse = function connectorByEvse(evseId, connectorId) {
  return this.connectors.find((c) => c.evseId === Number(evseId) && (connectorId === undefined || c.connectorId === Number(connectorId)))
    || this.connectors.find((c) => c.evseId === Number(evseId));
};

// Per-model profile for brand quirks, plus kill switch for known-bad firmware (Admin 3.7).
const ChargerModelSchema = new Schema(
  {
    vendor: { type: String, required: true },
    model: { type: String, required: true },
    quirks: {
      meterIncludesStartValue: { type: Boolean, default: true },
      sendsWhAsKwh: { type: Boolean, default: false },
      noRemoteStartAuthorize: { type: Boolean, default: false },
      meterIntervalSec: { type: Number, default: 30 },
    },
    blocked: { type: Boolean, default: false },
    blockedFirmware: [String],
    notes: String,
  },
  { timestamps: true },
);
ChargerModelSchema.index({ vendor: 1, model: 1 }, { unique: true });

const OcppMessageSchema = new Schema({
  ocppId: { type: String, index: true },
  charger: { type: Types.ObjectId, ref: 'Charger' },
  tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
  direction: { type: String, enum: ['in', 'out'] },
  messageType: Number, // 2 CALL, 3 CALLRESULT, 4 CALLERROR
  action: String,
  uniqueId: String,
  payload: Schema.Types.Mixed,
  at: { type: Date, default: Date.now },
});
OcppMessageSchema.index({ at: 1 }, { expireAfterSeconds: config.ocppLogRetentionDays * 86400 });
OcppMessageSchema.index({ ocppId: 1, at: -1 });

// Every command shows its live result: Accepted, Rejected or Timed out (Admin 3.3).
const CommandLogSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    charger: { type: Types.ObjectId, ref: 'Charger', index: true },
    ocppId: String,
    action: String,
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['pending', 'Accepted', 'Rejected', 'TimedOut', 'Offline', 'Error', 'Queued'], default: 'pending' },
    response: Schema.Types.Mixed,
    requestedBy: { type: Types.ObjectId, ref: 'User' },
    reason: String,
    bulkId: String,
    stage: String,
  },
  { timestamps: true },
);

const ReservationSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant', index: true },
    charger: { type: Types.ObjectId, ref: 'Charger', index: true },
    connectorNumber: Number,
    user: { type: Types.ObjectId, ref: 'User' },
    reservationId: Number,
    expiresAt: Date,
    status: { type: String, enum: ['pending', 'active', 'used', 'cancelled', 'expired', 'rejected'], default: 'pending' },
  },
  { timestamps: true },
);

const FirmwareRolloutSchema = new Schema(
  {
    tenant: { type: Types.ObjectId, ref: 'Tenant' },
    filter: Schema.Types.Mixed,
    location: String,
    version: String,
    stage: { type: String, enum: ['pending_approval', 'stage1', 'stage10', 'all', 'done', 'cancelled'], default: 'pending_approval' },
    chargerIds: [{ type: Types.ObjectId, ref: 'Charger' }],
    done: [{ type: Types.ObjectId, ref: 'Charger' }],
    sentTo: [String],
    approval: { type: Types.ObjectId, ref: 'Approval' },
    requestedBy: { type: Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Charger = model('Charger', ChargerSchema);
export const ChargerModel = model('ChargerModel', ChargerModelSchema);
export const OcppMessage = model('OcppMessage', OcppMessageSchema);
export const CommandLog = model('CommandLog', CommandLogSchema);
export const Reservation = model('Reservation', ReservationSchema);
export const FirmwareRollout = model('FirmwareRollout', FirmwareRolloutSchema);
