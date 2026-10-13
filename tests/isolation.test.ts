import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestEnv, seedUser } from './helpers/seed';
import { makeDb, nowIso } from '../src/db/client';
import {
  addSite,
  findSiteForUser,
  listSitesForUser,
  countSitesForUser,
  updateSiteForUser,
  deleteSiteForUser,
  checkAddSiteCaps,
  markVerified,
  resetVerificationToken,
  selectUptimeBatch,
} from '../src/db/repos/sites';
import { randomToken } from '../src/lib/tokens';

let env: ReturnType<typeof makeTestEnv>;
let userA: number;
let userB: number;

beforeEach(async () => {
  env = makeTestEnv({ MAX_SITES_PER_USER: '3', MAX_SITES_TOTAL: '5' });
  userA = await seedUser(env, { email: 'a@example.com' });
  userB = await seedUser(env, { email: 'b@example.com' });
});

describe('sites repository — isolation (Milestone 1 acceptance)', () => {
  it('addSite stores the site owned by the requesting user only', async () => {
    const db = makeDb(env as never);
    const site = await addSite(db, { userId: userA, url: 'https://site-a.example.com' }, randomToken(32));
    expect(site).toBeDefined();
    expect(site?.ownerId).toBe(userA);
    // B sees nothing.
    const bSites = await listSitesForUser(db, userB);
    expect(bSites).toHaveLength(0);
  });

  it('two users may add the same URL; each gets their own row (UNIQUE is per owner)', async () => {
    const db = makeDb(env as never);
    const a1 = await addSite(db, { userId: userA, url: 'https://shared.example.com' }, randomToken(32));
    const b1 = await addSite(db, { userId: userB, url: 'https://shared.example.com' }, randomToken(32));
    expect(a1?.id).not.toBe(b1?.id);
    expect(a1?.ownerId).toBe(userA);
    expect(b1?.ownerId).toBe(userB);
  });

  it("A cannot read B's site by ID (undefined → route 404)", async () => {
    const db = makeDb(env as never);
    const b1 = await addSite(db, { userId: userB, url: 'https://b-only.example.com' }, randomToken(32));
    const asView = await findSiteForUser(db, userA, b1!.id);
    expect(asView).toBeUndefined();
    // B can read their own.
    const bsView = await findSiteForUser(db, userB, b1!.id);
    expect(bsView?.url).toBe('https://b-only.example.com');
  });

  it("A cannot edit B's site (no-op, returns undefined)", async () => {
    const db = makeDb(env as never);
    const b1 = await addSite(db, { userId: userB, url: 'https://b2.example.com' }, randomToken(32));
    const result = await updateSiteForUser(db, userA, b1!.id, { name: 'hacked' });
    expect(result).toBeUndefined();
    const unchanged = await findSiteForUser(db, userB, b1!.id);
    expect(unchanged?.name).not.toBe('hacked');
  });

  it("A cannot pause/delete B's site", async () => {
    const db = makeDb(env as never);
    const b1 = await addSite(db, { userId: userB, url: 'https://b3.example.com' }, randomToken(32));
    const del = await deleteSiteForUser(db, userA, b1!.id);
    expect(del).toBe(false);
    const stillThere = await findSiteForUser(db, userB, b1!.id);
    expect(stillThere).toBeDefined();
  });

  it("A cannot verify B's site (markVerified no-ops)", async () => {
    const db = makeDb(env as never);
    const b1 = await addSite(db, { userId: userB, url: 'https://b4.example.com' }, 'secret-token-123');
    const result = await markVerified(db, userA, b1!.id, 'meta');
    expect(result).toBeUndefined();
    const b = await findSiteForUser(db, userB, b1!.id);
    expect(b?.verifiedAt).toBeNull();
  });

  it("A cannot reset B's verification token", async () => {
    const db = makeDb(env as never);
    const b1 = await addSite(db, { userId: userB, url: 'https://b5.example.com' }, 'old-token');
    const result = await resetVerificationToken(db, userA, b1!.id, 'attacker-token');
    expect(result).toBeUndefined();
    const b = await findSiteForUser(db, userB, b1!.id);
    expect(b?.verificationToken).toBe('old-token');
  });

  it('deleting A\'s site does not touch B\'s rows', async () => {
    const db = makeDb(env as never);
    const a1 = await addSite(db, { userId: userA, url: 'https://a1.example.com' }, randomToken(32));
    const b1 = await addSite(db, { userId: userB, url: 'https://b1.example.com' }, randomToken(32));
    await deleteSiteForUser(db, userA, a1!.id);
    expect(await findSiteForUser(db, userA, a1!.id)).toBeUndefined();
    expect(await findSiteForUser(db, userB, b1!.id)).toBeDefined();
  });
});

