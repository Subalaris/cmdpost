import { Hono } from 'hono';
import { makeDb } from '../db/client';
import { listSitesForUser } from '../db/repos/sites';
import { layout, esc } from '../views/layout';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

function user(c: { get(k: string): unknown }): UserRow {
  return c.get('user') as UserRow;
}

/**
 * Dashboard. Milestone 3 adds server-side sorting/filtering/pagination and
 * the htmx 30s auto-refresh; PageSpeed/Load/Security columns fill in with
 * milestones 3–7.
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
  <td>${s.verifiedAt ? `<span class="badge ${s.currentStatus}">${s.currentStatus}</span>` : '<a class="badge unknown" href="/sites/' + s.id + '">unverified</a>'}</td>
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
<div class="toolbar">
  <a class="btn primary" href="/sites">Manage sites</a>
  ${n === 0 ? '<span class="muted">Add your first site to start monitoring.</span>' : '<span class="muted">Unverified sites are not monitored until you prove ownership.</span>'}
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
