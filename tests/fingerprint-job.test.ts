/**
 * Fingerprint job tests: full scan against a stubbed "WordPress site" +
 * stubbed wp.org API, cache behavior, premium_unknown, updates count,
 * fair batch ordering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeTestEnv, seedUser, type TestEnv } from './helpers/seed';
import type { Env } from '../src/env';
import { makeDb, nowIso } from '../src/db/client';
import { addSite, markVerified, selectFingerprintBatch, findSiteForUser } from '../src/db/repos/sites';
import { wpFingerprints, siteComponents, wpOrgCache } from '../src/db/schema';
import { scanSite, writeScan, runFingerprintJob } from '../src/jobs/fingerprint';
import { makeBudget } from '../src/jobs/uptime';
import { eq } from 'drizzle-orm';

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url) as unknown as string), 'utf8');

let env: TestEnv;
let a: number;
let b: number;

beforeEach(async () => {
  env = makeTestEnv();
  a = await seedUser(env, { email: 'a@example.com' });
  b = await seedUser(env, { email: 'b@example.com' });
});

/** Stub fetch: fake WP site at https://shop.example + wp.org API. */
function stubSite() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (u: any) => {
    const url = String(u);
    calls.push(url);
    if (url.includes('api.wordpress.org/core/version-check')) {
      return new Response(JSON.stringify({ offers: [{ response: 'upgrade', current: '6.6.1', version: '6.6.1' }] }), { status: 200 });
    }
    if (url.includes('plugins/info')) {
      if (url.includes('jetpack')) return new Response(JSON.stringify({ slug: 'jetpack', version: '13.1' }), { status: 200 });
      if (url.includes('contact-form-7')) return new Response(JSON.stringify({ slug: 'contact-form-7', version: '5.8.7' }), { status: 200 });
      if (url.includes('woocommerce')) return new Response(JSON.stringify({ slug: 'woocommerce', version: '9.2.0' }), { status: 200 });
      if (url.includes('elementor')) return new Response(JSON.stringify({ slug: 'elementor', version: '3.25.0' }), { status: 200 });
      return new Response(JSON.stringify({ error: 'Plugin not found.' }), { status: 200 });
    }
    if (url.includes('themes/info')) {
      if (url.includes('twentytwentyfour')) return new Response(JSON.stringify({ slug: 'twentytwentyfour', version: '1.3' }), { status: 200 });
      return new Response(JSON.stringify({ error: 'Theme not found.' }), { status: 200 });
    }
    if (url === 'https://shop.example/' || /^https:\/\/s\d\.example\.com\/?$/.test(url)) {
      return new Response(fx('wp-normal.html').replaceAll('example.com', new URL(url).host), { status: 200 });
    }
    if (url.includes('/readme.txt')) {
      if (url.includes('elementor')) return new Response('nope', { status: 404 }); // version hidden
      return new Response("=== WooCommerce ===\nStable tag: 9.1.0\n", { status: 200 });
    }
    if (url.includes('/style.css')) return new Response('/*\nTheme Name: Twenty Twenty-Four\nVersion: 1.2\n*/', { status: 200 });
    return new Response('not found', { status: 404 });
  });
  return calls;
}

