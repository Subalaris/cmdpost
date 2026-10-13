import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestEnv, seedUser, type TestEnv } from './helpers/seed';
import type { Env } from '../src/env';
import { buildApp } from '../src/app';
import { makeDb } from '../src/db/client';
import { addSite, findSiteForUser, listSitesForUser } from '../src/db/repos/sites';
import { randomToken } from '../src/lib/tokens';
import { createSession } from '../src/db/repos/auth';

/**
 * Route-level isolation tests (spec: "A requesting B's site ID gets 404 for
 * view, edit, delete, verify, and scan-now"). These drive the REAL Hono app
 * with real HTTP requests and real session cookies.
 */

let env: TestEnv;
let aId: number;
let bId: number;
let aCookie: string;
let bCookie: string;
let bSiteId: number;

async function loginAs(target: TestEnv, userId: number): Promise<string> {
  const token = randomToken(32);
  await createSession(makeDb(target as unknown as Env), userId, token);
  return `wpmon_session=${token}`;
}

async function req(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  return await buildApp(env as unknown as Env).fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { cookie, origin: 'http://localhost', ...(init.headers ?? {}) },
    }),
    env as unknown as Env,
  );
}

beforeEach(async () => {
  env = makeTestEnv({ SIGNUP_MODE: 'open', MAX_SITES_PER_USER: '5', MAX_SITES_TOTAL: '150' });
  aId = await seedUser(env, { email: 'a@x.com' });
  bId = await seedUser(env, { email: 'b@x.com' });
  aCookie = await loginAs(env, aId);
  bCookie = await loginAs(env, bId);

  const db = makeDb(env as unknown as Env);
  const bSite = await addSite(db, { userId: bId, url: 'https://b-secret.example.com' }, 'tok-b');
  bSiteId = bSite!.id;
});

describe('route isolation — every site route 404s for a foreign site id', () => {
  const cases: Array<[string, string, RequestInit]> = [
    ['view', `/sites/${bSiteId}`, {}],
    ['edit', `/sites/${bSiteId}/edit`, { method: 'POST', body: new URLSearchParams({ name: 'hacked' }) }],
    ['delete', `/sites/${bSiteId}/delete`, { method: 'POST' }],
    ['toggle', `/sites/${bSiteId}/toggle`, { method: 'POST' }],
    ['verify', `/sites/${bSiteId}/verify`, { method: 'POST' }],
    ['verify-reset', `/sites/${bSiteId}/verify/reset`, { method: 'POST' }],
  ];

  for (const [name, path, init] of cases) {
    it(`A cannot ${name} B's site (404)`, async () => {
      const res = await req(path, aCookie, init);
      expect(res.status, path).toBe(404);
    });
  }

  it("B's site is untouched after A's attempts", async () => {
    for (const [, path, init] of cases) {
      await req(path, aCookie, init);
    }
    const db = makeDb(env as unknown as Env);
    const still = await findSiteForUser(db, bId, bSiteId);
    expect(still).toBeDefined();
    expect(still?.name).not.toBe('hacked');
    expect(still?.active).toBe(true);
    expect(still?.verifiedAt).toBeNull();
  });

  it("A's own routes work (200/302, not 404)", async () => {
    const db = makeDb(env as unknown as Env);
    const aSite = await addSite(db, { userId: aId, url: 'https://a-own.example.com' }, 'tok-a');
    const view = await req(`/sites/${aSite!.id}`, aCookie);
    expect(view.status).toBe(200);
    const edit = await req(`/sites/${aSite!.id}/edit`, aCookie, {
      method: 'POST',
      body: new URLSearchParams({ name: 'Renamed' }),
    });
    expect(edit.status).toBe(302);
    const after = await findSiteForUser(db, aId, aSite!.id);
    expect(after?.name).toBe('Renamed');
  });

  it('A never sees B site URLs on /sites or /dashboard', async () => {
    const list = await (await req('/sites', aCookie)).text();
    expect(list).not.toContain('b-secret.example.com');
    const dash = await (await req('/dashboard', aCookie)).text();
    expect(dash).not.toContain('b-secret.example.com');
  });

  it('unauthenticated requests to site routes redirect to login', async () => {
    const res = await req(`/sites/${bSiteId}`, 'wpmon_session=garbage');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('sites routes — add + caps + blocklist', () => {
  it('adds a site via the form and it appears scoped to the user', async () => {
    const res = await req('/sites/add', aCookie, {
      method: 'POST',
      body: new URLSearchParams({ urls: 'https://new-site.example.com', name: '' }),
    });
    expect(res.status).toBe(302);
    const db = makeDb(env as unknown as Env);
    const mine = await listSitesForUser(db, aId);
    expect(mine.map((s) => s.url)).toContain('https://new-site.example.com');
    const theirs = await listSitesForUser(db, bId);
    expect(theirs.map((s) => s.url)).not.toContain('https://new-site.example.com');
  });

  it('bulk add handles multiple URLs and skips duplicates', async () => {
    const res = await req('/sites/add', aCookie, {
      method: 'POST',
      body: new URLSearchParams({ urls: 'https://one.example.com\nhttps://two.example.com\nhttps://one.example.com' }),
    });
    expect(res.status).toBe(302);
    const db = makeDb(env as unknown as Env);
    const mine = await listSitesForUser(db, aId);
    expect(mine.map((s) => s.url)).toContain('https://one.example.com');
    expect(mine.map((s) => s.url)).toContain('https://two.example.com');
    expect(mine.filter((s) => s.url === 'https://one.example.com')).toHaveLength(1);
  });

  it('rejects private/invalid URLs with a visible error redirect', async () => {
    const res = await req('/sites/add', aCookie, {
      method: 'POST',
      body: new URLSearchParams({ urls: 'http://127.0.0.1:8787/admin' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('err=');
    const db = makeDb(env as unknown as Env);
    const mine = await listSitesForUser(db, aId);
    expect(mine).toHaveLength(0);
  });

  it('enforces the per-user cap through the route', async () => {
    const env2 = makeTestEnv({ SIGNUP_MODE: 'open', MAX_SITES_PER_USER: '2' });
    const uid = await seedUser(env2, { email: 'cap@x.com' });
    const cookie = await loginAs(env2, uid);
    const app = buildApp(env2 as unknown as Env);
    const post = (urls: string) =>
      app.fetch(
        new Request('http://localhost/sites/add', {
          method: 'POST',
          headers: { cookie, origin: 'http://localhost' },
          body: new URLSearchParams({ urls }),
        }),
        env2 as unknown as Env,
      );
    const r1 = await post('https://a1.example.com https://a2.example.com');
    expect(r1.headers.get('location')).toContain('added');
    const r2 = await post('https://a3.example.com');
    expect(r2.headers.get('location')).toContain('err=');
  });

  it('enforces the blocklist through the route', async () => {
    (env.DB as any).prepare('INSERT INTO blocked_domains (domain) VALUES (?)').bind('banned.example.com').run();
    const res = await req('/sites/add', aCookie, {
      method: 'POST',
      body: new URLSearchParams({ urls: 'https://banned.example.com' }),
    });
    expect(res.headers.get('location')).toContain('err=');
    const db = makeDb(env as unknown as Env);
    expect(await listSitesForUser(db, aId)).toHaveLength(0);
  });
});
