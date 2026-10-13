import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { sessions, loginTokens } from '../schema';
import { nowIso } from '../client';
import { sha256hex } from '../../lib/tokens';

export type SessionRow = typeof sessions.$inferSelect;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAGIC_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------- sessions

export interface StoredSession {
  token: string; // plaintext — set in the cookie, NEVER persisted
  userId: number;
  expiresAt: string;
}

/**
 * Create a new session. Returns the raw token to put in the cookie;
 * only the SHA-256 hash is stored.
 */
export async function createSession(
  db: Db,
  userId: number,
  token: string,
): Promise<StoredSession> {
  const expiresAt = nowIso(new Date(Date.now() + SESSION_TTL_MS));
  await db
    .insert(sessions)
    .values({ userId, tokenHash: await sha256hex(token), expiresAt, createdAt: nowIso() })
    .run();
  return { token, userId, expiresAt };
}

/** Sliding expiry: extend the session by 30 days from now. */
export async function extendSession(db: Db, tokenHash: string): Promise<void> {
  await db
    .update(sessions)
    .set({ expiresAt: nowIso(new Date(Date.now() + SESSION_TTL_MS)) })
    .where(eq(sessions.tokenHash, tokenHash))
    .run();
}

export async function findSessionByToken(db: Db, token: string): Promise<{ session: SessionRow; valid: boolean } | null> {
  const hash = await sha256hex(token);
  const session = await db.select().from(sessions).where(eq(sessions.tokenHash, hash)).get();
  if (!session) return null;
  const valid = session.expiresAt > nowIso();
  return { session, valid };
}

export async function deleteSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, await sha256hex(token))).run();
}

/** "Log out everywhere" — every session of the user. */
export async function deleteAllSessionsForUser(db: Db, userId: number): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/** Maintenance: delete expired sessions. */
export async function deleteExpiredSessions(db: Db): Promise<number> {
  const now = nowIso();
  const res = await db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} < ${now}`)
    .run();
  return res.meta?.changes ?? 0;
}

// ----------------------------------------------------------- login tokens

export interface MagicTokenResult {
  token: string;
  email: string;
  expiresAt: string;
}

/** Create a single-use magic link token for an email (user need not exist yet). */
export async function createMagicToken(db: Db, email: string, token: string): Promise<MagicTokenResult> {
  const expiresAt = nowIso(new Date(Date.now() + MAGIC_TOKEN_TTL_MS));
  await db
    .insert(loginTokens)
    .values({ email: email.toLowerCase().trim(), tokenHash: await sha256hex(token), expiresAt })
    .run();
  return { token, email: email.toLowerCase().trim(), expiresAt };
}

export type MagicTokenVerdict =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/**
 * Verify a magic token. Single-use: on success the token is consumed
 * (used_at set), so replaying it fails with 'used'.
 * All three failure reasons are indistinguishable to the caller by design
 * (the route always responds identically).
 */
export async function consumeMagicToken(db: Db, token: string): Promise<MagicTokenVerdict> {
  const hash = await sha256hex(token);
  const row = await db.select().from(loginTokens).where(eq(loginTokens.tokenHash, hash)).get();
  if (!row || row.usedAt !== null || row.expiresAt <= nowIso()) {
    // 'invalid' covers all three: missing, used, or expired. Indistinguishable.
    return { ok: false, reason: 'invalid' };
  }
  await db.update(loginTokens).set({ usedAt: nowIso() }).where(eq(loginTokens.tokenHash, hash)).run();
  return { ok: true, email: row.email };
}

/** Maintenance: purge expired + used tokens. */
export async function deleteExpiredLoginTokens(db: Db): Promise<number> {
  const now = nowIso();
  const res = await db
    .delete(loginTokens)
    .where(sql`(${loginTokens.expiresAt} < ${now} OR ${loginTokens.usedAt} IS NOT NULL)`)
    .run();
  return res.meta?.changes ?? 0;
}
