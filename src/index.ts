import { buildApp } from './app';
import { runUptimeJob } from './jobs/uptime';
import { runPageSpeedJob } from './jobs/pagespeed';
import { runFingerprintJob } from './jobs/fingerprint';
import { makeDb } from './db/client';
import type { Env } from './env';

/**
 * Cloudflare Worker entry (wrangler `main`).
 * - fetch: the Hono app
 * - scheduled: 3 cron triggers (see wrangler.jsonc `triggers.crons`),
 *   dispatched on `event.cron`:
 *     every 5 min  → uptime checks (≤25 sites, parallel, no body reads)
 *     hourly       → PageSpeed (≤5) + WordPress fingerprint slice (≤2)
 *     03:00 UTC    → daily: wp_org_cache refresh, aggregation, pruning,
 *                      expired sessions/tokens cleanup
 */
const handler = {
  fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return buildApp(env).fetch(request, env);
  },

  async scheduled(event: ScheduledEvent, env: Env) {
    // DEV_MODE normally skips real outbound traffic; allow an explicit opt-in
    // (RUN_JOBS_IN_DEV=true) so `wrangler dev --test-scheduled` can be tested.
    if (env.DEV_MODE === 'true' && env.RUN_JOBS_IN_DEV !== 'true') {
      console.warn(`[scheduled] ${event.cron} skipped: DEV_MODE=true (set RUN_JOBS_IN_DEV=true to run jobs locally)`);
      return;
    }
    const cron = event.cron;
    const db = makeDb(env);
    try {
      if (cron === '*/5 * * * *') {
        await runUptimeJob(env, db);
      } else if (cron === '0 * * * *') {
        await runPageSpeedJob(env, db);
        await runFingerprintJob(env, db);
      } else {
        // daily 03:00 UTC: aggregation/pruning/cleanup (milestone 8)
        console.log('[scheduled] daily — aggregation/pruning pending (milestone 8)');
      }
    } catch (err) {
      // Never let one bad slice kill the cron; log without leaking secrets.
      console.error(`[scheduled] ${cron} failed:`, err instanceof Error ? err.message : 'unknown');
    }
  },
};

export default handler;
export { handler };
