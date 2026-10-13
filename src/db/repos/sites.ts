import { eq, and, asc, count, or, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { sites, blockedDomains, users } from '../schema';
import { nowIso } from '../client';

export type SiteRow = typeof sites.$inferSelect;

/**
 * SITES repository — the ONLY place user-scoped site SQL lives.
 *
 * ISOLATION RULE: every function that reads/writes a specific site takes
 * userId and filters sites.owner_id = userId. A site owned by someone else
 * behaves exactly like a missing site (undefined / no-op) so routes can
 * answer 404 — site IDs cannot be probed.
 */

// ------------------------------------------------------------------ caps

export interface CapCheck {
  ok: boolean;
  reason?: 'per_user' | 'total' | 'blocked' | 'duplicate';
  detail?: string;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Normalize an input URL: https preferred, no trailing slash, host+path kept. */
export function normalizeUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  return s;
}

export async function checkAddSiteCaps(
  db: Db,
  userId: number,
  url: string,
  maxSitesPerUser: number,
  maxSitesTotal: number,
): Promise<CapCheck> {
  const domain = domainOf(url);
  if (!domain) return { ok: false, reason: 'blocked', detail: 'Invalid URL.' };

  const blocked = await db.select().from(blockedDomains).where(eq(blockedDomains.domain, domain)).get();
  if (blocked) {
    return {
      ok: false,
      reason: 'blocked',
      detail: `${domain} is on the monitoring blocklist. The domain owner can request removal via the abuse contact in the footer.`,
    };
  }

  const mine = await db.select({ id: sites.id, url: sites.url }).from(sites).where(eq(sites.ownerId, userId)).all();
  if (mine.length >= maxSitesPerUser) {
    return {
      ok: false,
      reason: 'per_user',
      detail: `Per-user limit reached (${maxSitesPerUser} sites). Pause or delete a site first.`,
    };
  }
  if (mine.some((r) => r.url === url)) {
    return { ok: false, reason: 'duplicate', detail: 'You are already monitoring this URL.' };
  }

  const total = await db.select({ n: count() }).from(sites).get();
  if ((total?.n ?? 0) >= maxSitesTotal) {
    return { ok: false, reason: 'total', detail: `The shared monitoring pool is full (${maxSitesTotal} sites). Try again later.` };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ CRUD

export async function addSite(
  db: Db,
  input: { userId: number; url: string; name?: string; notes?: string },
  verificationToken: string,
): Promise<SiteRow | undefined> {
  const url = normalizeUrl(input.url);
  const name = (input.name ?? '').trim() || domainOf(url);
  return await db
    .insert(sites)
    .values({
      ownerId: input.userId,
      url,
      name,
      active: true,
      notes: input.notes ?? null,
      verificationToken,
      currentStatus: 'unknown',
      consecutiveFailures: 0,
      createdAt: nowIso(),
    })
    .onConflictDoNothing()
    .returning()
    .get();
}

/** Fetch one site ONLY if it belongs to userId (otherwise undefined → 404). */
export async function findSiteForUser(db: Db, userId: number, siteId: number): Promise<SiteRow | undefined> {
  return await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.ownerId, userId))).get();
}

export async function listSitesForUser(db: Db, userId: number): Promise<SiteRow[]> {
  return await db.select().from(sites).where(eq(sites.ownerId, userId)).orderBy(asc(sites.createdAt)).all();
}

export async function countSitesForUser(db: Db, userId: number): Promise<number> {
  const row = await db.select({ n: count() }).from(sites).where(eq(sites.ownerId, userId)).get();
  return row?.n ?? 0;
}

export async function updateSiteForUser(
  db: Db,
  userId: number,
  siteId: number,
  patch: { name?: string; notes?: string; active?: boolean },
): Promise<SiteRow | undefined> {
  const set: Partial<typeof sites.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.active !== undefined) set.active = patch.active;
  return await db.update(sites).set(set).where(and(eq(sites.id, siteId), eq(sites.ownerId, userId))).returning().get();
}

export async function deleteSiteForUser(db: Db, userId: number, siteId: number): Promise<boolean> {
  const res = await db.delete(sites).where(and(eq(sites.id, siteId), eq(sites.ownerId, userId))).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function resetVerificationToken(
  db: Db,
  userId: number,
  siteId: number,
  token: string,
): Promise<SiteRow | undefined> {
  return await db
    .update(sites)
    .set({
      verificationToken: token,
      verifiedAt: null,
      verificationMethod: null,
      currentStatus: 'unknown',
      consecutiveFailures: 0,
    })
    .where(and(eq(sites.id, siteId), eq(sites.ownerId, userId)))
    .returning()
    .get();
}

export async function markVerified(
  db: Db,
  userId: number,
  siteId: number,
  method: 'dns' | 'meta' | 'file',
): Promise<SiteRow | undefined> {
  return await db
    .update(sites)
    .set({ verifiedAt: nowIso(), verificationMethod: method, currentStatus: 'unknown', consecutiveFailures: 0 })
    .where(and(eq(sites.id, siteId), eq(sites.ownerId, userId)))
    .returning()
    .get();
}

// ------------------------------------------------------------ job queries
// INTERNAL — scheduled jobs only. Eligibility = approved user + verified +
// active. Ordered by last-checked time ACROSS ALL USERS (fairness), LIMIT n.

export interface JobSite {
  id: number;
  url: string;
  ownerId: number;
}

export async function selectUptimeBatch(db: Db, limit: number, minIntervalMs: number): Promise<JobSite[]> {
  const cutoff = new Date(Date.now() - minIntervalMs).toISOString();
  const res = await db
    .select({ id: sites.id, url: sites.url, ownerId: sites.ownerId })
    .from(sites)
    .innerJoin(users, eq(sites.ownerId, users.id))
    .where(
      and(
        eq(users.status, 'approved'),
        isNotNull(sites.verifiedAt),
        eq(sites.active, true),
        or(isNull(sites.lastCheckedAt), sql`${sites.lastCheckedAt} < ${cutoff}`),
      ),
    )
    .orderBy(sql`COALESCE(${sites.lastCheckedAt}, '1970-01-01T00:00:00.000Z') ASC`)
    .limit(limit)
    .all();
  return res as JobSite[];
}