describe('sites — caps, blocklist, URL normalization', () => {
  it('per-user cap is enforced with a clear message', async () => {
    const db = makeDb(env as never);
    await addSite(db, { userId: userA, url: 'https://a1.example.com' }, randomToken(32));
    await addSite(db, { userId: userA, url: 'https://a2.example.com' }, randomToken(32));
    await addSite(db, { userId: userA, url: 'https://a3.example.com' }, randomToken(32));
    const check = await checkAddSiteCaps(db, userA, 'https://a4.example.com', 3, 5);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('per_user');
    expect(check.detail).toMatch(/limit/i);
  });

  it('total cap is enforced across users (a third user trips it after the per-user caps pass)', async () => {
    const db = makeDb(env as never);
    const userC = await seedUser(env, { email: 'c@example.com' });
    await addSite(db, { userId: userA, url: 'https://a1.example.com' }, randomToken(32));
    await addSite(db, { userId: userB, url: 'https://b1.example.com' }, randomToken(32));
    await addSite(db, { userId: userB, url: 'https://b2.example.com' }, randomToken(32));
    await addSite(db, { userId: userB, url: 'https://b3.example.com' }, randomToken(32));
    await addSite(db, { userId: userC, url: 'https://c1.example.com' }, randomToken(32));
    // Total = 5 = MAX_SITES_TOTAL. C is under their per-user cap, so the
    // TOTAL cap is what must reject.
    const check = await checkAddSiteCaps(db, userC, 'https://c2.example.com', 3, 5);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('total');
  });

  it('blocked domains are rejected with the abuse-contact hint', async () => {
    const db = makeDb(env as never);
    (env.DB as any).prepare('INSERT INTO blocked_domains (domain) VALUES (?)').bind('bad.example.com').run();
    const check = await checkAddSiteCaps(db, userA, 'https://bad.example.com/x', 3, 5);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('blocked');
    expect(check.detail).toMatch(/blocklist/i);
  });

  it('duplicate URL for the same user is rejected', async () => {
    const db = makeDb(env as never);
    await addSite(db, { userId: userA, url: 'https://dup.example.com' }, randomToken(32));
    const check = await checkAddSiteCaps(db, userA, 'https://dup.example.com', 3, 5);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('duplicate');
  });

  it('URL normalization: https preferred, trailing slash stripped, host+path kept', async () => {
    const db = makeDb(env as never);
    const s = await addSite(db, { userId: userA, url: 'http://norm.example.com/path/' }, randomToken(32));
    // Explicit scheme is preserved as typed (http-only sites may not serve
    // https — rewriting would break them); a BARE host is preferred to https.
    expect(s?.url).toBe('http://norm.example.com/path');
    const s2 = await addSite(db, { userId: userA, url: 'bare.example.com///' }, randomToken(32));
    expect(s2?.url).toBe('https://bare.example.com');
  });

  it('site name defaults to the domain', async () => {
    const db = makeDb(env as never);
    const s = await addSite(db, { userId: userA, url: 'https://named.example.com' }, randomToken(32));
    expect(s?.name).toBe('named.example.com');
  });
});

describe('job eligibility (spec: unverified sites receive ZERO monitoring requests)', () => {
  it('selectUptimeBatch excludes unverified, paused, and pending-user sites', async () => {
    const db = makeDb(env as never);
    const pendingUser = await seedUser(env, { email: 'pending2@example.com', status: 'pending' });

    // verified + active (A)
    const good = await addSite(db, { userId: userA, url: 'https://good.example.com' }, 'tok-good');
    await markVerified(db, userA, good!.id, 'meta');

    // unverified (A)
    const unverified = await addSite(db, { userId: userA, url: 'https://unverified.example.com' }, 'tok-unv');

    // verified but paused (A)
    const paused = await addSite(db, { userId: userA, url: 'https://paused.example.com' }, 'tok-paused');
    await markVerified(db, userA, paused!.id, 'meta');
    await updateSiteForUser(db, userA, paused!.id, { active: false });

    // verified site of a PENDING user
    const pendingSite = await addSite(db, { userId: pendingUser, url: 'https://pending-site.example.com' }, 'tok-pend');
    await markVerified(db, pendingUser, pendingSite!.id, 'meta');

    const batch = await selectUptimeBatch(db, 10, 5 * 60 * 1000);
    const urls = batch.map((s) => s.url);
    expect(urls).toContain('https://good.example.com');
    expect(urls).not.toContain('https://unverified.example.com');
    expect(urls).not.toContain('https://paused.example.com');
    expect(urls).not.toContain('https://pending-site.example.com');
  });

  it('min 5-minute interval per site is enforced (recently checked site skipped)', async () => {
    const db = makeDb(env as never);
    const s = await addSite(db, { userId: userA, url: 'https://recent.example.com' }, 'tok');
    await markVerified(db, userA, s!.id, 'meta');
    // Mark it as checked just now.
    (env.DB as any).prepare('UPDATE sites SET last_checked_at = ? WHERE id = ?').bind(nowIso(), s!.id).run();
    const batch = await selectUptimeBatch(db, 10, 5 * 60 * 1000);
    expect(batch.map((x) => x.url)).not.toContain('https://recent.example.com');
  });

  it('batches are bounded by the limit and ordered by last-checked time (fairness)', async () => {
    const db = makeDb(env as never);
    const mk = async (host: string, checkedAgoMin: number) => {
      const s = await addSite(db, { userId: userA, url: `https://${host}.example.com` }, 'tok');
      await markVerified(db, userA, s!.id, 'meta');
      if (checkedAgoMin > 0) {
        (env.DB as any)
          .prepare('UPDATE sites SET last_checked_at = ? WHERE id = ?')
          .bind(new Date(Date.now() - checkedAgoMin * 60000).toISOString(), s!.id)
          .run();
      }
      return s!;
    };
    // env cap is 3 per user — raise for this test by using both users + B's quota
    const a1 = await mk('oldest', 30);
    const a2 = await mk('older', 20);
    const a3 = await mk('newest', 10);
    const b1 = await mk('b-oldest', 40);

    // Oldest first across users: b-oldest (40m), oldest (30m), older (20m), newest (10m)
    const batch = await selectUptimeBatch(db, 2, 5 * 60 * 1000);
    expect(batch).toHaveLength(2);
    expect(batch[0].url).toContain('b-oldest');
    expect(batch[1].url).toContain('oldest');
  });
});
