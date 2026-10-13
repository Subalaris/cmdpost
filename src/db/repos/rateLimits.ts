import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { rateLimits } from '../schema';
import { nowIso } from '../client';

/**
 * Fixed-window rate limiter backed by D1.
 * Key convention: '<scope>:<subject>' e.g. 'magic:email:foo@bar.com',
 * 'magic:ip:1.2.3.4', 'scan:site:42', 'add:site:user:7'.
 *
 * isRateLimited(key, limit, windowMs) -> true when the subject already hit
 * the limit in the current window. Bump() increments on every attempt.
 */
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSec: number;
}

export async function rateLimitCheck(
  db: Db,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const nowIsoStr = nowIso();
  const windowStartCutoff = new Date(now - windowMs).toISOString();

  const row = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();

  // New or expired window -> start fresh.
  if (!row || row.windowStart < windowStartCutoff) {
    const inserted = await db
      .insert(rateLimits)
      .values({ key, windowStart: nowIsoStr, count: 1 })
      .onConflictDoUpdate({ target: rateLimits.key, set: { windowStart: nowIsoStr, count: 1 } })
      .returning()
      .get();
    return { allowed: true, count: inserted.count, limit, retryAfterSec: 0 };
  }

  if (row.count >= limit) {
    // window is `windowMs` from windowStart; report how long until it resets.
    const windowStartMs = Date.parse(row.windowStart);
    const retryAfterMs = Math.max(0, windowStartMs + windowMs - now);
    return {
      allowed: false,
      count: row.count,
      limit,
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
    };
  }

  const bumped = await db
    .update(rateLimits)
    .set({ count: sql`${rateLimits.count} + 1` })
    .where(eq(rateLimits.key, key))
    .returning()
    .get();
  return { allowed: true, count: bumped.count, limit, retryAfterSec: 0 };
}

/** Maintenance: prune old rate-limit rows (older than 24 h). */
export async function pruneRateLimits(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await db.delete(rateLimits).where(sql`${rateLimits.windowStart} < ${cutoff}`).run();
  return res.meta?.changes ?? 0;
}
