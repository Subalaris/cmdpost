import { Hono } from 'hono';
import { makeDb } from '../db/client';
import { countSitesForUser, listSitesForUser } from '../db/repos/sites';
import { layout, esc } from '../views/layout';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

function user(c: any): UserRow {
  return c.get('user') as UserRow;
}

/**
 * Dashboard (Milestone 1 = minimal; Milestone 2-3 add the full table,
 * sorting, filtering, pagination, and htmx auto-refresh).
 */
export function dashboardRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/dashboard', async (c) => {
    const u = user(c);
    const db = makeDb(c.env);
    const sites = await listSitesForUser(db, u.id);
    const n = sites.length;

    const rows = sites
      .map((s) => {
        const domain = (() => {
          try {
            return new URL(s.url).hostname;
          } catch {
            return s.url;
          }
        })();
        return `<tr>
  <td><a href="/sites/${s.id}">${esc(s.name)}</a><div class="muted small">${esc(domain)}</div></td>
  <td>${s.verifiedAt ? `<span class="badge ${s.currentStatus}">${s.currentStatus}</span>` : '<span class="badge unknown">unverified</span>'}</td>
  <td class="muted">—</td>
  <td class="muted">—</td>
  <td class="muted">—</td>
</tr>`;
      })
      .join('');

    return layout(c, {
      title: 'Dashboard',
      user: u,
      active: 'dashboard',
      content: `
<h1>You are currently monitoring ${n} website${n === 1 ? '' : 's'}</h1>
<p class="muted">Milestone 1 preview — full status, PageSpeed, security, and WordPress-update columns arrive in milestones 2–3.</p>
<div class="toolbar">
  <a class="btn primary" href="/sites">Manage sites</a>
  ${n === 0 ? '<span class="muted">Add your first site to start monitoring.</span>' : ''}
</div>
<section class="card">
  <table class="table" id="site-table">
    <thead><tr><th>Site</th><th>Status</th><th>PageSpeed</th><th>Load</th><th>Security</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">No sites yet.</td></tr>'}</tbody>
  </table>
</section>`,
    });
  });

  return app;
}
