// Must be imported before anything from src/ so config picks these up.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/ev_charging_test';
process.env.DEMO_OTP_CODE = '123456';
process.env.JOBS_ENABLED = 'false';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.SMS_PROVIDER = 'mock';
process.env.PLUG_IN_WINDOW_SEC = '2';
process.env.START_TIMEOUT_SEC = '2';
process.env.NO_ENERGY_STOP_SEC = '2';
process.env.CORS_ORIGINS = '*';
