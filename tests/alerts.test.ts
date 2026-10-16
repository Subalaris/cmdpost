/**
 * Alert job tests (milestone 4). Spec: alerts fire only on transitions, go
 * ONLY to the site owner's alert_email + webhook_url, include downtime on
 * recovery, and every send is logged in alert_log.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestEnv, seedUser, type TestEnv } from './helpers/seed';
import type { Env } from '../src/env';
import { makeDb } from '../src/db/client';
import { sendTransitionAlerts } from '../src/jobs/alerts';
import { alertLog } from '../src/db/schema';
import { addSite } from '../src/db/repos/sites';
import { eq } from 'drizzle-orm';

let env: TestEnv;
let owner: number;
let other: number;
let siteId: number;

beforeEach(async () => {
  env = makeTestEnv();
  owner = await seedUser(env, { email: 'owner@example.com' });
  other = await seedUser(env, { email: 'other@example.com' });
  // alert_log.site_id has an FK → create a real site row to reference.
  const db = makeDb(env as never);
  const s = await addSite(db, { userId: owner, url: 'https://site.example.com' }, 'tok-x');
  siteId = s!.id;
});

function site(over: Partial<{ id: number; url: string; name: string; ownerId: number; statusChangedAt: string | null }> = {}) {
  return {
    id: over.id ?? siteId,
    url: over.url ?? 'https://site.example.com',
    name: over.name ?? 'My Site',
    ownerId: over.ownerId ?? owner,
    statusChangedAt: over.statusChangedAt ?? null,
  };
}

describe('sendTransitionAlerts — per-owner delivery', () => {
  it('emails the owner alert_email, never anyone else', async () => {
    const db = makeDb(env as never);
    // owner has a custom alert email
    await db.update((await import('../src/db/schema')).users).set({ alertEmail: 'pager@example.com' }).where(eq((await import('../src/db/schema')).users.id, owner)).run();

    const to: string[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      if (String(url).includes('api.resend.com')) {
        to.push(JSON.parse(init.body).to[0]);
        return new Response('{}', { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    env.RESEND_API_KEY = 're_test';

    const report = await sendTransitionAlerts(env as never, db, [
      { site: site(), kind: 'up-to-down', detail: 'HTTP 503' },
    ]);
    expect(report.sent).toBe(1);
    expect(to).toEqual(['pager@example.com']); // custom alert email, not login email, not `other`
    vi.unstubAllGlobals();
    delete env.RESEND_API_KEY;
  });

  it('falls back to the login email when no alert_email set', async () => {
    const db = makeDb(env as never);
    const to: string[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      if (String(url).includes('api.resend.com')) to.push(JSON.parse(init.body).to[0]);
      return new Response('{}', { status: 200 });
    });
    env.RESEND_API_KEY = 're_test';
    // owner seeded with alert_email = login email by seedUser; clear it to test fallback
    await db.update((await import('../src/db/schema')).users).set({ alertEmail: null }).where(eq((await import('../src/db/schema')).users.id, owner)).run();
    await sendTransitionAlerts(env as never, db, [{ site: site(), kind: 'down-to-up' }]);
    expect(to).toEqual(['owner@example.com']);
    vi.unstubAllGlobals();
    delete env.RESEND_API_KEY;
  });

  it("posts to the owner's webhook with Slack/Discord-compatible JSON", async () => {
    const db = makeDb(env as never);
    await db.update((await import('../src/db/schema')).users).set({ webhookUrl: 'https://hooks.example.com/abc' }).where(eq((await import('../src/db/schema')).users.id, owner)).run();
    const posts: any[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      if (String(url).includes('hooks.example.com')) posts.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    });
    const report = await sendTransitionAlerts(env as never, db, [{ site: site(), kind: 'up-to-down', detail: 'HTTP 500' }]);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('DOWN'); // Slack
    expect(posts[0].content).toContain('DOWN'); // Discord
    // email(console) + webhook both sent
    expect(report.sent).toBe(2);
    vi.unstubAllGlobals();
  });

  it('rejects a private webhook URL (SSRF) and logs the failure', async () => {
    const db = makeDb(env as never);
    await db.update((await import('../src/db/schema')).users).set({ webhookUrl: 'http://169.254.169.254/latest/meta-data' }).where(eq((await import('../src/db/schema')).users.id, owner)).run();
    let webhookCalled = false;
    vi.stubGlobal('fetch', async (url: any) => {
      if (String(url).includes('169.254')) webhookCalled = true;
      return new Response('{}', { status: 200 });
    });
    const report = await sendTransitionAlerts(env as never, db, [{ site: site(), kind: 'up-to-down' }]);
    expect(webhookCalled).toBe(false); // never fetched
    expect(report.failed).toBeGreaterThanOrEqual(1);
    const logs = await db.select().from(alertLog).where(eq(alertLog.channel, 'webhook')).all();
    expect(logs.some((l) => l.ok === false)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('logs every send in alert_log with channel + ok', async () => {
    const db = makeDb(env as never);
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    await sendTransitionAlerts(env as never, db, [{ site: site({ id: siteId }), kind: 'up-to-down' }]);
    const logs = await db.select().from(alertLog).where(eq(alertLog.siteId, siteId)).all();
    expect(logs.length).toBeGreaterThanOrEqual(1); // console email at minimum
    expect(logs[0].kind).toBe('up-to-down');
    expect(['console', 'resend']).toContain(logs[0].channel);
    vi.unstubAllGlobals();
  });

  it('recovery email includes downtime duration', async () => {
    const db = makeDb(env as never);
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    let body = '';
    vi.stubGlobal('fetch', async (_u: any, init: any) => {
      if (String(_u).includes('resend')) body = init.body;
      return new Response('{}', { status: 200 });
    });
    env.RESEND_API_KEY = 're_test';
    await sendTransitionAlerts(env as never, db, [
      { site: site({ statusChangedAt: twoHoursAgo }), kind: 'down-to-up' },
    ]);
    expect(body).toMatch(/2h/); // downtime rendered
    vi.unstubAllGlobals();
    delete env.RESEND_API_KEY;
  });

  it('no events → nothing sent, no logs', async () => {
    const db = makeDb(env as never);
    const report = await sendTransitionAlerts(env as never, db, []);
    expect(report.sent).toBe(0);
    expect(report.logged).toBe(0);
  });
});
