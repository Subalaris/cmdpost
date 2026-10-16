import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestEnv, seedUser, type TestEnv } from './helpers/seed';
import { makeDb } from '../src/db/client';
import { addSite, dashboardSummaryForUser, markVerified, querySitesForUser } from '../src/db/repos/sites';
import { sites, pagespeedResults } from '../src/db/schema';
import { createSession } from '../src/db/repos/auth';
import { buildApp } from '../src/app';
import type { Env } from '../src/env';

let env: TestEnv;
let owner: number;
const token = 'dashboard-test-session';

beforeEach(async () => {
  env = makeTestEnv();
  owner = await seedUser(env, { email: 'owner@example.com', name: '<Owner>' });
  const other = await seedUser(env, { email: 'other@example.com' });
  const db = makeDb(env as unknown as Env);
  await createSession(db, owner, token);
  for (const [userId, name, status, verified] of [
    [owner, 'Online', 'up', true], [owner, 'Offline', 'down', true],
    [owner, 'Unverified', 'up', false], [other, 'Private', 'up', true],
  ] as const) {
    const s = (await addSite(db, { userId, url: `https://${name.toLowerCase()}.example.com`, name }, name))!;
    if (verified) await markVerified(db, userId, s.id, 'meta');
    await db.update(sites).set({ currentStatus: status }).where(eq(sites.id, s.id));
    if (name === 'Online' || name === 'Private') {
      await db.insert(pagespeedResults).values([
        { siteId: s.id, checkedAt: '2026-10-01T00:00:00Z', performanceScore: 20 },
        { siteId: s.id, checkedAt: '2026-10-02T00:00:00Z', performanceScore: name === 'Online' ? 90 : 10 },
      ]);
    }
  }
});

function request(path: string, headers: Record<string, string> = {}) {
  return buildApp(env as unknown as Env).fetch(new Request(`http://localhost${path}`, {
    headers: { cookie: `wpmon_session=${token}`, ...headers },
  }), env as unknown as Env);
}

describe('dashboard summary and online filter', () => {
  it('uses only owner sites and latest scores, excluding unverified sites from online', async () => {
    const db = makeDb(env as unknown as Env);
    expect(await dashboardSummaryForUser(db, owner)).toEqual({ total: 3, online: 1, down: 1, averageScore: 90 });
    const result = await querySitesForUser(db, owner, { sort: 'name', filter: 'up', search: '', page: 1, perPage: 9 });
    expect(result.total).toBe(1);
    expect(result.rows.map((r) => r.name)).toEqual(['Online']);
  });

  it('returns honest empty metrics for a new workspace', async () => {
    const id = await seedUser(env, { email: 'empty@example.com' });
    expect(await dashboardSummaryForUser(makeDb(env as unknown as Env), id))
      .toEqual({ total: 0, online: 0, down: 0, averageScore: null });
  });
});

describe('dashboard navigation', () => {
  it('renders the shell and escapes user data', async () => {
    const html = await (await request('/dashboard')).text();
    expect(html).toContain('Websites — cmdPost');
    expect(html).toContain('&lt;Owner&gt;');
    expect(html).not.toContain('private.example.com');
    expect(html).toContain('/sites#add-site');
  });

  it('returns a filtered panel for htmx with a reloadable history URL', async () => {
    const response = await request('/dashboard?filter=up&q=Online', { 'HX-Request': 'true' });
    const html = await response.text();
    expect(html).not.toContain('<html');
    expect(html).toContain('online.example.com');
    expect(html).not.toContain('offline.example.com');
    expect(html).toContain('name="filter"');
    expect(html).toContain('value="up" selected');
    const url = response.headers.get('HX-Push-Url')!;
    expect(url).not.toContain('partial');
    expect(await (await request(url)).text()).toContain('<!doctype html>');
  });

  it('clamps a stale page while preserving search and filters', async () => {
    const html = await (await request('/dashboard?filter=up&q=Online&page=999&partial=1')).text();
    expect(html).toContain('online.example.com');
    expect(html).toContain('Showing 1–1 of 1 websites');
    expect(html).toContain('value="Online"');
  });
});
