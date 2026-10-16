/**
 * PageSpeed job tests (milestone 5). fetch stubbed — no real Google calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestEnv, seedUser, type TestEnv } from './helpers/seed';
import type { Env } from '../src/env';
import { makeDb, nowIso } from '../src/db/client';
import { addSite, markVerified, selectPageSpeedBatch, updateSiteForUser } from '../src/db/repos/sites';
import { pagespeedResults as psTable } from '../src/db/schema';
import { runPageSpeedJob } from '../src/jobs/pagespeed';
import { eq } from 'drizzle-orm';

let env: TestEnv;
let a: number;
let b: number;

beforeEach(async () => {
  env = makeTestEnv({ PAGESPEED_API_KEY: 'test-key' });
  a = await seedUser(env, { email: 'a@example.com' });
  b = await seedUser(env, { email: 'b@example.com' });
});

async function verifiedSite(userId: number, url: string) {
  const db = makeDb(env as never);
  const s = await addSite(db, { userId, url }, `tok-${url}`);
  await markVerified(db, userId, s!.id, 'meta');
  return s!.id;
}

function psiResponse(score: number | null) {
  return new Response(
    JSON.stringify(
      score === null
        ? { error: { code: 429, message: 'Quota exceeded.' } }
        : { lighthouseResult: { categories: { performance: { score } } } },
    ),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('selectPageSpeedBatch — least recently tested first, across users', () => {
  it('never-tested sites come first, then oldest test time', async () => {
    const db = makeDb(env as never);
    const a1 = await verifiedSite(a, 'https://a1.example.com');
    await verifiedSite(a, 'https://a2.example.com'); // never tested
    const b1 = await verifiedSite(b, 'https://b1.example.com');
    await db.insert(psTable).values({ siteId: a1, checkedAt: new Date(Date.now() - 7200_000).toISOString(), performanceScore: 50, strategy: 'mobile' }).run();
    await db.insert(psTable).values({ siteId: b1, checkedAt: new Date(Date.now() - 3600_000).toISOString(), performanceScore: 60, strategy: 'mobile' }).run();

    const batch = await selectPageSpeedBatch(db, 3);
    expect(batch.map((s) => s.url)).toEqual([
      'https://a2.example.com', // never tested
      'https://a1.example.com', // oldest test (2h ago)
      'https://b1.example.com', // 1h ago
    ]);
  });

  it('excludes unverified, paused, and pending-user sites', async () => {
    const db = makeDb(env as never);
    await verifiedSite(a, 'https://ok.example.com');
    const un = await addSite(db, { userId: a, url: 'https://unv.example.com' }, 't');
    const paused = await verifiedSite(a, 'https://paused.example.com');
    await updateSiteForUser(db, a, paused, { active: false });
    const pend = await seedUser(env, { email: 'p@example.com', status: 'pending' });
    const ps = await addSite(db, { userId: pend, url: 'https://pend.example.com' }, 't');
    await markVerified(db, pend, ps!.id, 'meta');
    void un;

    const batch = await selectPageSpeedBatch(db, 10);
    const urls = batch.map((s) => s.url);
    expect(urls).toEqual(['https://ok.example.com']);
  });
});

describe('runPageSpeedJob', () => {
  it('skips entirely without an API key', async () => {
    const env2 = makeTestEnv(); // no PAGESPEED_API_KEY
    await verifiedSite(a, 'https://x.example.com');
    let called = false;
    vi.stubGlobal('fetch', async () => { called = true; return psiResponse(0.5); });
    const report = await runPageSpeedJob(env2 as never);
    expect(report.selected).toBe(0);
    expect(called).toBe(false);
    vi.unstubAllGlobals();
  });

  it('records the rounded 0-100 score with mobile strategy', async () => {
    const db = makeDb(env as never);
    const id = await verifiedSite(a, 'https://good.example.com');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: any) => { urls.push(String(u)); return psiResponse(0.873); });

    const report = await runPageSpeedJob(env as never, db);
    expect(report.recorded).toBe(1);
    expect(urls[0]).toContain('pagespeedonline/v5/runPagespeed');
    expect(urls[0]).toContain('strategy=mobile');
    expect(urls[0]).toContain('category=performance');
    expect(urls[0]).toContain('key=test-key');

    const rows = await db.select().from(psTable).where(eq(psTable.siteId, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].performanceScore).toBe(87);
    expect(rows[0].strategy).toBe('mobile');
    vi.unstubAllGlobals();
  });

  it('429 quota → skip, no row written, site stays eligible', async () => {
    const db = makeDb(env as never);
    const id = await verifiedSite(a, 'https://quota.example.com');
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }));
    const report = await runPageSpeedJob(env as never, db);
    expect(report.skipped).toBe(1);
    expect(report.recorded).toBe(0);
    const rows = await db.select().from(psTable).where(eq(psTable.siteId, id)).all();
    expect(rows).toHaveLength(0);
    // still eligible next run
    const batch = await selectPageSpeedBatch(db, 5);
    expect(batch.map((s) => s.url)).toContain('https://quota.example.com');
    vi.unstubAllGlobals();
  });

  it('PSI error envelope (quota inside 200) → skip', async () => {
    const db = makeDb(env as never);
    await verifiedSite(a, 'https://err.example.com');
    vi.stubGlobal('fetch', async () => psiResponse(null));
    const report = await runPageSpeedJob(env as never, db);
    expect(report.skipped).toBe(1);
    expect(report.recorded).toBe(0);
    vi.unstubAllGlobals();
  });

  it('respects the batch cap (PAGESPEED_BATCH=5 default)', async () => {
    env.PAGESPEED_BATCH = '2';
    const db = makeDb(env as never);
    for (let i = 1; i <= 5; i++) await verifiedSite(a, `https://s${i}.example.com`);
    vi.stubGlobal('fetch', async () => psiResponse(0.5));
    const report = await runPageSpeedJob(env as never, db);
    expect(report.selected).toBe(2);
    expect(report.recorded).toBe(2);
    vi.unstubAllGlobals();
  });

  it('scores are clamped to 0-100', async () => {
    const db = makeDb(env as never);
    const id = await verifiedSite(a, 'https://clamp.example.com');
    vi.stubGlobal('fetch', async () => psiResponse(1.4));
    await runPageSpeedJob(env as never, db);
    const rows = await db.select().from(psTable).where(eq(psTable.siteId, id)).all();
    expect(rows[0].performanceScore).toBe(100);
    vi.unstubAllGlobals();
  });
});
