import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4410),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ev_charging',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtTtl: process.env.JWT_TTL || '12h',
  // Comma-separated list of allowed browser origins (Vercel URL in production).
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5410').split(',').map((s) => s.trim()).filter(Boolean),
  // Public URLs, used in QR codes, SMS links and the OCPP endpoint shown to technicians.
  publicWebUrl: process.env.PUBLIC_WEB_URL || 'http://localhost:5410',
  publicApiUrl: process.env.PUBLIC_API_URL || 'http://localhost:4410',

  otp: {
    // When set, every OTP equals this code and SMS sending is mocked (console log).
    demoCode: process.env.DEMO_OTP_CODE || '',
    ttlSec: 300,
    resendAfterSec: 30,
    maxPerHour: 5,
    maxWrong: 5,
    lockMinutes: 15,
  },

  payments: {
    provider: process.env.PAYMENT_PROVIDER || 'mock', // mock | razorpay
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || 'mock-webhook-secret',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
    pendingTimeoutSec: 300, // PAY-04
    pollEverySec: 15, // PAY-12
    minAmountPaise: 5000, // PAY-13: Rs 50
    maxAmountPaise: num(process.env.MAX_SESSION_AMOUNT_PAISE, 500000),
  },

  sms: {
    provider: process.env.SMS_PROVIDER || 'mock', // mock | msg91
    msg91AuthKey: process.env.MSG91_AUTH_KEY || '',
  },

  charging: {
    plugInWindowSec: num(process.env.PLUG_IN_WINDOW_SEC, 120), // STA-02
    startTimeoutSec: num(process.env.START_TIMEOUT_SEC, 60), // STA-04
    noEnergyStopSec: num(process.env.NO_ENERGY_STOP_SEC, 300), // STA-08
    staleMeterWarnSec: 600, // CHG-02
    offlineFinaliseHours: 24, // CHG-06
    zeroPowerNotifySec: 600, // CHG-11
    overrunToleranceWh: 200, // CHG-10
    heartbeatIntervalSec: 300,
    statusStaleSec: 60, // DIS-02
  },

  gstRateBps: num(process.env.GST_RATE_BPS, 1800), // 18.00% [Confirm with CA]
  refundMaxAttempts: 3,
  ocppLogRetentionDays: 90,
  jobsEnabled: bool(process.env.JOBS_ENABLED, true),
  // OCPI identity for our platform when acting as eMSP
  ocpi: {
    countryCode: process.env.OCPI_COUNTRY || 'IN',
    platformPartyId: process.env.OCPI_PARTY_ID || 'CHX',
  },
};

export const isTest = config.env === 'test';
