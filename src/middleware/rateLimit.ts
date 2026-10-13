import type { Context, Next } from 'hono';
import { makeDb } from '../db/client';
import { rateLimitCheck } from '../db/repos/rateLimits';
import type { Env } from '../env';

export interface RateLimitOptions {
  /** key prefix, e.g. 'magic:email' */
  prefix: string;
  limit: number;
  windowMs: number;
}

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * D1-backed fixed-window rate limiter (see repos/rateLimits).
 * Responds 429 with Retry-After when the limit is exceeded.
 */
export function rateLimit(opts: RateLimitOptions, subject: (c: Context) => string | undefined) {
  return async (c: Context, next: Next) => {
    const s = subject(c);
    if (!s) {
      await next();
      return;
    }
    const env: Env = c.env;
    const db = makeDb(env);
    const result = await rateLimitCheck(db, `${opts.prefix}:${s}`, opts.limit, opts.windowMs);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSec));
      return c.json({ error: 'Too many requests. Try again later.' }, 429);
    }
    c.set('rateLimitCount', result.count);
    await next();
  };
}
