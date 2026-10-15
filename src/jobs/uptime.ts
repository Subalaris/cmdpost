/**
 * Uptime job (cron: every 5 minutes).
 *
 * - ≤25 sites per invocation, ordered by last-checked ACROSS ALL USERS
 *   (fair scheduling — one user can never starve another).
 * - Checked in parallel with Promise.allSettled.
 * - HEAD first, GET fallback on 405/501. Response BODIES ARE NEVER READ.
 * - Manual redirect following (max 3), every hop SSRF-validated.
 * - Subrequest counter: stop before exceeding 45 (Workers limit is 50).
 * - Results written with a single db.batch().
 * - State machine (src/lib/state-machine.ts) decides Up/Down; transitions
 *   are returned so the alert job (milestone 4) can consume them.
 */
import { makeDb, nowIso, type Db } from '../db/client';
import { selectUptimeBatch, writeCheckResults, type JobSite } from '../db/repos/sites';
import { applyCheck } from '../lib/state-machine';
import { validatePublicUrl, MONITOR_UA } from '../lib/ssrf';
import type { Env } from '../env';
import { loadConfig } from '../env';

export interface SubrequestBudget {
  n: number;
  max: number;
  /** Reserve one subrequest; false when the budget is exhausted. */
  take(): boolean;
}

export function makeBudget(max = 45): SubrequestBudget {
  return {
    n: 0,
    max,
    take() {
      if (this.n >= this.max) return false;
      this.n++;
      return true;
    },
  };
}

export interface UptimeResult {
  ok: boolean;
  status: number;
  responseMs: number | null;
  error?: string;
  /** True when the check never ran (budget exhausted) — do NOT record it. */
  skipped?: boolean;
}

/** Sentinel: fetch never happened because the subrequest budget ran out. */
const BUDGET_OUT = Symbol('budget');

async function timedFetch(url: string, method: 'HEAD' | 'GET', timeoutMs: number, budget: SubrequestBudget): Promise<Response | null | typeof BUDGET_OUT> {
  if (!budget.take()) return BUDGET_OUT;
  try {
    return await fetch(url, {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': MONITOR_UA, Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // timeout or network error
  }
}

/**
 * Check one site WITHOUT reading the body. HEAD → GET fallback on 405/501.
 * Never throws.
 */
export async function checkSite(rawUrl: string, budget: SubrequestBudget, timeoutMs = 10_000): Promise<UptimeResult> {
  let current = rawUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const v = validatePublicUrl(current);
    if (!v.ok) return { ok: false, status: 0, responseMs: null, error: `ssrf:${v.reason}` };

    const t0 = Date.now();
    let res = await timedFetch(v.url.toString(), 'HEAD', timeoutMs, budget);
    if (res === BUDGET_OUT) return { ok: false, status: 0, responseMs: null, error: 'budget', skipped: true };
    if (res === null) return { ok: false, status: 0, responseMs: null, error: 'timeout' };
    if (res.status === 405 || res.status === 501) {
      res.body?.cancel().catch(() => {});
      res = await timedFetch(v.url.toString(), 'GET', timeoutMs, budget);
      if (res === BUDGET_OUT) return { ok: false, status: 0, responseMs: null, error: 'budget', skipped: true };
      if (res === null) return { ok: false, status: 0, responseMs: null, error: 'timeout' };
    }
    const ms = Date.now() - t0;
    res.body?.cancel().catch(() => {}); // NEVER read the body

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: true, status: res.status, responseMs: ms }; // responded, nothing to follow
      try {
        current = new URL(loc, current).toString();
      } catch {
        return { ok: false, status: res.status, responseMs: ms, error: 'bad_redirect' };
      }
      continue;
    }
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, responseMs: ms, error: ok ? undefined : `http_${res.status}` };
  }
  return { ok: false, status: 0, responseMs: null, error: 'too_many_redirects' };
}

export interface UptimeJobReport {
  selected: number;
  checked: number;
  skipped: number;
  subrequests: number;
  transitions: Array<{ site: JobSite; transition: 'up-to-down' | 'down-to-up'; from: string; to: string }>;
}

/** Run one uptime slice. Called from the scheduled handler every 5 min. */
export async function runUptimeJob(env: Env, db: Db = makeDb(env)): Promise<UptimeJobReport> {
  const cfg = loadConfig(env);
  const batchSize = Number(env.UPTIME_BATCH ?? 25);
  const minIntervalMs = Number(env.UPTIME_MIN_INTERVAL_MS ?? 5 * 60 * 1000);
  const budget = makeBudget(45);

  const sites = await selectUptimeBatch(db, batchSize, minIntervalMs);
  const report: UptimeJobReport = { selected: sites.length, checked: 0, skipped: 0, subrequests: 0, transitions: [] };
  if (sites.length === 0) return report;

  const results = await Promise.allSettled(sites.map((s) => checkSite(s.url, budget)));

  const writes = [];
  const now = nowIso();
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const r = results[i];
    if (r.status === 'rejected') {
      report.skipped++;
      continue;
    }
    const res = r.value;
    if (res.skipped) {
      report.skipped++;
      continue; // budget exhausted — leave the site eligible for the next run
    }
    report.checked++;

    const next = applyCheck(
      { status: s.currentStatus, consecutiveFailures: s.consecutiveFailures },
      res.ok,
    );
    if (next.transition) {
      report.transitions.push({ site: s, transition: next.transition, from: s.currentStatus, to: next.status });
    }
    writes.push({
      siteId: s.id,
      checkedAt: now,
      ok: res.ok,
      statusCode: res.status || null,
      responseMs: res.responseMs,
      error: res.error ?? null,
      siteUpdate: {
        lastCheckedAt: now,
        lastResponseMs: res.responseMs,
        currentStatus: next.status,
        consecutiveFailures: next.consecutiveFailures,
        ...(next.changed ? { statusChangedAt: now } : {}),
      },
    });
  }

  if (writes.length > 0) await writeCheckResults(db, writes);
  report.subrequests = budget.n;
  if (report.transitions.length > 0) {
    // Milestone 4: hand report.transitions to the alert job (per-owner email/webhook).
    console.log(`[uptime] transitions: ${report.transitions.map((t) => `${t.site.url} ${t.transition}`).join(', ')}`);
  }
  console.log(`[uptime] selected=${report.selected} checked=${report.checked} skipped=${report.skipped} subrequests=${report.subrequests}`);
  return report;
}
