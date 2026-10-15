import { Hono } from 'hono';
import { z } from 'zod';
import { makeDb } from '../db/client';
import { randomToken } from '../lib/tokens';
import { requireCsrf } from '../middleware/csrf';
import { clientIp, rateLimit } from '../middleware/rateLimit';
import { rateLimitCheck } from '../db/repos/rateLimits';
import { layout, esc } from '../views/layout';
import { verifySite } from '../lib/verify-site';
import { validatePublicUrl } from '../lib/ssrf';
import {
  addSite,
  findSiteForUser,
  listSitesForUser,
  updateSiteForUser,
  deleteSiteForUser,
  checkAddSiteCaps,
  markVerified,
  resetVerificationToken,
  normalizeUrl,
  domainOf,
} from '../db/repos/sites';
import { loadConfig } from '../env';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

function user(c: { get(k: string): unknown }): UserRow {
  return c.get('user') as UserRow;
}

const urlField = z.string().trim().min(3).max(2048);

function parseSiteId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Shared add-site logic for single + bulk forms. */
async function tryAddSite(env: Env, userId: number, rawUrl: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = makeDb(env);
  const cfg = loadConfig(env);

  const norm = normalizeUrl(rawUrl);
  const v = validatePublicUrl(norm);
  if (!v.ok) return { ok: false, error: `"${rawUrl}" is not a valid public URL (${v.reason}).` };

  const cap = await checkAddSiteCaps(db, userId, v.url.toString(), cfg.maxSitesPerUser, cfg.maxSitesTotal);
  if (!cap.ok) return { ok: false, error: cap.detail ?? 'Site limit reached.' };

  const site = await addSite(db, { userId, url: v.url.toString(), name }, randomToken(32));
  if (!site) return { ok: false, error: 'You are already monitoring this URL.' };
  return { ok: true };
}

