/**
 * WordPress.org latest-version lookups with the SHARED wp_org_cache table
 * (24 h TTL). This table is global by design: it only ever holds public
 * WordPress.org data, never user data.
 *
 * Verified live response shapes (2026-10):
 *  - core:   {"offers":[{"response":"upgrade","current":"7.1.3","version":"7.1.3",...},...]}
 *  - plugin: {"name":...,"slug":"akismet","version":"5.7.2",...}
 *            not found → {"error":"Plugin not found."}
 *  - theme:  {"name":...,"slug":"twentytwentyfour","version":"1.6",...}
 *            not found → {"error":"Theme not found."}
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { makeDb, nowIso, type Db } from '../db/client';
import { wpOrgCache } from '../db/schema';
import { MONITOR_UA } from './ssrf';
import type { SubrequestBudget } from '../jobs/uptime';

export type WpOrgKind = 'core' | 'plugin' | 'theme';

export interface WpOrgResult {
  latest: string | null;
  notFound: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000;

async function cacheGet(db: Db, type: WpOrgKind, slug: string): Promise<WpOrgResult | null> {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  const row = await db
    .select()
    .from(wpOrgCache)
    .where(and(eq(wpOrgCache.type, type), eq(wpOrgCache.slug, slug), gt(wpOrgCache.fetchedAt, cutoff)))
    .get();
  if (!row) return null;
  return { latest: row.latestVersion, notFound: row.notFound };
}

async function cachePut(db: Db, type: WpOrgKind, slug: string, res: WpOrgResult): Promise<void> {
  await db
    .insert(wpOrgCache)
    .values({ type, slug, latestVersion: res.latest, notFound: res.notFound, fetchedAt: nowIso() })
    .onConflictDoUpdate({
      target: [wpOrgCache.type, wpOrgCache.slug],
      set: { latestVersion: res.latest, notFound: res.notFound, fetchedAt: nowIso() },
    })
    .run();
}

async function fetchJson(url: string, budget: SubrequestBudget): Promise<unknown | null> {
  if (!budget.take()) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': MONITOR_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getCoreLatest(db: Db, budget: SubrequestBudget): Promise<WpOrgResult | null> {
  const cached = await cacheGet(db, 'core', 'wordpress');
  if (cached) return cached;
  const data = (await fetchJson('https://api.wordpress.org/core/version-check/1.7/', budget)) as
    | { offers?: { response?: string; current?: string; version?: string }[] }
    | null;
  const upgrade = data?.offers?.find((o) => o.response === 'upgrade') ?? data?.offers?.[0];
  const version = upgrade?.current ?? upgrade?.version ?? null;
  if (!version) return null; // API failure → don't cache a miss
  const res: WpOrgResult = { latest: version, notFound: false };
  await cachePut(db, 'core', 'wordpress', res);
  return res;
}

export async function getComponentLatest(
  db: Db,
  kind: 'plugin' | 'theme',
  slug: string,
  budget: SubrequestBudget,
): Promise<WpOrgResult | null> {
  const cached = await cacheGet(db, kind, slug);
  if (cached) return cached;
  const base = kind === 'plugin'
    ? 'https://api.wordpress.org/plugins/info/1.2/'
    : 'https://api.wordpress.org/themes/info/1.2/';
  const url = `${base}?action=${kind}_information&request%5Bslug%5D=${encodeURIComponent(slug)}`;
  const data = (await fetchJson(url, budget)) as { version?: string; error?: string } | null;
  if (!data) return null; // network/API failure → don't cache
  const res: WpOrgResult =
    typeof data.version === 'string'
      ? { latest: data.version, notFound: false }
      : { latest: null, notFound: true }; // {"error":"Plugin not found."} → premium/unknown
  await cachePut(db, kind, slug, res);
  return res;
}

/** Prune stale cache rows (daily job, milestone 8). */
export async function pruneWpOrgCache(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * TTL_MS).toISOString();
  const res = await db.delete(wpOrgCache).where(sql`${wpOrgCache.fetchedAt} < ${cutoff}`).run();
  return res.meta?.changes ?? 0;
}
