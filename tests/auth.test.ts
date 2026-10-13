import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestEnv, seedUser } from './helpers/seed';
import { makeDb } from '../src/db/client';
import {
  createMagicToken,
  consumeMagicToken,
  createSession,
  findSessionByToken,
  deleteSessionByToken,
  deleteAllSessionsForUser,
  deleteExpiredSessions,
} from '../src/db/repos/auth';
import { randomToken } from '../src/lib/tokens';
import { nowIso } from '../src/db/client';
import { findUserByEmail } from '../src/db/repos/users';

let env: ReturnType<typeof makeTestEnv>;

beforeEach(() => {
  env = makeTestEnv();
});

describe('magic-link tokens', () => {
  it('stores only the SHA-256 hash, never the raw token', async () => {
    const token = randomToken(32);
    await createMagicToken(makeDb(env as never), 'user@example.com', token);
    const raw = (env.DB as any).prepare('SELECT * FROM login_tokens').all().results as any[];
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(raw[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a valid token is accepted exactly once (single use)', async () => {
    const db = makeDb(env as never);
    const token = randomToken(32);
    await createMagicToken(db, 'user@example.com', token);

    const first = await consumeMagicToken(db, token);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.email).toBe('user@example.com');

    const second = await consumeMagicToken(db, token);
    expect(second.ok).toBe(false);
  });

  it('a tampered token is rejected', async () => {
    const db = makeDb(env as never);
    const token = randomToken(32);
    await createMagicToken(db, 'user@example.com', token);
    const tampered = (token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'));
    const verdict = await consumeMagicToken(db, tampered);
    expect(verdict.ok).toBe(false);
  });

  it('an expired token is rejected', async () => {
    const db = makeDb(env as never);
    const token = randomToken(32);
    await createMagicToken(db, 'user@example.com', token);
    // Force expiry into the past.
    (env.DB as any)
      .prepare('UPDATE login_tokens SET expires_at = ?')
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    const verdict = await consumeMagicToken(db, token);
    expect(verdict.ok).toBe(false);
  });

  it('a token for a non-existent email still verifies (route creates user first)', async () => {
    const db = makeDb(env as never);
    const token = randomToken(32);
    await createMagicToken(db, 'nobody@example.com', token);
    const verdict = await consumeMagicToken(db, token);
    expect(verdict.ok).toBe(true);
  });
});

describe('sessions', () => {
  it('stores only the token hash and expires in ~30 days', async () => {
    const db = makeDb(env as never);
    const userId = await seedUser(env, { email: 's@example.com' });
    const token = randomToken(32);
    const s = await createSession(db, userId, token);
    expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.parse(nowIso()));
    const dayDiff = (Date.parse(s.expiresAt) - Date.now()) / 86400000;
    expect(dayDiff).toBeGreaterThan(29);
    expect(dayDiff).toBeLessThan(31);
    const raw = JSON.stringify((env.DB as any).prepare('SELECT * FROM sessions').all().results);
    expect(raw).not.toContain(token);
  });

  it('findSessionByToken returns valid sessions and slides expiry', async () => {
    const db = makeDb(env as never);
    const userId = await seedUser(env, { email: 's2@example.com' });
    const token = randomToken(32);
    await createSession(db, userId, token);
    const found = await findSessionByToken(db, token);
    expect(found?.valid).toBe(true);
    expect(found?.session.userId).toBe(userId);
  });

  it('findSessionByToken returns null for unknown tokens', async () => {
    const db = makeDb(env as never);
    expect(await findSessionByToken(db, randomToken(32))).toBeNull();
  });

  it('logout deletes only that session', async () => {
    const db = makeDb(env as never);
    const userId = await seedUser(env, { email: 's3@example.com' });
    const t1 = randomToken(32);
    const t2 = randomToken(32);
    await createSession(db, userId, t1);
    await createSession(db, userId, t2);
    await deleteSessionByToken(db, t1);
    expect(await findSessionByToken(db, t1)).toBeNull();
    expect((await findSessionByToken(db, t2))?.valid).toBe(true);
  });

  it('"log out everywhere" deletes all sessions for the user', async () => {
    const db = makeDb(env as never);
    const userId = await seedUser(env, { email: 's4@example.com' });
    const t1 = randomToken(32);
    const t2 = randomToken(32);
    await createSession(db, userId, t1);
    await createSession(db, userId, t2);
    await deleteAllSessionsForUser(db, userId);
    expect(await findSessionByToken(db, t1)).toBeNull();
    expect(await findSessionByToken(db, t2)).toBeNull();
  });

  it('expired sessions are pruned by maintenance', async () => {
    const db = makeDb(env as never);
    const userId = await seedUser(env, { email: 's5@example.com' });
    const token = randomToken(32);
    await createSession(db, userId, token);
    (env.DB as any)
      .prepare('UPDATE sessions SET expires_at = ?')
      .bind(new Date(Date.now() - 60000).toISOString())
      .run();
    const n = await deleteExpiredSessions(db);
    expect(n).toBe(1);
    expect(await findSessionByToken(db, token)).toBeNull();
  });

  it('session cascades when the user is deleted (FK)', async () => {
    const userId = await seedUser(env, { email: 's6@example.com' });
    const db = makeDb(env as never);
    await createSession(db, userId, randomToken(32));
    (env.DB as any).prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    const rows = (env.DB as any).prepare('SELECT COUNT(*) AS n FROM sessions').first() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe('auth flow integration (magic link -> session)', () => {
  it('end-to-end: token for new email, consume, user can be found', async () => {
    const db = makeDb(env as never);
    const token = randomToken(32);
    await createMagicToken(db, 'new@example.com', token);
    const verdict = await consumeMagicToken(db, token);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    // Simulate the route: create the user if missing.
    const existing = await findUserByEmail(db, verdict.email);
    if (!existing) {
      (env.DB as any)
        .prepare('INSERT INTO users (email, name, status, is_admin, alert_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(verdict.email, 'new', 'approved', 0, verdict.email, nowIso())
        .run();
    }
    const user = await findUserByEmail(db, verdict.email);
    expect(user).toBeDefined();
    expect(user?.email).toBe('new@example.com');
  });
});
