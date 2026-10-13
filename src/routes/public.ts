import { Hono } from 'hono';
import { layout } from '../views/layout';
import type { Env } from '../env';

/** Public routes: privacy page (and a minimal dashboard placeholder until milestone 2). */
export function publicRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/privacy', (c) =>
    layout(c, {
      title: 'Privacy',
      content: `
<h1>Privacy</h1>
<section class="card">
  <h2>What we store</h2>
  <ul>
    <li><strong>Account</strong> — your email address, display name, and the time you last signed in.</li>
    <li><strong>Sites you add</strong> — the URL, name, and notes you provide, plus your per-site verification token (shown to you once when you add the site).</li>
    <li><strong>Monitoring data</strong> — HTTP status codes, response times, PageSpeed performance scores, SSL certificate expiry, and detected WordPress plugin/theme versions. We store only what your sites expose publicly; we never install anything on them.</li>
    <li><strong>Alerts</strong> — a log of alerts sent to your own email/webhook, and when.</li>
    <li><strong>Sessions &amp; tokens</strong> — only SHA-256 hashes of random sign-in and session tokens, with expiry (15 min / 30 days).</li>
  </ul>
  <h2>What we do NOT do</h2>
  <ul>
    <li>We never send passwords (there are none), log file contents of your site, or write anything to your site. Monitoring is strictly read-only.</li>
    <li>We never share your data with other users of the service. Every dashboard, count, and chart is scoped to your account only.</li>
    <li>Public data from WordPress.org (latest plugin/theme versions) is cached globally to respect their rate limits; it is not tied to your identity.</li>
  </ul>
  <h2>Data retention</h2>
  <ul>
    <li>Raw uptime checks: 30 days, then aggregated into daily stats.</li>
    <li>Daily stats: 1 year.</li>
    <li>Expired sessions and sign-in tokens: deleted automatically.</li>
  </ul>
  <h2>Deleting your data</h2>
  <p>Sign in and go to <strong>Settings → Delete my account and all data</strong>. This removes your account, sites, and every row we store about them — immediately and permanently.</p>
  <h2>Contact</h2>
  <p>Questions or abuse reports: <a href="mailto:abuse@wpmonitor.example">abuse@wpmonitor.example</a>. Domain owners who want their site removed from monitoring can contact us and we will add it to the blocklist.</p>
</section>`,
    }),
  );

  app.get('/', (c) => c.redirect('/dashboard', 302));

  return app;
}
