/**
 * PageSpeed job (cron: hourly).
 *
 * - ≤5 sites per invocation, the LEAST recently tested eligible sites
 *   (mobile strategy), so each site refreshes roughly daily.
 * - Google PageSpeed Insights API v5; stores the performance score 0–100.
 * - 429/quota errors → skip the site, retry next run (no failure recorded).
 * - No PAGESPEED_API_KEY → job skips entirely (UI shows "n/a").
 * - Shares the subrequest budget; writes results in one batch().
 */
import { makeDb, nowIso, type Db } from '../db/client';
import { selectPageSpeedBatch, writePageSpeedResults, type JobSite } from '../db/repos/sites';
import { validatePublicUrl, MONITOR_UA } from '../lib/ssrf';
import { makeBudget, type SubrequestBudget } from './uptime';
import type { Env } from '../env';

export interface PageSpeedOutcome {
  siteId: number;
  /** null = skipped (quota/error) — do not record a result. */
  score: number | null;
  skipped?: boolean;
  error?: string;
}

/**
 * Call PSI v5 for one URL (mobile, performance category only — smaller and
 * faster than a full audit). Pure network + parse; never throws.
 * Exported separately so tests can stub fetch.
 */
export async function fetchPageSpeedScore(
  apiKey: string,
  siteUrl: string,
  budget: SubrequestBudget,
): Promise<PageSpeedOutcome | null> {
  const v = validatePublicUrl(siteUrl);
  if (!v.ok) return null; // shouldn't happen (verified sites), but never fetch an invalid URL
  if (!budget.take()) return null;

  const endpoint =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(siteUrl)}&strategy=mobile&category=performance&key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { 'User-Agent': MONITOR_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(55_000), // PSI can take ~30-60 s for cold audits
    });
  } catch {
    return { siteId: 0, score: null, skipped: true, error: 'timeout' };
  }

  if (res.status === 429 || res.status === 503) {
    return { siteId: 0, score: null, skipped: true, error: `quota_${res.status}` };
  }
  if (!res.ok) {
    // PSI returns 200 with an error body for per-URL failures too; a hard
    // non-200 here is an API-key/quota problem — skip, retry next run.
    return { siteId: 0, score: null, skipped: true, error: `http_${res.status}` };
  }

  try {
    const data = (await res.json()) as {
      lighthouseResult?: { categories?: { performance?: { score?: number } } };
      error?: { code?: number; message?: string };
    };
    if (data.error) {
      const code = data.error.code ?? 0;
      // 429/403 inside a 200 envelope = quota/key issue → skip, not a site failure.
      return { siteId: 0, score: null, skipped: true, error: `psi_${code}` };
    }
    const raw = data.lighthouseResult?.categories?.performance?.score;
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
      return { siteId: 0, score: null, skipped: true, error: 'no_score' };
    }
    const score = Math.max(0, Math.min(100, Math.round(raw * 100)));
    return { siteId: 0, score };
  } catch {
    return { siteId: 0, score: null, skipped: true, error: 'bad_json' };
  }
}

export interface PageSpeedJobReport {
  selected: number;
  recorded: number;
  skipped: number;
  subrequests: number;
}

export async function runPageSpeedJob(env: Env, db: Db = makeDb(env)): Promise<PageSpeedJobReport> {
  const report: PageSpeedJobReport = { selected: 0, recorded: 0, skipped: 0, subrequests: 0 };
  if (!env.PAGESPEED_API_KEY) {
    console.log('[pagespeed] skipped: PAGESPEED_API_KEY not set (UI shows n/a)');
    return report;
  }

  const budget = makeBudget(45);
  const batchSize = Number(env.PAGESPEED_BATCH ?? 5);
  const sites = await selectPageSpeedBatch(db, batchSize);
  report.selected = sites.length;
  if (sites.length === 0) return report;

  const results = await Promise.allSettled(
    sites.map(async (s) => ({ site: s, out: await fetchPageSpeedScore(env.PAGESPEED_API_KEY!, s.url, budget) })),
  );

  const now = nowIso();
  const writes: Array<{ siteId: number; score: number }> = [];
  for (const r of results) {
    if (r.status === 'rejected' || !r.value.out || r.value.out.skipped || r.value.out.score === null) {
      report.skipped++;
      continue; // quota/error/timeout → leave eligible for the next run
    }
    writes.push({ siteId: r.value.site.id, score: r.value.out.score });
    report.recorded++;
  }

  if (writes.length > 0) await writePageSpeedResults(db, writes, now);
  report.subrequests = budget.n;
  console.log(`[pagespeed] selected=${report.selected} recorded=${report.recorded} skipped=${report.skipped} subrequests=${report.subrequests}`);
  return report;
}
