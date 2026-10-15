import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestEnv, seedUser, type TestEnv } from './helpers/seed';
import { makeDb } from '../src/db/client';
import { addSite, markVerified, querySitesForUser } from '../src/db/repos/sites';
import { sites, pagespeedResults, sslStatus, wpFingerprints, siteComponents } from '../src/db/schema';
import { nowIso } from '../src/db/client';

let env: TestEnv;
let a: number;
let b: number;

beforeEach(async () => {
  env = makeTestEnv();
  a = await seedUser(env, { email: 'a@x.com' });
  b = await seedUser(env, { email: 'b@x.com' });
});

async function site(userId: number, url: string, verified = true) {
  const db = makeDb(env as never);
  const s = await addSite(db, { userId, url }, `tok-${url}`);
  if (verified) await markVerified(db, userId, s!.id, 'meta');
  return s!.id;
}

const def = { sort: 'name' as const, filter: 'all' as const, search: '', page: 1, perPage: 25 };

describe('querySitesForUser — isolation', () => {
  it('returns only the caller rows', async () => {
    const db = makeDb(env as never);
    await site(a, 'https://a1.example.com');
    await site(b, 'https://b-secret.example.com');
    const { rows, total } = await querySitesForUser(db, a, def);
    expect(total).toBe(1);
    expect(rows.map((r) => r.url)).toEqual(['https://a1.example.com']);
  });
});

describe('querySitesForUser — sort / filter / search / pagination', () => {
  beforeEach(async () => {
    const db = makeDb(env as never);
    // A gets 4 sites with varied data.
    const s1 = await site(a, 'https://slow.example.com');
    const s2 = await site(a, 'https://fast.example.com');
    const s3 = await site(a, 'https://downy.example.com');
    await site(a, 'https://plain.example.com');

    await db.update(sites).set({ lastResponseMs: 3000 }).where(eq(sites.id, s1)).run();
    await db.update(sites).set({ lastResponseMs: 100 }).where(eq(sites.id, s2)).run();
    await db.update(sites).set({ currentStatus: 'down' }).where(eq(sites.id, s3)).run();

    await db.insert(pagespeedResults).values({ siteId: s1, checkedAt: nowIso(), performanceScore: 30, strategy: 'mobile' }).run();
    await db.insert(pagespeedResults).values({ siteId: s2, checkedAt: nowIso(), performanceScore: 95, strategy: 'mobile' }).run();

    await db.insert(sslStatus).values({ siteId: s1, checkedAt: nowIso(), daysLeft: 3, state: 'critical' }).run();

    await db.insert(wpFingerprints).values({ siteId: s3, scannedAt: nowIso(), wpDetected: true }).run();
    await db.insert(siteComponents).values({ siteId: s3, type: 'plugin', slug: 'akismet', outdated: true, status: 'checked' }).run();
  });

  it('sorts by name (default)', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, def);
    expect(rows.map((r) => r.name)).toEqual([
      'downy.example.com',
      'fast.example.com',
      'plain.example.com',
      'slow.example.com',
    ]);
  });

  it('sorts by status (down first)', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, { ...def, sort: 'status' });
    expect(rows[0].name).toBe('downy.example.com');
  });

  it('sorts by pagespeed ascending, nulls last', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, { ...def, sort: 'pagespeed' });
    expect(rows[0].name).toBe('slow.example.com'); // 30
    expect(rows[1].name).toBe('fast.example.com'); // 95
    expect(rows[3].pagespeedScore).toBeNull();
  });

  it('sorts by load time ascending', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, { ...def, sort: 'load' });
    expect(rows[0].name).toBe('fast.example.com'); // 100ms
  });

  it('filter=down returns only down sites', async () => {
    const db = makeDb(env as never);
    const { rows, total } = await querySitesForUser(db, a, { ...def, filter: 'down' });
    expect(total).toBe(1);
    expect(rows[0].name).toBe('downy.example.com');
  });

  it('filter=ssl returns sites with SSL problems', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, { ...def, filter: 'ssl' });
    expect(rows.map((r) => r.name)).toEqual(['slow.example.com']);
  });

  it('filter=updates returns sites with outdated components', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, { ...def, filter: 'updates' });
    expect(rows.map((r) => r.name)).toEqual(['downy.example.com']);
    expect(rows[0].updatesCount).toBe(1);
  });

  it('search matches name or url, case-insensitively via LIKE on lowercase-ish data', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, { ...def, search: 'fast' });
    expect(rows.map((r) => r.name)).toEqual(['fast.example.com']);
  });

  it('paginates 25-per-page style (page 2 of perPage=2)', async () => {
    const db = makeDb(env as never);
    const p1 = await querySitesForUser(db, a, { ...def, perPage: 2, page: 1 });
    const p2 = await querySitesForUser(db, a, { ...def, perPage: 2, page: 2 });
    expect(p1.total).toBe(4);
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows).toHaveLength(2);
    expect(p2.rows[0].name).toBe('plain.example.com');
  });

  it('updatesCount is null (UI "?") when no fingerprint exists', async () => {
    const db = makeDb(env as never);
    const { rows } = await querySitesForUser(db, a, { ...def, search: 'plain' });
    expect(rows[0].updatesCount).toBeNull();
  });
});
