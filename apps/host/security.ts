import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../packages/exam-core/model.ts';

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [method, salt, hex] = stored.split(':');
  if (method !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await derive(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class RateLimiter {
  entries = new Map<string, { count: number; reset: number }>();
  take(key: string, limit: number, windowMs: number, now = Date.now()) {
    if (this.entries.size > 10000) {
      for (const [id, entry] of this.entries) if (entry.reset <= now) this.entries.delete(id);
      if (this.entries.size > 10000)
        throw new DomainError('Too many requests. Try again shortly.', 429, 'RATE_LIMIT');
    }
    const current = this.entries.get(key);
    if (!current || current.reset <= now) {
      this.entries.set(key, { count: 1, reset: now + windowMs });
      return;
    }
    current.count++;
    if (current.count > limit)
      throw new DomainError('Too many attempts. Try again later.', 429, 'RATE_LIMIT');
  }
}
