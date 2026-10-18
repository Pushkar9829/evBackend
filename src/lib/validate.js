import { z } from 'zod';
import { badRequest } from './errors.js';

export { z };

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest('VALIDATION', `${first.path.join('.') || 'input'}: ${first.message}`, r.error.issues);
  }
  return r.data;
}

export const phoneSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, ''))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'Enter a valid 10-digit Indian mobile number');

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
