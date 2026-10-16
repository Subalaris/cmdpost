/**
 * WordPress fingerprint job (cron: hourly, ≤2 sites; plus "Scan now").
 *
 * Detection is EXTERNAL ONLY (no plugin on the target site):
 *  1. GET homepage once (10 s timeout, ≤1.5 MB) — parse core version,
 *     plugin slugs (+?ver=), theme slugs (+active theme).
 *  2. Fallbacks for core version: /feed/ generator, then /readme.html.
 *  3. For up to 10 version-less plugins: GET /wp-content/plugins/<slug>/readme.txt
 *     → "Stable tag". Active theme: GET style.css → "Version:".
 *  4. Latest versions via wp_org_cache (24 h TTL), ≤15 wp.org lookups per
 *     invocation. Slug not on wp.org → premium_unknown (NOT outdated).
 *  5. Updates count = outdated plugins + outdated themes + (core outdated ? 1 : 0).
 *
 * Everything is labeled "detected" in the UI — asset ?ver= can differ from
 * the real plugin version, so confidence is recorded per component.
 */
import { and, eq } from 'drizzle-orm';
import { makeDb, nowIso, type Db } from '../db/client';
import { sites, wpFingerprints, siteComponents } from '../db/schema';
import { selectFingerprintBatch, type JobSite } from '../db/repos/sites';
import { fetchPublic } from '../lib/ssrf';
import {
  parseCoreVersion, parseFeedVersion, parseReadmeVersion, parseStableTag,
  parseStyleCssVersion, parsePlugins, parseThemes,
  type ParsedPlugin,
} from '../lib/fingerprint';
import { isOutdated } from '../lib/version-compare';
import { getCoreLatest, getComponentLatest } from '../lib/wporg';
import { makeBudget, type SubrequestBudget } from './uptime';
import type { Env } from '../env';

export interface ComponentWrite {
  type: 'plugin' | 'theme';
  slug: string;
  detectedVersion: string | null;
  versionSource: 'asset_ver' | 'readme' | 'style_css' | null;
  latestVersion: string | null;
  outdated: boolean;
  status: 'checked' | 'premium_unknown' | 'version_hidden';
}

export interface FingerprintResult {
  wpVersion: string | null;
  wpVersionSource: 'meta' | 'feed' | 'readme' | null;
  wpLatest: string | null;
  coreOutdated: boolean;
  wpDetected: boolean;
  components: ComponentWrite[];
  updatesCount: number;
}

/** Parse + enrich one site. `homeHtml` injected for testability. */
export async function scanSite(
  db: Db,
  site: { id: number; url: string },
  budget: SubrequestBudget,
  homeHtml: string | null,
): Promise<FingerprintResult | null> {
  if (homeHtml === null) return null; // homepage unreachable → leave previous scan

  // ---- core version
  let wpVersion = parseCoreVersion(homeHtml);
  let wpVersionSource: 'meta' | 'feed' | 'readme' | null = wpVersion ? 'meta' : null;
  if (!wpVersion) {
    const feed = await fetchPublic(new URL('/feed/', site.url).toString(), { method: 'GET', maxBytes: 200_000, timeoutMs: 10_000, budget });
    if (feed.ok && feed.body) {
      wpVersion = parseFeedVersion(feed.body);
      if (wpVersion) wpVersionSource = 'feed';
    }
  }
  if (!wpVersion) {
    const readme = await fetchPublic(new URL('/readme.html', site.url).toString(), { method: 'GET', maxBytes: 200_000, timeoutMs: 10_000, budget });
    if (readme.ok && readme.body) {
      wpVersion = parseReadmeVersion(readme.body);
      if (wpVersion) wpVersionSource = 'readme';
    }
  }

  const plugins = parsePlugins(homeHtml);
  const themes = parseThemes(homeHtml);
  const wpDetected = wpVersion !== null || plugins.length > 0 || themes.slugs.length > 0;

  // ---- core latest + outdated
  let wpLatest: string | null = null;
  let coreOutdated = false;
  if (wpVersion) {
    const core = await getCoreLatest(db, budget);
    wpLatest = core?.latest ?? null;
    coreOutdated = isOutdated(wpVersion, wpLatest);
  }

  // ---- plugin versions: fetch readme.txt for up to 10 without ?ver=
  const needReadme = plugins.filter((p) => !p.version).slice(0, 10);
  const versions = new Map<string, { version: string | null; source: 'asset_ver' | 'readme' | null }>();
  for (const p of plugins) versions.set(p.slug, { version: p.version, source: p.versionSource });
  for (const p of needReadme) {
    const r = await fetchPublic(new URL(`/wp-content/plugins/${encodeURIComponent(p.slug)}/readme.txt`, site.url).toString(), { method: 'GET', maxBytes: 64_000, timeoutMs: 10_000, budget });
    if (r.ok && r.body) {
      const tag = parseStableTag(r.body);
      if (tag) versions.set(p.slug, { version: tag, source: 'readme' });
    }
  }

  // ---- active theme version from style.css
  let themeVersion: string | null = null;
  if (themes.activeSlug) {
    const css = await fetchPublic(new URL(`/wp-content/themes/${encodeURIComponent(themes.activeSlug)}/style.css`, site.url).toString(), { method: 'GET', maxBytes: 64_000, timeoutMs: 10_000, budget });
    if (css.ok && css.body) themeVersion = parseStyleCssVersion(css.body);
  }

  // ---- latest versions from wp.org (cache-first), ≤15 lookups per invocation
  const components: ComponentWrite[] = [];
  let lookupsLeft = 15; // spec: at most 15 wp.org lookups per invocation
  const lookup = async (kind: 'plugin' | 'theme', slug: string) => {
    if (lookupsLeft <= 0) return null;
    lookupsLeft--;
    return await getComponentLatest(db, kind, slug, budget);
  };

  for (const p of plugins) {
    const v = versions.get(p.slug)!;
    const latest = await lookup('plugin', p.slug);
    if (!latest) {
      components.push({ type: 'plugin', slug: p.slug, detectedVersion: v.version, versionSource: v.source, latestVersion: null, outdated: false, status: 'premium_unknown' });
      continue;
    }
    if (latest.notFound) {
      components.push({ type: 'plugin', slug: p.slug, detectedVersion: v.version, versionSource: v.source, latestVersion: null, outdated: false, status: 'premium_unknown' });
      continue;
    }
    if (!v.version) {
      components.push({ type: 'plugin', slug: p.slug, detectedVersion: null, versionSource: null, latestVersion: latest.latest, outdated: false, status: 'version_hidden' });
      continue;
    }
    components.push({ type: 'plugin', slug: p.slug, detectedVersion: v.version, versionSource: v.source, latestVersion: latest.latest, outdated: isOutdated(v.version, latest.latest), status: 'checked' });
  }

  for (const slug of themes.slugs) {
    const isThemeActive = slug === themes.activeSlug;
    const v = isThemeActive ? themeVersion : null;
    const latest = await lookup('theme', slug);
    if (!latest || latest.notFound) {
      components.push({ type: 'theme', slug, detectedVersion: v, versionSource: v ? 'style_css' : null, latestVersion: null, outdated: false, status: 'premium_unknown' });
      continue;
    }
    if (!v) {
      components.push({ type: 'theme', slug, detectedVersion: null, versionSource: null, latestVersion: latest.latest, outdated: false, status: 'version_hidden' });
      continue;
    }
    components.push({ type: 'theme', slug, detectedVersion: v, versionSource: 'style_css', latestVersion: latest.latest, outdated: isOutdated(v, latest.latest), status: 'checked' });
  }

  const updatesCount =
    components.filter((c) => c.outdated).length + (coreOutdated ? 1 : 0);

  return { wpVersion, wpVersionSource, wpLatest, coreOutdated, wpDetected, components, updatesCount };
}