describe('scanSite — full pipeline', () => {
  it('detects core, plugins, theme; computes outdated + updates count', async () => {
    const db = makeDb(env as never);
    stubSite();
    const scan = await scanSite(db, { id: 1, url: 'https://shop.example/' }, makeBudget(45), fx('wp-normal.html').replaceAll('example.com', 'shop.example'));
    expect(scan).not.toBeNull();
    expect(scan!.wpVersion).toBe('6.4.2');
    expect(scan!.wpVersionSource).toBe('meta');
    expect(scan!.wpLatest).toBe('6.6.1');
    expect(scan!.coreOutdated).toBe(true);
    expect(scan!.wpDetected).toBe(true);

    const bySlug = new Map(scan!.components.map((c) => [c.slug, c]));
    // jetpack: asset_ver 13.0 vs latest 13.1 → outdated
    expect(bySlug.get('jetpack')).toMatchObject({ detectedVersion: '13.0', versionSource: 'asset_ver', latestVersion: '13.1', outdated: true, status: 'checked' });
    // contact-form-7: 5.8.6 vs 5.8.7 → outdated
    expect(bySlug.get('contact-form-7')).toMatchObject({ outdated: true });
    // woocommerce: no ?ver= → readme.txt Stable tag 9.1.0 vs latest 9.2.0 → outdated, source readme
    expect(bySlug.get('woocommerce')).toMatchObject({ detectedVersion: '9.1.0', versionSource: 'readme', outdated: true });
    // elementor: on wp.org (3.25.0) but no ?ver= and readme.txt 404 → version_hidden
    expect(bySlug.get('elementor')).toMatchObject({ status: 'version_hidden' });
    // theme: style.css 1.2 vs latest 1.3 → outdated
    expect(bySlug.get('twentytwentyfour')).toMatchObject({ type: 'theme', detectedVersion: '1.2', versionSource: 'style_css', latestVersion: '1.3', outdated: true });

    // updates = outdated plugins(3: jetpack, cf7, woo) + theme(1) + core(1) = 5
    expect(scan!.updatesCount).toBe(5);
    vi.unstubAllGlobals();
  });

  it('plugin not on wp.org → premium_unknown, never outdated', async () => {
    const db = makeDb(env as never);
    stubSite();
    const html = fx('wp-hidden.html');
    const scan = await scanSite(db, { id: 1, url: 'https://hardened.example/' }, makeBudget(45), html);
    const bySlug = new Map(scan!.components.map((c) => [c.slug, c]));
    expect(bySlug.get('secret-premium-plugin')).toMatchObject({ status: 'premium_unknown', outdated: false, detectedVersion: '9.9.9' });
    vi.unstubAllGlobals();
  });

  it('hidden core version → wpVersion null, UI shows ?', async () => {
    const db = makeDb(env as never);
    stubSite();
    // feed + readme also 404 for the hardened site
    vi.stubGlobal('fetch', async (u: any) => {
      const url = String(u);
      if (url.includes('api.wordpress.org')) return new Response(JSON.stringify({ error: 'no' }), { status: 200 });
      return new Response('nope', { status: 404 });
    });
    const scan = await scanSite(db, { id: 1, url: 'https://hardened.example/' }, makeBudget(45), fx('wp-hidden.html'));
    expect(scan!.wpVersion).toBeNull();
    expect(scan!.wpVersionSource).toBeNull();
    expect(scan!.wpDetected).toBe(true); // plugins/themes still reveal WordPress
    vi.unstubAllGlobals();
  });

  it('wp.org cache: second lookup does not hit the network', async () => {
    const db = makeDb(env as never);
    const calls = stubSite();
    const budget = makeBudget(45);
    await scanSite(db, { id: 1, url: 'https://shop.example/' }, budget, fx('wp-normal.html').replaceAll('example.com', 'shop.example'));
    const wpCalls1 = calls.filter((c) => c.includes('api.wordpress.org')).length;
    await scanSite(db, { id: 2, url: 'https://shop.example/' }, budget, fx('wp-normal.html').replaceAll('example.com', 'shop.example'));
    const wpCalls2 = calls.filter((c) => c.includes('api.wordpress.org')).length;
    expect(wpCalls2).toBe(wpCalls1); // all served from wp_org_cache
    const cached = await db.select().from(wpOrgCache).all();
    expect(cached.length).toBeGreaterThanOrEqual(3); // core + plugins + theme
    vi.unstubAllGlobals();
  });
});

describe('writeScan + job', () => {
  it('persists fingerprint + components (replaces on rescan)', async () => {
    const db = makeDb(env as never);
    const s = await addSite(db, { userId: a, url: 'https://shop.example' }, 't');
    await markVerified(db, a, s!.id, 'meta');
    stubSite();
    const scan = await scanSite(db, { id: s!.id, url: 'https://shop.example/' }, makeBudget(45), fx('wp-normal.html').replaceAll('example.com', 'shop.example'));
    await writeScan(db, s!.id, scan!, nowIso());
    const fp = await db.select().from(wpFingerprints).where(eq(wpFingerprints.siteId, s!.id)).get();
    expect(fp?.wpVersion).toBe('6.4.2');
    const comps = await db.select().from(siteComponents).where(eq(siteComponents.siteId, s!.id)).all();
    expect(comps.length).toBeGreaterThanOrEqual(5);

    // rescan → still one fingerprint row, components replaced not duplicated
    await writeScan(db, s!.id, scan!, nowIso());
    const fp2 = await db.select().from(wpFingerprints).where(eq(wpFingerprints.siteId, s!.id)).all();
    expect(fp2).toHaveLength(1);
    const comps2 = await db.select().from(siteComponents).where(eq(siteComponents.siteId, s!.id)).all();
    expect(comps2).toHaveLength(comps.length);
    vi.unstubAllGlobals();
  });

  it('selectFingerprintBatch: never-scanned first, fair across users', async () => {
    const db = makeDb(env as never);
    const sa = await addSite(db, { userId: a, url: 'https://a1.example.com' }, 't');
    await markVerified(db, a, sa!.id, 'meta');
    await addSite(db, { userId: a, url: 'https://a2.example.com' }, 't2'); // unverified → excluded
    const sb = await addSite(db, { userId: b, url: 'https://b1.example.com' }, 't3');
    await markVerified(db, b, sb!.id, 'meta');
    await db.update((await import('../src/db/schema')).sites).set({ lastScannedAt: nowIso() }).where(eq((await import('../src/db/schema')).sites.id, sb!.id)).run();

    const batch = await selectFingerprintBatch(db, 1); // fairness = ordering, not exclusion
    expect(batch.map((x) => x.url)).toEqual(['https://a1.example.com']); // b1 scanned just now goes last
  });

  it('runFingerprintJob scans ≤2 and stamps lastScannedAt', async () => {
    const db = makeDb(env as never);
    for (let i = 1; i <= 4; i++) {
      const s = await addSite(db, { userId: a, url: `https://s${i}.example.com` }, `t${i}`);
      await markVerified(db, a, s!.id, 'meta');
    }
    stubSite();
    const report = await runFingerprintJob(env as never, db);
    expect(report.selected).toBe(2);
    expect(report.scanned).toBe(2);
    const s1 = await findSiteForUser(db, a, 1);
    expect(s1?.lastScannedAt).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
