import type { Context, Next } from 'hono';

/**
 * CSRF protection: require a same-origin Origin (or Referer) header on every
 * state-changing request (POST/PUT/DELETE). Combined with SameSite=Lax
 * session cookies this blocks cross-site form forgery.
 *
 * Local dev (wrangler dev) sends no Origin on same-origin form posts in some
 * cases — allow requests WITHOUT an Origin header only when Host matches
 * localhost/127.0.0.1 or DEV_MODE is on.
 */
export function requireCsrf() {
  return async (c: Context, next: Next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      await next();
      return;
    }
    const origin = c.req.header('origin');
    const referer = c.req.header('referer');
    const reqHost = new URL(c.req.url).host;

    if (origin) {
      if (new URL(origin).host === reqHost) {
        await next();
        return;
      }
      return c.text('Forbidden', 403);
    }

    if (referer) {
      if (new URL(referer).host === reqHost) {
        await next();
        return;
      }
      return c.text('Forbidden', 403);
    }

    // No Origin/Referer at all — only allow for local dev hosts.
    if (reqHost.includes('localhost') || reqHost.startsWith('127.0.0.1')) {
      await next();
      return;
    }
    return c.text('Forbidden', 403);
  };
}
