import { eq, sql, count } from 'drizzle-orm';
import type { Db } from '../client';
import {
  users,
  sites,
  sessions,
  loginTokens,
  checks,
  dailyStats,
  pagespeedResults,
  sslStatus,
  wpFingerprints,
  siteComponents,
  alertLog,
} from '../schema';
import { nowIso } from '../client';

/**
 * User + admin repositories.
 * SECURITY: no function here may be called without an explicit userId where
 * user data is involved. Admins only ever see COUNTS (see countUsers/countSites).
 */

export type UserRow = typeof users.$inferSelect;

export class UserNotFoundError extends Error {}

// ---------------------------------------------------------------- users

export async function createUser(db: Db, input: {
  email: string;
  name: string;
  status: 'pending' | 'approved' | 'disabled';
  isAdmin: boolean;
}): Promise<UserRow> {
  const email = input.email.toLowerCase().trim();
  const inserted = await db
    .insert(users)
    .values({
      email,
      name: input.name || email.split('@')[0],
      status: input.status,
      isAdmin: input.isAdmin,
      alertEmail: email,
      createdAt: nowIso(),
    })
    .returning()
    .get();
  return inserted;
}

/** Look up by email. Returns undefined (NOT an error) when absent. */
export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  return await db.select().from(users).where(eq(users.email, email.toLowerCase().trim())).get();
}

export async function findUserById(db: Db, id: number): Promise<UserRow | undefined> {
  return await db.select().from(users).where(eq(users.id, id)).get();
}

export async function countUsers(db: Db): Promise<number> {
  const row = await db.select({ n: count() }).from(users).get();
  return row?.n ?? 0;
}

export interface AdminUserListRow {
  id: number;
  email: string;
  name: string;
  status: 'pending' | 'approved' | 'disabled';
  siteCount: number;
  createdAt: string;
}

/**
 * Admin list: users WITHOUT site URLs (spec: admins never see other users'
 * site URLs or data — counts only). Includes the caller's own email flagged.
 */
export async function listUsersForAdmin(
  db: Db,
): Promise<AdminUserListRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      createdAt: users.createdAt,
      siteCount: sql<number>`(SELECT COUNT(*) FROM sites WHERE sites.owner_id = ${users.id})`,
    })
    .from(users)
    .orderBy(users.createdAt)
    .all();
  return rows as unknown as AdminUserListRow[];
}

export async function setUserStatus(db: Db, userId: number, status: 'pending' | 'approved' | 'disabled'): Promise<void> {
  await db.update(users).set({ status }).where(eq(users.id, userId)).run();
}

export async function touchLastLogin(db: Db, userId: number): Promise<void> {
  await db.update(users).set({ lastLoginAt: nowIso() }).where(eq(users.id, userId)).run();
}

export async function updateUserSettings(
  db: Db,
  userId: number,
  settings: { name?: string; alertEmail?: string; webhookUrl?: string },
): Promise<UserRow | undefined> {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (settings.name !== undefined) patch.name = settings.name;
  if (settings.alertEmail !== undefined) patch.alertEmail = settings.alertEmail.toLowerCase().trim() || undefined;
  if (settings.webhookUrl !== undefined) patch.webhookUrl = settings.webhookUrl || undefined;
  const updated = await db.update(users).set(patch).where(eq(users.id, userId)).returning().get();
  return updated;
}

/**
 * Delete the account and EVERYTHING it owns.
 * FKs with ON DELETE CASCADE remove sessions, sites, and (transitively) all
 * child rows (checks, daily_stats, pagespeed, ssl, fingerprints, components).
 * alert_log rows are nulled (site_id is nullable). login_tokens are keyed by
 * email and are removed explicitly.
 */
export async function deleteUserCascade(db: Db, userId: number): Promise<void> {
  const user = await findUserById(db, userId);
  if (!user) return;
  await db.batch([
    db.delete(loginTokens).where(eq(loginTokens.email, user.email)),
    db.delete(users).where(eq(users.id, userId)),
  ]);
}

// ------------------------------------------------------------ counts (admin)

/** Site counts by user status — for the /admin dashboard. COUNTS only. */
export async function countSitesByUserStatus(db: Db): Promise<{ pending: number; approved: number; disabled: number }> {
  const rows = await db
    .select({
      status: users.status,
      n: sql<number>`(SELECT COUNT(*) FROM sites s WHERE s.owner_id = ${users.id})`,
    })
    .from(users)
    .all();
  const out = { pending: 0, approved: 0, disabled: 0 };
  for (const r of rows as unknown as { status: keyof typeof out; n: number }[]) {
    if (r.status in out) out[r.status] += r.n;
  }
  return out;
}

export async function countSitesTotal(db: Db): Promise<number> {
  const row = await db.select({ n: count() }).from(sites).get();
  return row?.n ?? 0;
}

// ------------------------------------------------------------ per-user counts

/** How many sites does this user have (drives the MAX_SITES_PER_USER cap). */
export async function countUserSites(db: Db, userId: number): Promise<number> {
  const row = await db.select({ n: count() }).from(sites).where(eq(sites.ownerId, userId)).get();
  return row?.n ?? 0;
}

/** Count of another user's sites is NEVER exposed; this one is internal (jobs/alerts). */
export async function isUserApproved(db: Db, userId: number): Promise<boolean> {
  const u = await findUserById(db, userId);
  return u?.status === 'approved';
}
