import { Hono } from 'hono';
import { z } from 'zod';
import { makeDb } from '../db/client';
import { randomToken } from '../lib/tokens';
import { requireCsrf } from '../middleware/csrf';
import { clientIp, rateLimit } from '../middleware/rateLimit';
import { rateLimitCheck } from '../db/repos/rateLimits';
import { layout, esc } from '../views/layout';
import { verifySite } from '../lib/verify-site';
import { validatePublicUrl, fetchPublic } from '../lib/ssrf';
import { sites } from '../db/schema';
import { eq } from 'drizzle-orm';
import { nowIso } from '../db/client';
import { scanSite, writeScan } from '../jobs/fingerprint';
import { makeBudget } from '../jobs/uptime';
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
  listRecentChecks, uptimePct, listPageSpeedHistory, latestSsl, latestFingerprint, listComponents,
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
<section class="card" id="add-site">
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
  app.get('/sites/:id', async (c) => {
    const u = user(c);
    const id = parseSiteId(c.req.param('id'));
    if (!id) return c.notFound();
    const db = makeDb(c.env);
    const s = await findSiteForUser(db, u.id, id);
    if (!s) return c.notFound(); // foreign site -> 404 (no probing)

    const flash = c.req.query('verified') ? '<div class="flash ok">Ownership verified — monitoring will begin on the next job run.</div>'
      : c.req.query('scanned') ? '<div class="flash ok">Scan complete.</div>' : '';
    const err = c.req.query('err') ? `<div class="flash err">${esc(decodeURIComponent(c.req.query('err')!))}</div>` : '';

    // ---------- unverified: verification instructions only ----------
    if (!s.verifiedAt) {
      return layout(c, {
        title: s.name,
        user: u,
        active: 'sites',
        content: `
${flash}${err}
<h1>${esc(s.name)} <span class="badge unknown">unverified</span></h1>
<p class="muted">${esc(s.url)} · added ${esc(s.createdAt.slice(0, 10))}</p>
<section class="card">
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
</section>
<section class="card">
  <h2>Settings</h2>
  <form method="POST" action="/sites/${s.id}/edit" class="stack">
    <label>Name <input name="name" value="${esc(s.name)}" maxlength="100"></label>
    <label>Notes <textarea name="notes" rows="2" maxlength="2000">${esc(s.notes ?? '')}</textarea></label>
    <div><button class="btn primary" type="submit">Save</button> <a class="btn" href="/sites">Back to list</a></div>
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
    }

    // ---------- verified: full detail ----------
    const day24 = new Date(Date.now() - 24 * 3600_000).toISOString();
    const day7 = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const [checks24, checks7, uptime24, uptime7, psHistory, ssl, fp, comps] = await Promise.all([
      listRecentChecks(db, s.id, 200, day24),
      listRecentChecks(db, s.id, 2000, day7),
      uptimePct(db, s.id, day24),
      uptimePct(db, s.id, day7),
      listPageSpeedHistory(db, s.id, 30),
      latestSsl(db, s.id),
      latestFingerprint(db, s.id),
      listComponents(db, s.id),
    ]);

    const chartData24 = JSON.stringify(checks24.slice().reverse().map((r) => [Date.parse(r.checkedAt), r.responseMs ?? 0]));
    const chartData7 = JSON.stringify(checks7.slice().reverse().map((r) => [Date.parse(r.checkedAt), r.responseMs ?? 0]));
    const psData = JSON.stringify(psHistory.slice().reverse().map((r) => [Date.parse(r.checkedAt), r.score]));

    const last20 = checks24.slice(0, 20)
      .map((r) => `<tr>
  <td class="muted small">${esc(r.checkedAt.slice(0, 19).replace('T', ' '))}</td>
  <td>${r.ok ? '<span class="badge up">ok</span>' : '<span class="badge down">fail</span>'}</td>
  <td>${r.statusCode ?? '—'}</td>
  <td>${r.responseMs !== null ? (r.responseMs / 1000).toFixed(2) + ' s' : '—'}</td>
  <td class="muted small">${esc(r.error ?? '')}</td>
</tr>`)
      .join('');

    const sslCard = ssl
      ? `<p>State: <span class="badge ${ssl.state === 'ok' ? 'up' : 'down'}">${esc(ssl.state)}</span>
   · expires ${esc((ssl.validTo ?? '?').slice(0, 10))}
   · <strong>${ssl.daysLeft ?? '?'} days left</strong>
   ${ssl.issuer ? `· issuer ${esc(ssl.issuer)}` : ''}</p>
<p class="muted small">Checked ${esc(ssl.checkedAt.slice(0, 16).replace('T', ' '))} UTC by the daily SSL checker.</p>`
      : '<p class="muted">No SSL data yet — the daily certificate checker fills this in (milestone 7).</p>';

    const fpCard = fp
      ? `<p>Core: <strong>${esc(fp.wpVersion ?? '?')}</strong>
   ${fp.wpLatest ? `· latest <strong>${esc(fp.wpLatest)}</strong>` : ''}
   ${fp.coreOutdated ? '<span class="warn">outdated</span>' : fp.wpVersion ? '<span class="muted">up to date</span>' : ''}
   · source: ${esc(fp.wpVersionSource ?? 'hidden')}</p>
<p class="muted small">Scanned ${esc(fp.scannedAt.slice(0, 16).replace('T', ' '))} UTC. Versions are <em>detected</em> from public pages and are approximate.</p>`
      : '<p class="muted">Not scanned yet — the hourly fingerprint job or "Scan now" fills this in.</p>';

    const compRows = comps
      .map((comp) => {
        const cls = comp.outdated ? 'class="row-outdated"' : '';
        const statusLabel =
          comp.status === 'premium_unknown' ? '<span class="muted">not on wp.org (premium/unknown)</span>'
          : comp.status === 'version_hidden' ? '<span class="muted">version hidden</span>'
          : comp.outdated ? '<span class="warn">outdated</span>'
          : '<span class="muted">up to date</span>';
        return `<tr ${cls}>
  <td>${comp.type === 'plugin' ? 'plugin' : 'theme'}</td>
  <td><code>${esc(comp.slug)}</code></td>
  <td>${esc(comp.detectedVersion ?? '?')}${comp.versionSource === 'asset_ver' ? ' <span class="muted small" title="From asset ?ver= — may differ from the real version">(asset)</span>' : ''}</td>
  <td>${esc(comp.latestVersion ?? '—')}</td>
  <td>${statusLabel}</td>
</tr>`;
      })
      .join('');

    return layout(c, {
      title: s.name,
      user: u,
      active: 'sites',
      charts: true,
      content: `
${flash}${err}
<h1>${esc(s.name)} <span class="badge ${s.currentStatus}">${s.currentStatus}</span></h1>
<p class="muted"><a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(s.url)}</a> · added ${esc(s.createdAt.slice(0, 10))}
 · verified via ${esc(s.verificationMethod ?? '?')} ${esc((s.verifiedAt ?? '').slice(0, 10))}</p>

<div class="grid2">
  <section class="card">
    <h2>Response time — last 24 h</h2>
    <div id="chart24" class="chart"></div>
    <p class="muted small">Uptime 24 h: <strong>${uptime24 === null ? '—' : uptime24 + '%'}</strong></p>
  </section>
  <section class="card">
    <h2>Response time — last 7 d</h2>
    <div id="chart7" class="chart"></div>
    <p class="muted small">Uptime 7 d: <strong>${uptime7 === null ? '—' : uptime7 + '%'}</strong></p>
  </section>
</div>

<section class="card">
  <h2>PageSpeed history</h2>
  ${psHistory.length ? '<div id="chartps" class="chart"></div>' : '<p class="muted">No PageSpeed results yet.</p>'}
</section>

<div class="grid2">
  <section class="card">
    <h2>Security (SSL)</h2>
    ${sslCard}
  </section>
  <section class="card">
    <h2>WordPress (detected)</h2>
    ${fpCard}
    <form method="POST" action="/sites/${s.id}/scan" class="inline-form">
      <button class="btn" type="submit">Scan now</button>
      <span class="muted small">rate-limited: 1 scan / 5 min</span>
    </form>
  </section>
</div>

<section class="card">
  <h2>Detected plugins &amp; themes</h2>
  <p class="muted small">Detected from public pages — approximate. "not on wp.org" means we cannot check its latest version (premium or custom).</p>
  <table class="table">
    <thead><tr><th>Type</th><th>Slug</th><th>Detected</th><th>Latest</th><th>Status</th></tr></thead>
    <tbody>${compRows || '<tr><td colspan="5" class="muted">Nothing detected yet.</td></tr>'}</tbody>
  </table>
</section>

<section class="card">
  <h2>Last checks</h2>
  <table class="table">
    <thead><tr><th>When (UTC)</th><th>Result</th><th>HTTP</th><th>Time</th><th>Error</th></tr></thead>
    <tbody>${last20 || '<tr><td colspan="5" class="muted">No checks in the last 24 h.</td></tr>'}</tbody>
  </table>
</section>

<section class="card">
  <h2>Settings</h2>
  <form method="POST" action="/sites/${s.id}/edit" class="stack">
    <label>Name <input name="name" value="${esc(s.name)}" maxlength="100"></label>
    <label>Notes <textarea name="notes" rows="2" maxlength="2000">${esc(s.notes ?? '')}</textarea></label>
    <div><button class="btn primary" type="submit">Save</button> <a class="btn" href="/sites">Back to list</a></div>
  </form>
</section>

<section class="card danger-zone">
  <h2>Danger zone</h2>
  <form method="POST" action="/sites/${s.id}/delete" class="inline-form"
        onsubmit="return confirm('Delete ${esc(s.name)} and all its history?');">
    <button class="btn danger" type="submit">Delete site</button>
  </form>
</section>

<script>
function lineChart(el, data, color, unit) {
  if (!window.uPlot || !data.length) return;
  const xs = data.map((d) => d[0]);
  const ys = data.map((d) => d[1]);
  new uPlot({
    width: el.clientWidth || 600, height: 180,
    scales: { x: { time: true } },
    series: [{ label: 'time' }, { label: unit, stroke: color, width: 1.5, points: { show: false } }],
    axes: [{}, {}],
    cursor: { drag: { x: true } },
  }, [xs, ys], el);
}
lineChart(document.getElementById('chart24'), ${chartData24}, '#4da3ff', 'ms');
lineChart(document.getElementById('chart7'), ${chartData7}, '#4da3ff', 'ms');
const psEl = document.getElementById('chartps');
if (psEl) lineChart(psEl, ${psData}, '#7ee787', 'score');
</script>`,
    });
  });

  // ------------------------------------------------------------- scan now
  app.post(
    '/sites/:id/scan',
    requireCsrf(),
    rateLimit({ prefix: 'scan:min', limit: 1, windowMs: 5 * 60 * 1000 }, (c) => c.req.param('id')),
    async (c) => {
      const u = user(c);
      const id = parseSiteId(c.req.param('id'));
      if (!id) return c.notFound();
      const db = makeDb(c.env);
      const s = await findSiteForUser(db, u.id, id);
      if (!s) return c.notFound();
      if (!s.verifiedAt) return c.redirect(`/sites/${id}?err=` + encodeURIComponent('Verify ownership before scanning.'), 302);

      const budget = makeBudget(45);
      const home = await fetchPublic(s.url, { method: 'GET', maxBytes: 1_500_000, timeoutMs: 10_000 });
      if (!home.ok || !home.body) {
        return c.redirect(`/sites/${id}?err=` + encodeURIComponent('Could not fetch the homepage (' + (home.error ?? 'error') + ').'), 302);
      }
      const scan = await scanSite(db, { id: s.id, url: s.url }, budget, home.body);
      if (!scan) return c.redirect(`/sites/${id}?err=` + encodeURIComponent('Scan failed.'), 302);
      await writeScan(db, s.id, scan, nowIso());
      await db.update(sites).set({ lastScannedAt: nowIso() }).where(eq(sites.id, s.id)).run();
      return c.redirect(`/sites/${id}?scanned=1`, 302);
    },
  );

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