/** Persist a scan (one batch: upsert fingerprint row, replace components). */
export async function writeScan(db: Db, siteId: number, scan: FingerprintResult, scannedAt: string): Promise<void> {
  const fp = db.insert(wpFingerprints).values({
    siteId, scannedAt,
    wpVersion: scan.wpVersion, wpVersionSource: scan.wpVersionSource,
    wpLatest: scan.wpLatest, coreOutdated: scan.coreOutdated, wpDetected: scan.wpDetected,
  }).onConflictDoUpdate({
    target: wpFingerprints.siteId,
    set: {
      scannedAt,
      wpVersion: scan.wpVersion, wpVersionSource: scan.wpVersionSource,
      wpLatest: scan.wpLatest, coreOutdated: scan.coreOutdated, wpDetected: scan.wpDetected,
    },
  });
  const del = db.delete(siteComponents).where(eq(siteComponents.siteId, siteId));
  const ins = scan.components.map((c) => db.insert(siteComponents).values({ siteId, ...c }));
  await db.batch([del, fp, ...ins] as unknown as Parameters<typeof db.batch>[0]);
}

export interface FingerprintJobReport {
  selected: number;
  scanned: number;
  failed: number;
  subrequests: number;
}

/** Hourly slice: ≤2 sites, least-recently-scanned across all users. */
export async function runFingerprintJob(env: Env, db: Db = makeDb(env)): Promise<FingerprintJobReport> {
  const budget = makeBudget(45);
  const batchSize = Number(env.FINGERPRINT_BATCH ?? 2);
  const sitesToScan = await selectFingerprintBatch(db, batchSize);
  const report: FingerprintJobReport = { selected: sitesToScan.length, scanned: 0, failed: 0, subrequests: 0 };

  for (const s of sitesToScan) {
    const home = await fetchPublic(s.url, { method: 'GET', maxBytes: 1_500_000, timeoutMs: 10_000 });
    if (!home.ok || !home.body) {
      report.failed++;
      // Mark scanned so a dead site doesn't block the queue forever.
      await db.update(sites).set({ lastScannedAt: nowIso() }).where(eq(sites.id, s.id)).run().catch(() => {});
      continue;
    }
    const scan = await scanSite(db, s, budget, home.body);
    if (scan) {
      await writeScan(db, s.id, scan, nowIso());
      report.scanned++;
    } else {
      report.failed++;
    }
    await db.update(sites).set({ lastScannedAt: nowIso() }).where(eq(sites.id, s.id)).run();
  }
  report.subrequests = budget.n;
  console.log(`[fingerprint] selected=${report.selected} scanned=${report.scanned} failed=${report.failed} subrequests=${report.subrequests}`);
  return report;
}
