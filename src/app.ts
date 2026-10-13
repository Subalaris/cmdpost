import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { authRoutes } from './routes/auth';
import { publicRoutes } from './routes/public';
import { settingsRoutes } from './routes/settings';
import { adminRoutes } from './routes/admin';
import { dashboardRoutes } from './routes/dashboard';
import { sitesRoutes } from './routes/sites';
import { sessionMiddleware, requireApproved, requireAdmin } from './middleware/session';
import { loadConfig, warnDevMode } from './env';
import type { Env } from './env';

/**
 * Hono app factory. `env` is injected so the same app can run under
 * `wrangler dev`, `wrangler deploy`, or in vitest with a local D1 database.
 */
export function buildApp(env: Env) {
  warnDevMode(loadConfig(env));

  const app = new Hono<{ Bindings: Env }>();
  app.use(logger());

  app.onError((err, c) => {
    // Never leak stack traces or secrets to the client.
    console.error('unhandled error', err);
    return c.text('Internal server error', 500);
  });

  app.notFound((c) => c.text('Not found', 404));

  // Static assets (public/styles.css) are served by Workers Assets.

  // Public (no session required)
  app.route('/', publicRoutes());
  app.route('/', authRoutes());

  // Authenticated — middleware per path, then the sub-app.
  // Sub-apps declare FULL paths internally, so they are mounted at '/'.
  // Hono `app.use(path)` matches that path EXACTLY — sub-paths (e.g.
  // /settings/logout-all) need an explicit `path/*` registration, so both
  // forms are registered for each prefix.
  const approved = (p: string) => app.use(p, sessionMiddleware(env), requireApproved);
  approved('/dashboard');
  approved('/dashboard/*');
  approved('/sites');
  approved('/sites/*');
  approved('/settings');
  approved('/settings/*');

  app.route('/', dashboardRoutes());
  app.route('/', sitesRoutes());
  app.route('/', settingsRoutes());

  const admin = (p: string) => app.use(p, sessionMiddleware(env), requireAdmin);
  admin('/admin');
  admin('/admin/*');
  app.route('/', adminRoutes());

  return app;
}

/** Worker entry point: fetch handler. */
export const worker: ExportedHandler<Env> = {
  async fetch(request, env, _ctx) {
    return buildApp(env).fetch(request, env);
  },
};

export default worker;
