// All money is integer paise, all energy is integer Wh (= kWh to 3 decimals). BIL-03.
import { config } from '../config.js';

export const rupees = (paise) => Math.round(paise) / 100;
export const toPaise = (rs) => Math.round(Number(rs) * 100);
export const kwh = (wh) => Math.round(wh) / 1000;

// Half-up rounding for paise from a fractional value.
export const roundPaise = (x) => Math.round(x + Number.EPSILON);

/** GST on a taxable amount (paise), rounded per line. */
export function gstOn(taxablePaise, rateBps = config.gstRateBps) {
  return roundPaise((taxablePaise * rateBps) / 10000);
}

/** Split a GST-inclusive gross amount into taxable + gst so that taxable + gst === gross exactly. */
export function splitInclusive(grossPaise, rateBps = config.gstRateBps) {
  const taxable = roundPaise((grossPaise * 10000) / (10000 + rateBps));
  return { taxable, gst: grossPaise - taxable };
}

export const formatRs = (paise) => `Rs ${(paise / 100).toFixed(2)}`;
