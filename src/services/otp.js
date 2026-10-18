import crypto from 'node:crypto';
import { OtpState } from '../models/index.js';
import { config } from '../config.js';
import { sha256 } from '../lib/util.js';
import { badRequest, tooMany } from '../lib/errors.js';
import { sendOtpSms } from './notifications.js';
import { logger, maskPhone } from '../lib/logger.js';

const hashCode = (phone, purpose, code) => sha256(`${phone}|${purpose}|${code}|${config.jwtSecret}`);

/** Send an OTP with resend spacing (30 s), hourly cap (5) and lockout awareness (ACC-02..05). */
export async function requestOtp(phone, purpose = 'login', { channel = 'sms', lang = 'en', meta } = {}) {
  const { otp } = config;
  const nowMs = Date.now();
  let state = await OtpState.findOne({ phone, purpose });
  if (!state) state = new OtpState({ phone, purpose, sends: [] });

  if (state.lockedUntil && state.lockedUntil.getTime() > nowMs) {
    const mins = Math.ceil((state.lockedUntil.getTime() - nowMs) / 60000);
    throw tooMany(`Too many wrong attempts. Try again in ${mins} min.`, { lockedUntil: state.lockedUntil });
  }
  const lastHour = (state.sends || []).filter((d) => nowMs - new Date(d).getTime() < 3600_000);
  if (lastHour.length >= otp.maxPerHour) {
    throw tooMany('You have requested too many codes. Please try again in an hour.', { retryAfterSec: 3600 });
  }
  if (state.sentAt && nowMs - state.sentAt.getTime() < otp.resendAfterSec * 1000) {
    const wait = Math.ceil(otp.resendAfterSec - (nowMs - state.sentAt.getTime()) / 1000);
    throw tooMany(`Please wait ${wait} s before requesting a new code.`, { retryAfterSec: wait });
  }

  const code = otp.demoCode || String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  state.codeHash = hashCode(phone, purpose, code);
  state.expiresAt = new Date(nowMs + otp.ttlSec * 1000);
  state.sentAt = new Date(nowMs);
  state.sends = [...lastHour, new Date(nowMs)];
  if (meta) state.meta = meta;
  await state.save();

  await sendOtpSms(phone, code, lang, channel);

  return {
    sent: true,
    channel,
    expiresInSec: otp.ttlSec,
    resendAfterSec: otp.resendAfterSec,
    fallbackChannels: ['whatsapp', 'voice'], // offered by the UI after 30 s (ACC-05)
    ...(otp.demoCode ? { demo: true } : {}),
  };
}

export async function verifyOtp(phone, purpose, code) {
  const { otp } = config;
  const state = await OtpState.findOne({ phone, purpose });
  const nowMs = Date.now();
  if (state?.lockedUntil && state.lockedUntil.getTime() > nowMs) {
    throw tooMany('Too many wrong attempts. Your number is locked for 15 minutes.', { lockedUntil: state.lockedUntil });
  }
  if (!state?.codeHash) throw badRequest('OTP_NOT_REQUESTED', 'Please request a code first.');
  if (state.expiresAt.getTime() < nowMs) throw badRequest('OTP_EXPIRED', 'OTP expired, resend?');

  if (hashCode(phone, purpose, String(code).trim()) !== state.codeHash) {
    state.wrongCount += 1;
    if (state.wrongCount >= otp.maxWrong) {
      state.lockedUntil = new Date(nowMs + otp.lockMinutes * 60_000);
      state.codeHash = undefined;
      state.wrongCount = 0;
      await state.save();
      throw tooMany('Too many wrong attempts. Your number is locked for 15 minutes.', { lockedUntil: state.lockedUntil });
    }
    await state.save();
    throw badRequest('OTP_WRONG', `That code is not correct. ${otp.maxWrong - state.wrongCount} attempts left.`, { attemptsLeft: otp.maxWrong - state.wrongCount });
  }

  const meta = state.meta;
  state.codeHash = undefined;
  state.wrongCount = 0;
  state.lockedUntil = undefined;
  state.meta = undefined;
  await state.save();
  return { ok: true, meta };
}
