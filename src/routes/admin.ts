import { Hono } from 'hono';
import { z } from 'zod';
import { makeDb } from '../db/client';
import {
  listUsersForAdmin,
  setUserStatus,
  countSitesByUserStatus,
  countSitesTotal,
  countUsers,
  deleteUserCascade,
} from '../db/repos/users';
import { requireCsrf } from '../middleware/csrf';
import { layout, esc } from '../views/layout';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

const statusSchema = z.enum(['approved', 'disabled', 'pending']);

function user(c: any): UserRow {
  return c.get('user') as UserRow;
}

/**
 * Admin area. ISOLATION: admins see user identity (email/name — needed to
 * act) and site COUNTS per user, but NEVER other users' site URLs or data.
 */
export function adminRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/admin', (c) => {
    const u = user(c);
    const db = makeDb(c.env);
    // Build HTML from repo data (synchronous rendering of already-fetched rows).
    return (async () => {
      const [usersList, sitesByStatus, totalSites, totalUsers] = await Promise.all([
        listUsersForAdmin(db),
        countSitesByUserStatus(db),
        countSitesTotal(db),
        countUsers(db),
      ]);
      const rows = usersList
        .map(
          (r) => `
<tr>
  <td>${esc(r.email)}<div class="muted small">${esc(r.name)}</div></td>
  <td><span class="badge ${r.status}">${r.status}</span></td>
  <td>${r.siteCount}</td>
  <td class="muted small">${esc(r.createdAt.slice(0, 10))}</td>
  <td class="actions">
    ${r.status !== 'approved' ? `<form method="POST" action="/admin/users/${r.id}/status" class="inline-form"><input type="hidden" name="status" value="approved"><button class="btn small">Approve</button></form>` : ''}
    ${r.status !== 'disabled' ? `<form method="POST" action="/admin/users/${r.id}/status" class="inline-form"><input type="hidden" name="status" value="disabled"><button class="btn small">Disable</button></form>` : ''}
    ${r.status === 'pending' ? `<form method="POST" action="/admin/users/${r.id}/reject" class="inline-form" onsubmit="return confirm('Reject and delete this pending account?');"><button class="btn small danger">Reject</button></form>` : ''}
  </td>
</tr>`
        )
        .join('');
      return layout(c, {
        title: 'Admin',
        user: u,
        active: 'admin',
        content: `
<h1>Admin</h1>
<p class="muted">You see user identities and site <strong>counts only</strong> — never other users' site URLs or data.</p>
<div class="stat-grid">
  <div class="stat"><div class="stat-num">${totalUsers}</div><div class="stat-label">users</div></div>
  <div class="stat"><div class="stat-num">${sitesByStatus.approved}</div><div class="stat-label">sites (approved users)</div></div>
  <div class="stat"><div class="stat-num">${sitesByStatus.pending}</div><div class="stat-label">sites (pending users)</div></div>
  <div class="stat"><div class="stat-num">${totalSites}</div><div class="stat-label">sites total</div></div>
</div>
<section class="card">
  <h2>Users</h2>
  <table class="table">
    <thead><tr><th>User</th><th>Status</th><th>Sites</th><th>Created</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`,
      });
    })();
  });

  app.post('/admin/users/:id/status', requireCsrf(), async (c) => {
    const u = user(c);
    if (!u.isAdmin) return c.notFound();
    const body = await c.req.parseBody();
    const parsed = statusSchema.safeParse(String(body.status ?? ''));
    if (!parsed.success) return c.body('Invalid status', 400);
    const db = makeDb(c.env);
    await setUserStatus(db, Number(c.req.param('id')), parsed.data);
    return c.redirect('/admin', 302);
  });

  app.post('/admin/users/:id/reject', requireCsrf(), async (c) => {
    const u = user(c);
    if (!u.isAdmin) return c.notFound();
    const id = Number(c.req.param('id'));
    const db = makeDb(c.env);
    // Rejecting a pending account = delete it (they never had live monitoring).
    await deleteUserCascade(db, id);
    return c.redirect('/admin', 302);
  });

  return app;
}
