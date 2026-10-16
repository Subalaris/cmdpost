import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { makeDb } from '../db/client';
import { randomToken } from '../lib/tokens';
import { sendEmail, baseUrlFor } from '../lib/email';
import { clientIp, rateLimit } from '../middleware/rateLimit';
import { rateLimitCheck } from '../db/repos/rateLimits';
import { requireCsrf } from '../middleware/csrf';
import { handleSignup } from '../middleware/signup';
import {
  createMagicToken,
  consumeMagicToken,
  createSession,
  deleteSessionByToken,
} from '../db/repos/auth';
import { findUserByEmail, touchLastLogin } from '../db/repos/users';
import type { Env } from '../env';
import { SESSION_COOKIE } from '../middleware/session';
import { loadConfig } from '../env';

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Invalid email address');

export function authRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // ------------------------------------------------------------------ login
  app.get('/login', (c) => {
    const cfg = loadConfig(c.env);
    const turnstile =
      cfg.turnstileSiteKey && c.env.DEV_MODE !== 'true'
        ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
           <div class="turnstile" data-sitekey="${cfg.turnstileSiteKey}"></div>`
        : '';
    const next = c.req.query('next') ?? '';
    const googleEnabled = !!cfg.googleClientId && !!cfg.googleClientSecret;
    return c.html(/* html */ `
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — cmdPost</title><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;650;700;750;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/styles.css"></head>
<body class="public-shell">
<header class="topbar"><a class="brand" href="/dashboard">cmdPost<span>·</span></a><nav><a href="/privacy">Privacy</a></nav></header>
<main class="container narrow card sign-in-card">
  <h1>Sign in or request access</h1>
  <p class="muted">Passwordless sign-in: we email you a one-time magic link (valid 15 minutes).</p>
  <form method="POST" action="/auth/magic-link" class="stack">
    <label>Email
      <input type="email" name="email" required autocomplete="email" placeholder="you@example.com">
    </label>
    ${next ? `<input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">` : ''}
    ${turnstile}
    <button type="submit" class="btn primary">Email me a sign-in link</button>
  </form>
  ${googleEnabled ? `<p class="or">or</p><a class="btn" href="/auth/google">Sign in with Google</a>` : ''}
  <p class="muted small">By continuing you agree to our <a href="/privacy">privacy policy</a>.</p>
</main>
<footer class="footer">cmdPost — monitoring only, never writes to your sites. · <a href="mailto:abuse@wpmonitor.example">abuse contact</a></footer>
</body></html>`);
  });

  // Magic-link request. Rate-limited per IP (5/hr) in middleware and per
  // email (5/hr) after the body is parsed — D1-backed, see repos/rateLimits.
  app.post(
    '/auth/magic-link',
    requireCsrf(),
    rateLimit({ prefix: 'magic:ip', limit: 5, windowMs: 60 * 60 * 1000 }, (c) => clientIp(c)),
    async (c) => {
      const body = await c.req.parseBody();
      const turnstileOk = await verifyTurnstileOrSkip(c);
      if (!turnstileOk) {
        return c.html(loginErrorPage('Verification failed. Please try again.'), 400);
      }
      const emailResult = emailSchema.safeParse(String(body.email ?? ''));
      if (!emailResult.success) {
        // Same page for all failures — no enumeration signal.
        return c.html(loginSuccessPage(), 200);
      }
      const email = emailResult.data;
      const name = String(body.name ?? '').slice(0, 100);
      const next = String(body.next ?? '').slice(0, 200);
      void next;

      // Per-email rate limit (parsed body is not available to middleware).
      const rl = await rateLimitCheck(makeDb(c.env), `magic:email:${email}`, 5, 60 * 60 * 1000);
      if (!rl.allowed) {
        c.header('Retry-After', String(rl.retryAfterSec));
        return c.html(loginErrorPage('Too many sign-in requests. Please wait a bit and try again.'), 429);
      }

      // Signup-mode logic (may create the user as pending).
      const decision = await handleSignup(c.env, email, name);

      // ALWAYS create the magic token + "send" the email — identical response
      // whether or not the email exists, whether or not signups are open.
      const db = makeDb(c.env);
      const token = randomToken(32);
      await createMagicToken(db, email, token);

      const base = baseUrlFor(c.env, c.req.raw);
      const link = `${base}/auth/magic-link/callback?token=${token}`;
      const html = `
<p>Welcome to WPMonitor!</p>
<p>Click the link below to sign in. It is valid for 15 minutes and can be used once.</p>
<p><a href="${link}">Sign in to WPMonitor</a></p>
<p>If you didn't request this, you can ignore this email.</p>
<p class="small muted">Or paste this URL into your browser:<br><code>${link}</code></p>`;
      await sendEmail(c.env, { to: email, subject: 'Your WPMonitor sign-in link', html });

      return c.html(loginSuccessPage(), 200);
    },
  );

  // Magic-link callback: consume the single-use token, create a session.
  app.get('/auth/magic-link/callback', async (c) => {
    const token = c.req.query('token') ?? '';
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return c.html(loginErrorPage('That sign-in link is invalid or has expired.'), 400);
    }
    const db = makeDb(c.env);
    const verdict = await consumeMagicToken(db, token);
    if (!verdict.ok) {
      return c.html(loginErrorPage('That sign-in link is invalid or has expired.'), 400);
    }

    // User must exist (created at signup or by an admin). If somehow not,
    // respond identically to a bad token.
    const user = await findUserByEmail(db, verdict.email);
    if (!user) {
      return c.html(loginErrorPage('That sign-in link is invalid or has expired.'), 400);
    }
    if (user.status === 'disabled') {
      return c.html(loginErrorPage('This account has been disabled. Contact the administrator.'), 403);
    }

    const sessionToken = randomToken(32);
    await createSession(db, user.id, sessionToken);
    await touchLastLogin(db, user.id);

    setSessionCookie(c, sessionToken);
    return c.redirect('/dashboard', 302);
  });

  // Logout (this browser)
  app.post('/auth/logout', async (c) => {
    const token = sessionTokenFrom(c);
    if (token) {
      await deleteSessionByToken(makeDb(c.env), token);
    }
    clearSessionCookie(c);
    return c.redirect('/login', 302);
  });

  app.get('/logout', (c) => c.redirect('/auth/logout', 302));

  return app;
}

// ------------------------------------------------------------------ helpers

function setSessionCookie(c: Context, token: string) {
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
  );
}

function clearSessionCookie(c: Context) {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function sessionTokenFrom(c: Context): string | undefined {
  return c.req.header('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

async function verifyTurnstileOrSkip(c: Context): Promise<boolean> {
  const cfg = loadConfig(c.env);
  if (c.env.DEV_MODE === 'true' || !cfg.turnstileSecretKey) return true;
  const body = await c.req.parseBody().catch(() => ({} as Record<string, string>));
  const token = body['cf-turnstile-response'];
  if (typeof token !== 'string' || !token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(cfg.turnstileSecretKey)}&response=${encodeURIComponent(token)}&origin=${cfg.appBaseUrl}`,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

function loginSuccessPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your email — cmdPost</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;650;700;750;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/styles.css"></head><body class="public-shell">
<header class="topbar"><a class="brand" href="/dashboard">cmdPost<span>·</span></a></header>
<main class="container narrow card">
  <h1>Check your email</h1>
  <p>We've sent you a sign-in link. It expires in 15 minutes and works once.</p>
  <p class="muted">Didn't get it? Check spam, or request another link <a href="/login">here</a> (rate-limited to 5 per hour).</p>
</main></body></html>`;
}

function loginErrorPage(msg: string) {
  const esc = msg.replace(/[&<>]/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[s]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in — cmdPost</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;650;700;750;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/styles.css"></head><body class="public-shell">
<header class="topbar"><a class="brand" href="/dashboard">cmdPost<span>·</span></a></header>
<main class="container narrow card">
  <h1>Sign in</h1>
  <p class="error-text">${esc}</p>
  <p><a href="/login">Try again</a></p>
</main></body></html>`;
}