export function sitesRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // ------------------------------------------------------------- list page
  app.get('/sites', (c) => {
    const u = user(c);
    const db = makeDb(c.env);
    return (async () => {
      const sites = await listSitesForUser(db, u.id);
      const cfg = loadConfig(c.env);
      const rows = sites
        .map((s) => {
          const statusBadge = s.verifiedAt
            ? `<span class="badge ${s.currentStatus}">${s.currentStatus}</span>`
            : '<span class="badge unknown">unverified</span>';
          const paused = !s.active ? '<span class="badge pending">paused</span>' : '';
          return `<tr>
  <td><a href="/sites/${s.id}">${esc(s.name)}</a><div class="muted small">${esc(s.url)}</div></td>
  <td>${statusBadge} ${paused}</td>
  <td class="actions">
    <a class="btn small" href="/sites/${s.id}">Manage</a>
    <form method="POST" action="/sites/${s.id}/toggle" class="inline-form">
      <button class="btn small" type="submit">${s.active ? 'Pause' : 'Resume'}</button>
    </form>
    <form method="POST" action="/sites/${s.id}/delete" class="inline-form"
          onsubmit="return confirm('Delete ${esc(s.name)} and all its history?');">
      <button class="btn small danger" type="submit">Delete</button>
    </form>
  </td>
</tr>`;
        })
        .join('');

      const flash = c.req.query('added') ? '<div class="flash ok">Site added. Next: verify you own it.</div>' : '';
      const err = c.req.query('err') ? `<div class="flash err">${esc(decodeURIComponent(c.req.query('err')!))}</div>` : '';

      return layout(c, {
        title: 'My sites',
        user: u,
        active: 'sites',
        content: `
${flash}${err}
<h1>My sites <span class="muted" style="font-weight:400">(${sites.length}/${cfg.maxSitesPerUser})</span></h1>
<section class="card">
  <h2>Add a site</h2>
  <p class="muted small">Paste one URL per line to add several at once. Nothing is checked until you verify ownership.</p>
  <form method="POST" action="/sites/add" class="stack">
    <label>URLs
      <textarea name="urls" rows="3" required placeholder="https://example.com&#10;https://blog.example.org"></textarea>
    </label>
    <label>Name <span class="muted">(optional — first site only)</span>
      <input name="name" maxlength="100" placeholder="defaults to the domain">
    </label>
    <button class="btn primary" type="submit">Add site(s)</button>
  </form>
</section>
<section class="card">
  <table class="table">
    <thead><tr><th>Site</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="muted">No sites yet — add one above.</td></tr>'}</tbody>
  </table>
</section>`,
      });
    })();
  });

  // ------------------------------------------------------------- add (bulk)
  app.post(
    '/sites/add',
    requireCsrf(),
    rateLimit({ prefix: 'addsite:user', limit: 20, windowMs: 60 * 60 * 1000 }, (c) => `u${(c.get('user') as UserRow | undefined)?.id ?? 'anon'}`),
    rateLimit({ prefix: 'addsite:ip', limit: 40, windowMs: 60 * 60 * 1000 }, (c) => clientIp(c)),
    async (c) => {
      const u = user(c);
      const body = await c.req.parseBody();
      const rawList = String(body.urls ?? '');
      const name = String(body.name ?? '').slice(0, 100);
      const lines = rawList.split(/\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 25);
      if (lines.length === 0) return c.redirect('/sites?err=' + encodeURIComponent('No URLs provided.'), 302);

      let added = 0;
      const errors: string[] = [];
      for (const line of lines) {
        const r = await tryAddSite(c.env, u.id, line, added === 0 ? name : '');
        if (r.ok) added++;
        else errors.push(r.error);
      }
      if (added === 0) {
        return c.redirect('/sites?err=' + encodeURIComponent(errors[0] ?? 'Could not add site.'), 302);
      }
      const msg = errors.length ? `added ${added}, skipped ${errors.length} (${errors[0]})` : 'added';
      return c.redirect('/sites?added=' + encodeURIComponent(msg), 302);
    },
  );

  // ---------------------------------------------------------- detail page
  app.get('/sites/:id', (c) => {
    const u = user(c);
    const id = parseSiteId(c.req.param('id'));
    if (!id) return c.notFound();
    const db = makeDb(c.env);
    return (async () => {
      const s = await findSiteForUser(db, u.id, id);
      if (!s) return c.notFound(); // foreign site -> 404 (no probing)

      const flash = c.req.query('verified') ? '<div class="flash ok">Ownership verified — monitoring will begin on the next job run.</div>' : '';
      const err = c.req.query('err') ? `<div class="flash err">${esc(decodeURIComponent(c.req.query('err')!))}</div>` : '';

      const verifySection = s.verifiedAt
        ? `<section class="card">
  <h2>Ownership verified</h2>
  <p>Verified via <strong>${esc(s.verificationMethod ?? '?')}</strong> on ${esc((s.verifiedAt ?? '').slice(0, 16).replace('T', ' '))} UTC.</p>
  <form method="POST" action="/sites/${s.id}/verify/reset" class="inline-form"
        onsubmit="return confirm('Reset verification? The site becomes unmonitored until re-verified.');">
    <button class="btn danger" type="submit">Reset verification</button>
  </form>
</section>`
        : `<section class="card">
  <h2>Verify you own this site</h2>
  <p class="muted">We will not send any requests to this site until you prove ownership. Use <strong>any one</strong> of these three methods, then click "Check now".</p>
  <p>Your token: <code>${esc(s.verificationToken ?? '')}</code></p>
  <ol>
    <li><strong>DNS</strong> — add a TXT record at <code>_wpmonitor.${esc(domainOf(s.url))}</code> with value <code>${esc(s.verificationToken ?? '')}</code></li>
    <li><strong>Meta tag</strong> — add <code>&lt;meta name="wpmonitor-verification" content="${esc(s.verificationToken ?? '')}"&gt;</code> to your homepage <code>&lt;head&gt;</code></li>
    <li><strong>File</strong> — serve a file at <code>/wpmonitor-${esc(s.verificationToken ?? '')}.txt</code> containing exactly the token — <a href="/sites/${s.id}/verification.txt">download the file</a></li>
  </ol>
  <form method="POST" action="/sites/${s.id}/verify" class="inline-form">
    <button class="btn primary" type="submit">Check now</button>
  </form>
</section>`;

      return layout(c, {
        title: s.name,
        user: u,
        active: 'sites',
        content: `
${flash}${err}
<h1>${esc(s.name)} ${s.verifiedAt ? `<span class="badge ${s.currentStatus}">${s.currentStatus}</span>` : '<span class="badge unknown">unverified</span>'}</h1>
<p class="muted">${esc(s.url)} · added ${esc(s.createdAt.slice(0, 10))}</p>

${verifySection}

<section class="card">
  <h2>Settings</h2>
  <form method="POST" action="/sites/${s.id}/edit" class="stack">
    <label>Name <input name="name" value="${esc(s.name)}" maxlength="100"></label>
    <label>Notes <textarea name="notes" rows="2" maxlength="2000">${esc(s.notes ?? '')}</textarea></label>
    <div>
      <button class="btn primary" type="submit">Save</button>
      <a class="btn" href="/sites">Back to list</a>
    </div>
  </form>
</section>

<section class="card danger-zone">
  <h2>Danger zone</h2>
  <form method="POST" action="/sites/${s.id}/delete" class="inline-form"
        onsubmit="return confirm('Delete ${esc(s.name)} and all its history?');">
    <button class="btn danger" type="submit">Delete site</button>
  </form>
</section>`,
      });
    })();
  });

  // ------------------------------------------------------------- edit
  app.post('/sites/:id/edit', requireCsrf(), async (c) => {
    const u = user(c);
    const id = parseSiteId(c.req.param('id'));
    if (!id) return c.notFound();
    const body = await c.req.parseBody();
    const db = makeDb(c.env);
    const patch: { name?: string; notes?: string } = {};
    const name = String(body.name ?? '').trim();
    if (name) patch.name = name.slice(0, 100);
    patch.notes = String(body.notes ?? '').slice(0, 2000);
    const updated = await updateSiteForUser(db, u.id, id, patch);
    if (!updated) return c.notFound();
    return c.redirect(`/sites/${id}?saved=1`, 302);
  });

  // ------------------------------------------------------------- pause/resume
  app.post('/sites/:id/toggle', requireCsrf(), async (c) => {
    const u = user(c);
    const id = parseSiteId(c.req.param('id'));
    if (!id) return c.notFound();
    const db = makeDb(c.env);
    const s = await findSiteForUser(db, u.id, id);
    if (!s) return c.notFound();
    await updateSiteForUser(db, u.id, id, { active: !s.active });
    return c.redirect('/sites', 302);
  });

  // ------------------------------------------------------------- delete
  app.post('/sites/:id/delete', requireCsrf(), async (c) => {
    const u = user(c);
    const id = parseSiteId(c.req.param('id'));
    if (!id) return c.notFound();
    const deleted = await deleteSiteForUser(makeDb(c.env), u.id, id);
    if (!deleted) return c.notFound();
    return c.redirect('/sites', 302);
  });

  // ------------------------------------------------- verification file download
  app.get('/sites/:id/verification.txt', async (c) => {
    const u = user(c);
    const id = parseSiteId(c.req.param('id'));
    if (!id) return c.notFound();
    const db = makeDb(c.env);
    const s = await findSiteForUser(db, u.id, id);
    if (!s?.verificationToken) return c.notFound();
    return new Response(s.verificationToken + '\n', {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="wpmonitor-${s.verificationToken}.txt"`,
        'cache-control': 'no-store',
      },
    });
  });

  // ------------------------------------------------------------- verify
  app.post(
    '/sites/:id/verify',
    requireCsrf(),
    // 1 attempt/min and 10/day per site (spec)
    rateLimit({ prefix: 'verify:min', limit: 1, windowMs: 60 * 1000 }, (c) => c.req.param('id')),
    rateLimit({ prefix: 'verify:day', limit: 10, windowMs: 24 * 60 * 60 * 1000 }, (c) => c.req.param('id')),
    async (c) => {
      const u = user(c);
      const id = parseSiteId(c.req.param('id'));
      if (!id) return c.notFound();
      const db = makeDb(c.env);
      const s = await findSiteForUser(db, u.id, id);
      if (!s) return c.notFound();
      if (!s.verificationToken) return c.redirect(`/sites/${id}?err=` + encodeURIComponent('No verification token.'), 302);

      const method = await verifySite(s.url, s.verificationToken);
      if (!method) {
        return c.redirect(
          `/sites/${id}?err=` + encodeURIComponent('Could not find the token via DNS, meta tag, or file. Wait a minute for DNS to propagate and try again.'),
          302,
        );
      }
      await markVerified(db, u.id, id, method);
      return c.redirect(`/sites/${id}?verified=1`, 302);
    },
  );

  // ------------------------------------------------- reset verification
  app.post('/sites/:id/verify/reset', requireCsrf(), async (c) => {
    const u = user(c);
    const id = parseSiteId(c.req.param('id'));
    if (!id) return c.notFound();
    const db = makeDb(c.env);
    const s = await findSiteForUser(db, u.id, id);
    if (!s) return c.notFound();
    await resetVerificationToken(db, u.id, id, randomToken(32));
    return c.redirect(`/sites/${id}`, 302);
  });

  return app;
}
