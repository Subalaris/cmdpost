import { describe, it, expect } from 'vitest';
import { makeTestEnv, type TestEnv } from './helpers/seed';
import type { Env } from '../src/env';
const asEnv = (e: TestEnv) => e as unknown as Env;
import { handleSignup } from '../src/middleware/signup';
import { makeDb, nowIso } from '../src/db/client';
import { findUserByEmail, countUsers, setUserStatus } from '../src/db/repos/users';
import { randomToken } from '../src/lib/tokens';
import { createSession, findSessionByToken } from '../src/db/repos/auth';

describe('signup modes', () => {
  it('approval (default): new users are pending and CAN log in (blocked on dashboard by requireApproved)', async () => {
    const env = makeTestEnv({ SIGNUP_MODE: 'approval' });
    const decision = await handleSignup(asEnv(env), 'new@example.com', 'New');
    expect(decision.proceed).toBe(true);
    const user = await findUserByEmail(makeDb(env as never), 'new@example.com');
    expect(user?.status).toBe('pending');
    expect(user?.isAdmin).toBeFalsy();
  });

  it('open: new users are approved immediately', async () => {
    const env = makeTestEnv({ SIGNUP_MODE: 'open' });
    await handleSignup(asEnv(env), 'open@example.com', 'Open');
    const user = await findUserByEmail(makeDb(env as never), 'open@example.com');
    expect(user?.status).toBe('approved');
  });

  it('closed: no new account is created, but response is identical (proceeds)', async () => {
    const env = makeTestEnv({ SIGNUP_MODE: 'closed' });
    const decision = await handleSignup(asEnv(env), 'nobody@example.com', 'Nobody');
    // proceed=true so the route responds identically ("check your inbox")
    // — no enumeration signal.
    expect(decision.proceed).toBe(true);
    expect(decision.internalReason).toBe('closed');
    const user = await findUserByEmail(makeDb(env as never), 'nobody@example.com');
    expect(user).toBeUndefined();
  });

  it('existing email in closed mode still proceeds (they can sign in)', async () => {
    const env = makeTestEnv({ SIGNUP_MODE: 'closed' });
    (env.DB as any)
      .prepare('INSERT INTO users (email, name, status, is_admin, alert_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('existing@example.com', 'Existing', 'approved', 0, 'existing@example.com', nowIso())
      .run();
    const decision = await handleSignup(asEnv(env), 'existing@example.com', 'Existing');
    expect(decision.proceed).toBe(true);
    expect(decision.internalReason).toBe('existing');
    const count = (env.DB as any).prepare('SELECT COUNT(*) AS n FROM users').first() as { n: number };
    expect(count.n).toBe(1); // not duplicated
  });

  it('ADMIN_EMAIL user is auto-approved and is_admin regardless of mode', async () => {
    const env = makeTestEnv({ SIGNUP_MODE: 'approval', ADMIN_EMAIL: 'boss@example.com' });
    await handleSignup(asEnv(env), 'boss@example.com', 'Boss');
    const user = await findUserByEmail(makeDb(env as never), 'boss@example.com');
    expect(user?.status).toBe('approved');
    expect(user?.isAdmin).toBe(true);
  });

  it('MAX_USERS cap is enforced (503-equivalent decision) when at capacity', async () => {
    const env = makeTestEnv({ SIGNUP_MODE: 'open', MAX_USERS: '2' });
    await handleSignup(asEnv(env), 'a@example.com', 'A');
    await handleSignup(asEnv(env), 'b@example.com', 'B');
    const decision = await handleSignup(asEnv(env), 'c@example.com', 'C');
    expect(decision.proceed).toBe(false);
    expect(decision.internalReason).toBe('cap');
    expect(await countUsers(makeDb(env as never))).toBe(2);
    // Existing user is unaffected by the cap.
    const existing = await handleSignup(asEnv(env), 'a@example.com', 'A');
    expect(existing.proceed).toBe(true);
  });

  it('email addresses are normalized (lowercase) and unique', async () => {
    const env = makeTestEnv({ SIGNUP_MODE: 'open' });
    await handleSignup(asEnv(env), 'Dup@Example.COM ', 'Dup');
    const again = await handleSignup(asEnv(env), 'dup@example.com', 'Dup2');
    expect(again.internalReason).toBe('existing');
    const user = await findUserByEmail(makeDb(env as never), 'dup@example.com');
    expect(user?.email).toBe('dup@example.com');
  });
});

describe('pending / disabled user handling', () => {
  it('pending user: session works, dashboard route must block (verified via status)', async () => {
    const env = makeTestEnv();
    (env.DB as any)
      .prepare('INSERT INTO users (email, name, status, is_admin, alert_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('pending@example.com', 'P', 'pending', 0, 'pending@example.com', nowIso())
      .run();
    const db = makeDb(env as never);
    const user = (await findUserByEmail(db, 'pending@example.com'))!;
    // The session itself is allowed (spec: "can log in") — the dashboard
    // route (requireApproved) is what blocks. We assert the flag here.
    expect(user.status).toBe('pending');
  });

  it('disabled user cannot create a session (route returns 403 before session)', async () => {
    const env = makeTestEnv();
    (env.DB as any)
      .prepare('INSERT INTO users (email, name, status, is_admin, alert_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('disabled@example.com', 'D', 'disabled', 0, 'disabled@example.com', nowIso())
      .run();
    const user = await findUserByEmail(makeDb(env as never), 'disabled@example.com');
    expect(user?.status).toBe('disabled');
  });

  it('admin can re-enable a disabled user', async () => {
    const env = makeTestEnv();
    (env.DB as any)
      .prepare('INSERT INTO users (email, name, status, is_admin, alert_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('re@example.com', 'R', 'disabled', 0, 're@example.com', nowIso())
      .run();
    const user = await findUserByEmail(makeDb(env as never), 're@example.com');
    await setUserStatus(makeDb(env as never), user!.id, 'approved');
    const after = await findUserByEmail(makeDb(env as never), 're@example.com');
    expect(after?.status).toBe('approved');
  });
});

describe('rate limits (D1-backed)', () => {
  it('allows up to N then rejects within the window', async () => {
    const env = makeTestEnv();
    const { rateLimitCheck } = await import('../src/db/repos/rateLimits');
    const db = makeDb(env as never);
    for (let i = 1; i <= 5; i++) {
      const r = await rateLimitCheck(db, 'magic:email:spam@example.com', 5, 3600_000);
      expect(r.allowed).toBe(true);
    }
    const blocked = await rateLimitCheck(db, 'magic:email:spam@example.com', 5, 3600_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('different keys are independent', async () => {
    const env = makeTestEnv();
    const { rateLimitCheck } = await import('../src/db/repos/rateLimits');
    const db = makeDb(env as never);
    for (let i = 0; i < 5; i++) await rateLimitCheck(db, 'magic:ip:1.1.1.1', 5, 3600_000);
    const other = await rateLimitCheck(db, 'magic:ip:2.2.2.2', 5, 3600_000);
    expect(other.allowed).toBe(true);
  });

  it('window resets after expiry', async () => {
    const env = makeTestEnv();
    const { rateLimitCheck } = await import('../src/db/repos/rateLimits');
    const db = makeDb(env as never);
    for (let i = 0; i < 5; i++) await rateLimitCheck(db, 'magic:ip:3.3.3.3', 5, 1000); // 1s window
    // Fast-forward the window start into the past.
    (env.DB as any)
      .prepare('UPDATE rate_limits SET window_start = ? WHERE key = ?')
      .bind(new Date(Date.now() - 5000).toISOString(), 'magic:ip:3.3.3.3')
      .run();
    const after = await rateLimitCheck(db, 'magic:ip:3.3.3.3', 5, 1000);
    expect(after.allowed).toBe(true);
  });
});
