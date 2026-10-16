import { eq, and, asc, count, or, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { sites, blockedDomains, users, checks, pagespeedResults } from '../schema';
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
  name: string;
  ownerId: number;
  currentStatus: 'up' | 'down' | 'unknown';
  consecutiveFailures: number;
  statusChangedAt: string | null;
}

export async function selectUptimeBatch(db: Db, limit: number, minIntervalMs: number): Promise<JobSite[]> {
  const cutoff = new Date(Date.now() - minIntervalMs).toISOString();
  const res = await db
    .select({
      id: sites.id,
      url: sites.url,
      name: sites.name,
      ownerId: sites.ownerId,
      currentStatus: sites.currentStatus,
      consecutiveFailures: sites.consecutiveFailures,
      statusChangedAt: sites.statusChangedAt,
    })
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

/**
 * Persist one uptime slice in a SINGLE D1 round trip: one checks INSERT and
 * one sites UPDATE per checked site.
 */
export interface CheckWrite {
  siteId: number;
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
  siteUpdate: {
    lastCheckedAt: string;
    lastResponseMs: number | null;
    currentStatus: 'up' | 'down' | 'unknown';
    consecutiveFailures: number;
    statusChangedAt?: string;
  };
}

export async function writeCheckResults(db: Db, results: CheckWrite[]): Promise<void> {
  if (results.length === 0) return;
  const stmts = results.flatMap((r) => [
    db.insert(checks).values({
      siteId: r.siteId,
      checkedAt: r.checkedAt,
      ok: r.ok,
      statusCode: r.statusCode,
      responseMs: r.responseMs,
      error: r.error,
    }),
    db.update(sites).set(r.siteUpdate).where(eq(sites.id, r.siteId)),
  ]);
  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
}

// ------------------------------------------------------------- pagespeed

/**
 * INTERNAL (pagespeed job): eligible sites ordered by their LEAST RECENT
 * PageSpeed test across all users (never tested → first). Fair across users.
 */
export async function selectPageSpeedBatch(db: Db, limit: number): Promise<JobSite[]> {
  const lastPs = sql`(SELECT MAX(pr.checked_at) FROM pagespeed_results pr WHERE pr.site_id = sites.id)`;
  const res = await db
    .select({
      id: sites.id,
      url: sites.url,
      name: sites.name,
      ownerId: sites.ownerId,
      currentStatus: sites.currentStatus,
      consecutiveFailures: sites.consecutiveFailures,
      statusChangedAt: sites.statusChangedAt,
    })
    .from(sites)
    .innerJoin(users, eq(sites.ownerId, users.id))
    .where(and(eq(users.status, 'approved'), isNotNull(sites.verifiedAt), eq(sites.active, true)))
    .orderBy(sql`${lastPs} IS NULL DESC`, sql`${lastPs} ASC`, asc(sites.id))
    .limit(limit)
    .all();
  return res as JobSite[];
}

export async function writePageSpeedResults(db: Db, results: Array<{ siteId: number; score: number }>, checkedAt: string): Promise<void> {
  if (results.length === 0) return;
  const stmts = results.map((r) =>
    db.insert(pagespeedResults).values({ siteId: r.siteId, checkedAt, performanceScore: r.score, strategy: 'mobile' }),
  );
  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
}

// ------------------------------------------------------------- fingerprint

/**
 * INTERNAL (fingerprint job): eligible sites ordered by LEAST RECENT scan
 * across all users (never scanned → first).
 */
export async function selectFingerprintBatch(db: Db, limit: number): Promise<JobSite[]> {
  const res = await db
    .select({
      id: sites.id,
      url: sites.url,
      name: sites.name,
      ownerId: sites.ownerId,
      currentStatus: sites.currentStatus,
      consecutiveFailures: sites.consecutiveFailures,
      statusChangedAt: sites.statusChangedAt,
    })
    .from(sites)
    .innerJoin(users, eq(sites.ownerId, users.id))
    .where(and(eq(users.status, 'approved'), isNotNull(sites.verifiedAt), eq(sites.active, true)))
    .orderBy(sql`COALESCE(${sites.lastScannedAt}, '1970-01-01T00:00:00.000Z') ASC`)
    .limit(limit)
    .all();
  return res as JobSite[];
}

// ------------------------------------------------------------- detail page

import { checks as checksT, pagespeedResults as psT, sslStatus as sslT, wpFingerprints as fpT, siteComponents as compT } from '../schema';

export interface CheckRow {
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
}

/** ISOLATION: siteId must belong to userId (checked by the route via findSiteForUser). */
export async function listRecentChecks(db: Db, siteId: number, limit: number, sinceIso?: string): Promise<CheckRow[]> {
  const conds = [eq(checksT.siteId, siteId)];
  if (sinceIso) conds.push(sql`${checksT.checkedAt} >= ${sinceIso}`);
  return await db
    .select({ checkedAt: checksT.checkedAt, ok: checksT.ok, statusCode: checksT.statusCode, responseMs: checksT.responseMs, error: checksT.error })
    .from(checksT)
    .where(and(...conds))
    .orderBy(sql`${checksT.checkedAt} DESC`)
    .limit(limit)
    .all();
}

export async function uptimePct(db: Db, siteId: number, sinceIso: string): Promise<number | null> {
  const row = await db
    .select({
      total: count(),
      okCount: sql<number>`SUM(CASE WHEN ${checksT.ok} THEN 1 ELSE 0 END)`,
    })
    .from(checksT)
    .where(and(eq(checksT.siteId, siteId), sql`${checksT.checkedAt} >= ${sinceIso}`))
    .get();
  if (!row || row.total === 0) return null;
  return Math.round(((row.okCount ?? 0) / row.total) * 1000) / 10;
}

export async function listPageSpeedHistory(db: Db, siteId: number, limit = 30): Promise<Array<{ checkedAt: string; score: number | null }>> {
  return await db
    .select({ checkedAt: psT.checkedAt, score: psT.performanceScore })
    .from(psT)
    .where(eq(psT.siteId, siteId))
    .orderBy(sql`${psT.checkedAt} DESC`)
    .limit(limit)
    .all();
}

export async function latestSsl(db: Db, siteId: number) {
  return await db
    .select({ checkedAt: sslT.checkedAt, validTo: sslT.validTo, daysLeft: sslT.daysLeft, issuer: sslT.issuer, state: sslT.state })
    .from(sslT)
    .where(eq(sslT.siteId, siteId))
    .orderBy(sql`${sslT.checkedAt} DESC`)
    .limit(1)
    .get();
}

export async function latestFingerprint(db: Db, siteId: number) {
  return await db.select().from(fpT).where(eq(fpT.siteId, siteId)).get();
}

export async function listComponents(db: Db, siteId: number) {
  return await db
    .select()
    .from(compT)
    .where(eq(compT.siteId, siteId))
    .orderBy(sql`CASE ${compT.outdated} WHEN 1 THEN 0 ELSE 1 END ASC`, asc(compT.type), asc(compT.slug))
    .all();
}

// ------------------------------------------------------------- dashboard

export type SiteFilter = 'all' | 'up' | 'down' | 'updates' | 'ssl';
export type SiteSort = 'name' | 'status' | 'pagespeed' | 'load' | 'updates';

export interface DashboardRow {
  id: number;
  name: string;
  url: string;
  currentStatus: 'up' | 'down' | 'unknown';
  verifiedAt: string | null;
  pagespeedScore: number | null;
  lastResponseMs: number | null;
  sslProblems: number;
  updatesCount: number | null; // null = not scanned yet → UI shows "?"
}

export interface DashboardPage {
  rows: DashboardRow[];
  total: number;
}

const STATUS_RANK = sql`CASE ${sites.currentStatus} WHEN 'down' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END`;
// NOTE: correlated subqueries reference the outer table as a literal
// `sites.id`, NOT `${sites.id}` — drizzle renders an embedded column in a raw
// sql fragment as a bare `"id"`, which does NOT correlate to the outer row.
const LATEST_PS = sql`(SELECT pr.performance_score FROM pagespeed_results pr WHERE pr.site_id = sites.id ORDER BY pr.checked_at DESC LIMIT 1)`;
const SSL_PROBLEMS = sql`(SELECT CASE WHEN ss.state IS NULL OR ss.state = 'ok' THEN 0 ELSE 1 END FROM ssl_status ss WHERE ss.site_id = sites.id ORDER BY ss.checked_at DESC LIMIT 1)`;
const UPDATES_COUNT = sql`(SELECT COUNT(*) FROM site_components sc WHERE sc.site_id = sites.id AND sc.outdated = 1)`;
const HAS_FINGERPRINT = sql`EXISTS (SELECT 1 FROM wp_fingerprints wf WHERE wf.site_id = sites.id)`;

/** Workspace-wide metrics, always scoped to the signed-in owner. */
export async function dashboardSummaryForUser(db: Db, userId: number) {
  const row = await db.select({
    total: count(),
    online: sql<number>`COALESCE(SUM(CASE WHEN ${sites.currentStatus} = 'up' AND ${sites.verifiedAt} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
    down: sql<number>`COALESCE(SUM(CASE WHEN ${sites.currentStatus} = 'down' THEN 1 ELSE 0 END), 0)`,
    averageScore: sql<number | null>`AVG(${LATEST_PS})`,
  }).from(sites).where(eq(sites.ownerId, userId)).get();
  return row ?? { total: 0, online: 0, down: 0, averageScore: null };
}

/**
 * Server-side sort/filter/search/pagination for the dashboard table.
 * ISOLATION: userId is mandatory and always in the WHERE clause.
 */
export async function querySitesForUser(
  db: Db,
  userId: number,
  opts: { sort: SiteSort; filter: SiteFilter; search: string; page: number; perPage: number },
): Promise<DashboardPage> {
  const conds = [eq(sites.ownerId, userId)];
  if (opts.search) conds.push(sql`(${sites.name} LIKE ${'%' + opts.search + '%'} OR ${sites.url} LIKE ${'%' + opts.search + '%'})`);
  if (opts.filter === 'down') conds.push(eq(sites.currentStatus, 'down'));
  if (opts.filter === 'up') conds.push(and(eq(sites.currentStatus, 'up'), isNotNull(sites.verifiedAt))!);
  if (opts.filter === 'updates') conds.push(sql`${UPDATES_COUNT} > 0`);
  if (opts.filter === 'ssl') conds.push(sql`${SSL_PROBLEMS} > 0`);
  const where = and(...conds);

  const orderBy =
    opts.sort === 'status' ? [sql`${STATUS_RANK} ASC`, asc(sites.name)] :
    opts.sort === 'pagespeed' ? [sql`${LATEST_PS} IS NULL ASC`, sql`${LATEST_PS} ASC`] :
    opts.sort === 'load' ? [sql`${sites.lastResponseMs} IS NULL ASC`, asc(sites.lastResponseMs)] :
    opts.sort === 'updates' ? [sql`${HAS_FINGERPRINT} DESC`, sql`${UPDATES_COUNT} DESC`] :
    [asc(sites.name)];

  const totalRow = await db.select({ n: count() }).from(sites).where(where).get();
  const rows = await db
    .select({
      id: sites.id,
      name: sites.name,
      url: sites.url,
      currentStatus: sites.currentStatus,
      verifiedAt: sites.verifiedAt,
      pagespeedScore: LATEST_PS.as('pagespeedScore'),
      lastResponseMs: sites.lastResponseMs,
      sslProblems: SSL_PROBLEMS.as('sslProblems'),
      updatesCount: sql`CASE WHEN ${HAS_FINGERPRINT} THEN ${UPDATES_COUNT} ELSE NULL END`.as('updatesCount'),
    })
    .from(sites)
    .where(where)
    .orderBy(...orderBy)
    .limit(opts.perPage)
    .offset((opts.page - 1) * opts.perPage)
    .all();

  return { rows: rows as unknown as DashboardRow[], total: totalRow?.n ?? 0 };
}
