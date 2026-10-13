import type { Context, Next } from 'hono';
import { makeDb, nowIso } from '../db/client';
import { findSessionByToken, extendSession } from '../db/repos/auth';
import { findUserById } from '../db/repos/users';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

export const SESSION_COOKIE = 'wpmon_session';

/**
 * Session middleware:
 *  - reads the HttpOnly cookie, looks up the SHA-256 hash in D1
 *  - sets c.set('user', ...) for downstream handlers
 *  - sliding expiry (30 days from last use)
 * Invalid / missing cookie -> c.set('user', undefined); requireSession decides.
 */
export function sessionMiddleware(env: Env) {
  return async (c: Context, next: Next) => {
    const token = c.req.header('cookie')?.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    if (token) {
      const db = makeDb(env);
      const found = await findSessionByToken(db, token);
      if (found?.valid) {
        const user = await findUserById(db, found.session.userId);
        if (user) {
          void extendSession(db, found.session.tokenHash).catch(() => {}); // fire-and-forget; must not block the response
          c.set('user', user);
          c.set('sessionToken', token);
        }
      }
    }
    await next();
  };
}

/** Require a valid session. Redirects unauthenticated users to /login. */
export async function requireSession(c: Context, next: Next) {
  const user: UserRow | undefined = c.get('user');
  if (!user) {
    const url = new URL(c.req.url);
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`;
    return c.redirect(url.toString(), 302);
  }
  await next();
}

/** Require status = approved. Pending users get a "waiting" page, disabled get a 403. */
export async function requireApproved(c: Context, next: Next) {
  const user: UserRow | undefined = c.get('user');
  if (!user) return c.redirect('/login', 302);
  if (user.status === 'pending') {
    return c.html(renderWaitingPage(user), 200);
  }
  if (user.status === 'disabled') {
    return c.html(renderDisabledPage(), 403);
  }
  await next();
}

/** Require admin (is_admin AND approved). */
export async function requireAdmin(c: Context, next: Next) {
  const user: UserRow | undefined = c.get('user');
  if (!user || !user.isAdmin) {
    return c.notFound(); // 404 — don't reveal that an admin area exists
  }
  if (user.status !== 'approved') {
    return c.html(renderDisabledPage(), 403);
  }
  await next();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

function renderWaitingPage(user: UserRow): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>WPMonitor — awaiting approval</title>
<link rel="stylesheet" href="/styles.css"></head><body>
<header class="topbar"><div class="brand">WPMonitor</div></header>
<main class="container narrow">
  <h1>Awaiting approval</h1>
  <p>Hi ${esc(user.name)}, your account <strong>${esc(user.email)}</strong> has been created and is waiting for an administrator to approve it.</p>
  <p>You can sign in again at any time; this page will turn into your dashboard once you are approved.</p>
  <p class="muted">Signed in as ${esc(user.email)}</p>
  <form method="POST" action="/auth/logout"><button type="submit" class="btn">Sign out</button></form>
</main></body></html>`;
}

function renderDisabledPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>WPMonitor — account disabled</title>
<link rel="stylesheet" href="/styles.css"></head><body>
<header class="topbar"><div class="brand">WPMonitor</div></header>
<main class="container narrow">
  <h1>Account disabled</h1>
  <p>Your account has been disabled. Contact the administrator to restore access.</p>
  <form method="POST" action="/auth/logout"><button type="submit" class="btn">Sign out</button></form>
</main></body></html>`;
}
