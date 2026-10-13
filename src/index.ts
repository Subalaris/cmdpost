import { buildApp } from './app';
import type { Env } from './env';

/**
 * Cloudflare Worker entry (wrangler `main`).
 * - fetch: the Hono app
 * - scheduled: 3 cron triggers (see wrangler.jsonc `triggers.crons`),
 *   dispatched on `event.cron`. The concrete jobs arrive in milestones 3–8:
 *     every 5 min  → uptime checks (≤25 sites, parallel, no body reads)
 *     hourly       → PageSpeed (≤5) + WordPress fingerprint slice (≤2)
 *     03:00 UTC    → daily: wp_org_cache refresh, aggregation, pruning,
 *                      expired sessions/tokens cleanup
 * Jobs are wired in src/jobs/* once their milestones land.
 */
const handler = {
  fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return buildApp(env).fetch(request, env);
  },

  scheduled(event: ScheduledEvent, env: Env) {
    // Never run real monitoring under DEV_MODE (no outbound requests in dev).
    if (env.DEV_MODE === 'true') {
      console.warn(`[scheduled] ${event.cron} skipped: DEV_MODE=true`);
      return;
    }
    // Milestone 3+ dispatches the real jobs here (src/jobs/*).
    console.log(`[scheduled] ${event.cron} — job dispatch pending (milestone 3+)`);
  },
};

export default handler;
export { handler };
