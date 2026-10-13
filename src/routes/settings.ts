import { Hono } from 'hono';
import { z } from 'zod';
import { makeDb } from '../db/client';
import { findUserById, updateUserSettings, deleteUserCascade } from '../db/repos/users';
import { deleteAllSessionsForUser } from '../db/repos/auth';
import { requireCsrf } from '../middleware/csrf';
import { layout, esc } from '../views/layout';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

const urlSchema = z.string().url().max(2048);
const emailSchema = z.string().trim().toLowerCase().max(254);

function user(c: any): UserRow {
  return c.get('user') as UserRow;
}

export function settingsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/settings', (c) => {
    const u = user(c);
    return layout(c, {
      title: 'Settings',
      user: u,
      active: 'settings',
      content: `
${c.req.query('saved') ? '<div class="flash ok">Settings saved.</div>' : ''}
<h1>Settings</h1>
<section class="card">
  <h2>Profile &amp; alerts</h2>
  <form method="POST" action="/settings" class="stack">
    <label>Name
      <input name="name" value="${esc(u.name)}" maxlength="100">
    </label>
    <label>Alert email <span class="muted">(default: your login email ${esc(u.email)})</span>
      <input type="email" name="alert_email" value="${esc(u.alertEmail ?? u.email)}" maxlength="254">
    </label>
    <label>Alert webhook <span class="muted">(optional — Slack/Discord-compatible JSON POST)</span>
      <input type="url" name="webhook_url" value="${esc(u.webhookUrl ?? '')}" placeholder="https://hooks.slack.com/services/...">
    </label>
    <button class="btn primary" type="submit">Save settings</button>
  </form>
</section>

<section class="card danger-zone">
  <h2>Session &amp; account</h2>
  <p>
    <form method="POST" action="/settings/logout-all" class="inline-form">
      <button class="btn" type="submit">Log out everywhere</button>
    </form>
    <span class="muted">Signs out all browsers/devices (current one too).</span>
  </p>
  <p class="error-text">
    <form method="POST" action="/settings/delete" class="inline-form"
          onsubmit="return confirm('Delete your account, all sites, and all history? This cannot be undone.');">
      <button class="btn danger" type="submit">Delete my account and all data</button>
    </form>
    <span class="muted">Removes your account, sites, checks, and history permanently.</span>
  </p>
</section>`,
    });
  });

  app.post('/settings', requireCsrf(), async (c) => {
    const u = user(c);
    const body = await c.req.parseBody();
    const db = makeDb(c.env);

    const patch: { name?: string; alertEmail?: string; webhookUrl?: string } = {};
    const name = String(body.name ?? '').trim();
    if (name) patch.name = name.slice(0, 100);
    const alertEmailRaw = String(body.alert_email ?? '').trim();
    if (alertEmailRaw) {
      const parsed = emailSchema.safeParse(alertEmailRaw);
      if (parsed.success) patch.alertEmail = parsed.data;
    }
    const webhookRaw = String(body.webhook_url ?? '').trim();
    if (webhookRaw) {
      const parsed = urlSchema.safeParse(webhookRaw);
      if (parsed.success) patch.webhookUrl = parsed.data;
    }

    await updateUserSettings(db, u.id, patch);
    return c.redirect('/settings?saved=1', 302);
  });

  app.post('/settings/logout-all', requireCsrf(), async (c) => {
    const u = user(c);
    await deleteAllSessionsForUser(makeDb(c.env), u.id);
    c.header('Set-Cookie', 'wpmon_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return c.redirect('/login', 302);
  });

  app.post('/settings/delete', requireCsrf(), async (c) => {
    const u = user(c);
    // Cascade: sessions + sites + all child rows (FKs), plus login tokens for the email.
    await deleteUserCascade(makeDb(c.env), u.id);
    c.header('Set-Cookie', 'wpmon_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return c.redirect('/login?deleted=1', 302);
  });

  return app;
}
