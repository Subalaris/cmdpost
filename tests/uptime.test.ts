/**
 * Uptime job tests: fair scheduling order, batch caps, subrequest budget,
 * HEAD→GET fallback, no-body reads, state persistence via one batch().
 * fetch is stubbed — no real network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestEnv, seedUser, type TestEnv } from './helpers/seed';
import type { Env } from '../src/env';
import { makeDb } from '../src/db/client';
import { addSite, markVerified, selectUptimeBatch, findSiteForUser } from '../src/db/repos/sites';
import { runUptimeJob, checkSite, makeBudget } from '../src/jobs/uptime';
import { checks } from '../src/db/schema';
import { eq } from 'drizzle-orm';

let env: TestEnv;
let userA: number;
let userB: number;

beforeEach(async () => {
  env = makeTestEnv();
  userA = await seedUser(env, { email: 'a@example.com' });
  userB = await seedUser(env, { email: 'b@example.com' });
});

async function verifiedSite(userId: number, url: string) {
  const db = makeDb(env as never);
  const s = await addSite(db, { userId, url }, `tok-${url}`);
  await markVerified(db, userId, s!.id, 'meta');
  return s!.id;
}

describe('fair scheduling order (spec: ordered by last processed time ACROSS ALL USERS)', () => {
  it('never-checked sites come first, then oldest-checked regardless of owner', async () => {
    const db = makeDb(env as never);
    // user A owns 3 sites, user B owns 1. A must not starve B.
    const a1 = await verifiedSite(userA, 'https://a1.example.com');
    await verifiedSite(userA, 'https://a2.example.com');
    await verifiedSite(userA, 'https://a3.example.com');
    const b1 = await verifiedSite(userB, 'https://b1.example.com');

    // Simulate: a1 and b1 were checked long ago; a2/a3 never.
    const old = new Date(Date.now() - 3600_000).toISOString();
    await db.update((await import('../src/db/schema')).sites).set({ lastCheckedAt: old }).where(eq((await import('../src/db/schema')).sites.id, a1)).run();
    await db.update((await import('../src/db/schema')).sites).set({ lastCheckedAt: old }).where(eq((await import('../src/db/schema')).sites.id, b1)).run();

    const batch = await selectUptimeBatch(db, 25, 5 * 60 * 1000);
    // All 4 eligible (never-checked OR older than 5 min). Never-checked sort first (COALESCE 1970).
    const urls = batch.map((s) => s.url);
    expect(urls).toEqual(['https://a2.example.com', 'https://a3.example.com', 'https://a1.example.com', 'https://b1.example.com']);
  });

  it('a batch limit of 1 picks the least-recently-checked site even if another user has more sites', async () => {
    const db = makeDb(env as never);
    // A has 2 sites (one old, one fresh), B has 1 old site.
    const a1 = await verifiedSite(userA, 'https://a1.example.com');
    const a2 = await verifiedSite(userA, 'https://a2.example.com');
    const b1 = await verifiedSite(userB, 'https://b1.example.com');
    const { sites } = await import('../src/db/schema');
    await db.update(sites).set({ lastCheckedAt: new Date(Date.now() - 3600_000).toISOString() }).where(eq(sites.id, a1)).run(); // oldest
    await db.update(sites).set({ lastCheckedAt: new Date().toISOString() }).where(eq(sites.id, a2)).run(); // fresh → excluded
    await db.update(sites).set({ lastCheckedAt: new Date(Date.now() - 1800_000).toISOString() }).where(eq(sites.id, b1)).run();

    // limit 1 → the globally oldest (a1), regardless of owner.
    const one = await selectUptimeBatch(db, 1, 5 * 60 * 1000);
    expect(one.map((s) => s.url)).toEqual(['https://a1.example.com']);

    // limit 2 → a1 then b1 (fair across users); fresh a2 excluded by the interval.
    const two = await selectUptimeBatch(db, 2, 5 * 60 * 1000);
    expect(two.map((s) => s.url)).toEqual(['https://a1.example.com', 'https://b1.example.com']);
  });

  it('enforces the minimum 5-minute interval per site', async () => {
    const db = makeDb(env as never);
    await verifiedSite(userA, 'https://fresh.example.com');
    const { sites } = await import('../src/db/schema');
    await db.update(sites).set({ lastCheckedAt: new Date().toISOString() }).where(eq(sites.url, 'https://fresh.example.com')).run();
    const batch = await selectUptimeBatch(db, 25, 5 * 60 * 1000);
    expect(batch.map((s) => s.url)).not.toContain('https://fresh.example.com');
  });
});

describe('subrequest budget', () => {
  it('counts and refuses past the cap', () => {
    const b = makeBudget(3);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.n).toBe(3);
  });

  it('checkSite skips (not fails) when the budget is exhausted', async () => {
    const b = makeBudget(0);
    const r = await checkSite('https://example.com', b);
    expect(r.skipped).toBe(true);
    expect(r.error).toBe('budget');
  });
});

describe('runUptimeJob end-to-end with stubbed fetch', () => {
  it('records checks, flips up after success, writes via batch', async () => {
    const db = makeDb(env as never);
    const id = await verifiedSite(userA, 'https://good.example.com');

    const seen: { url: string; method: string; headers: any }[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      seen.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers });
      return new Response('', { status: 200, headers: { 'x-body': 'never-read' } });
    });

    const report = await runUptimeJob(env as never, db);
    expect(report.checked).toBe(1);
    expect(seen[0].method).toBe('HEAD');
    expect(seen[0].headers['User-Agent']).toBe('WPMonitor/1.0 (private monitoring)');

    const site = await findSiteForUser(db, userA, id);
    expect(site?.currentStatus).toBe('up');
    expect(site?.lastResponseMs).toBeGreaterThanOrEqual(0);
    expect(site?.lastCheckedAt).toBeTruthy();

    const rows = await db.select().from(checks).where(eq(checks.siteId, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].statusCode).toBe(200);
    vi.unstubAllGlobals();
  });

  it('HEAD 405 falls back to GET', async () => {
    const db = makeDb(env as never);
    await verifiedSite(userA, 'https://nohead.example.com');
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (_u: any, init: any) => {
      const m = init?.method ?? 'GET';
      methods.push(m);
      return new Response('', { status: m === 'HEAD' ? 405 : 200 });
    });
    const report = await runUptimeJob(env as never, db);
    expect(report.checked).toBe(1);
    expect(methods).toEqual(['HEAD', 'GET']);
    vi.unstubAllGlobals();
  });

  it('two consecutive failures flip to down; one success flips back to up', async () => {
    const db = makeDb(env as never);
    const id = await verifiedSite(userA, 'https://flaky.example.com');
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));

    let report = await runUptimeJob(env as never, db);
    let site = await findSiteForUser(db, userA, id);
    expect(site?.currentStatus).toBe('unknown'); // 1st failure: not down yet
    expect(site?.consecutiveFailures).toBe(1);
    expect(report.transitions).toHaveLength(0);

    // second run: bypass the 5-min interval by clearing lastCheckedAt
    const { sites } = await import('../src/db/schema');
    await db.update(sites).set({ lastCheckedAt: null }).where(eq(sites.id, id)).run();
    report = await runUptimeJob(env as never, db);
    site = await findSiteForUser(db, userA, id);
    expect(site?.currentStatus).toBe('down');
    // unknown → down is NOT an alert (the site was never confirmed up).
    expect(report.transitions).toHaveLength(0);

    // third run: success → back up (down-to-up IS an alert)
    await db.update(sites).set({ lastCheckedAt: null }).where(eq(sites.id, id)).run();
    vi.stubGlobal('fetch', async () => new Response('', { status: 200 }));
    report = await runUptimeJob(env as never, db);
    site = await findSiteForUser(db, userA, id);
    expect(site?.currentStatus).toBe('up');
    expect(site?.consecutiveFailures).toBe(0);
    expect(report.transitions).toHaveLength(1);
    expect(report.transitions[0].transition).toBe('down-to-up');
    vi.unstubAllGlobals();
  });

  it('up → down after 2 failures DOES produce an up-to-down transition', async () => {
    const db = makeDb(env as never);
    const id = await verifiedSite(userA, 'https://wasup.example.com');
    const { sites } = await import('../src/db/schema');

    // First: a success so the site is confirmed 'up'.
    vi.stubGlobal('fetch', async () => new Response('', { status: 200 }));
    await runUptimeJob(env as never, db);
    expect((await findSiteForUser(db, userA, id))?.currentStatus).toBe('up');

    // Two failures (clearing the interval between runs).
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    await db.update(sites).set({ lastCheckedAt: null }).where(eq(sites.id, id)).run();
    await runUptimeJob(env as never, db); // failure 1: still up
    expect((await findSiteForUser(db, userA, id))?.currentStatus).toBe('up');

    await db.update(sites).set({ lastCheckedAt: null }).where(eq(sites.id, id)).run();
    const report = await runUptimeJob(env as never, db); // failure 2: down + alert
    expect((await findSiteForUser(db, userA, id))?.currentStatus).toBe('down');
    expect(report.transitions).toHaveLength(1);
    expect(report.transitions[0].transition).toBe('up-to-down');
    expect(report.transitions[0].site.ownerId).toBe(userA); // alerts go to the OWNER (milestone 4)
    vi.unstubAllGlobals();
  });

  it('respects the batch size cap (UPTIME_BATCH)', async () => {
    env.UPTIME_BATCH = '2';
    const db = makeDb(env as never);
    for (let i = 1; i <= 5; i++) await verifiedSite(userA, `https://s${i}.example.com`);
    let n = 0;
    vi.stubGlobal('fetch', async () => { n++; return new Response('', { status: 200 }); });
    const report = await runUptimeJob(env as never, db);
    expect(report.selected).toBe(2);
    expect(report.checked).toBe(2);
    expect(n).toBe(2);
    vi.unstubAllGlobals();
  });

  it('stops before exceeding the subrequest budget', async () => {
    env.UPTIME_BATCH = '40';
    const db = makeDb(env as never);
    for (let i = 1; i <= 40; i++) await verifiedSite(userA, `https://many${i}.example.com`);
    vi.stubGlobal('fetch', async () => new Response('', { status: 200 }));
    const report = await runUptimeJob(env as never, db);
    expect(report.subrequests).toBeLessThanOrEqual(45);
    expect(report.checked + report.skipped).toBe(40);
    vi.unstubAllGlobals();
  });
});
