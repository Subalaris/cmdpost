import { Hono } from 'hono';
import { makeDb } from '../db/client';
import { dashboardSummaryForUser, querySitesForUser, type SiteFilter, type SiteSort, type DashboardRow } from '../db/repos/sites';
import { layout, esc } from '../views/layout';
import { icon } from '../views/icons';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

const PER_PAGE = 9;
const SORTS: Array<[SiteSort, string]> = [
  ['name', 'Name: A–Z'], ['status', 'Status'], ['pagespeed', 'Performance: low first'],
  ['load', 'Load time'], ['updates', 'Most updates'],
];
const FILTERS: Array<[SiteFilter, string]> = [
  ['all', 'All websites'], ['up', 'Online'], ['down', 'Needs attention'], ['updates', 'Has updates'], ['ssl', 'SSL issues'],
];

function statusBadge(r: DashboardRow): string {
  if (!r.verifiedAt) return `<a class="status" href="/sites/${r.id}" title="Verify ownership to start monitoring"><span class="dot pending"></span>Unverified</a>`;
  const label = r.currentStatus === 'up' ? 'Up' : r.currentStatus === 'down' ? 'Down' : 'Pending';
  return `<span class="status" title="${r.currentStatus === 'down' ? 'Down after 2 consecutive failures' : label}"><span class="dot ${r.currentStatus}"></span>${label}</span>`;
}

function scoreCell(v: number | null): string {
  if (v == null) return '<span class="muted" title="No PageSpeed result yet">—</span>';
  return `${icon('gauge')}<span class="score ${v < 50 ? 'bad' : v < 90 ? 'warn' : ''}">${v}</span><small>/100</small>`;
}

/** Normal links remain usable when JavaScript or the htmx CDN is unavailable. */
function panelLink(label: string, url: string, attrs = ''): string {
  return `<a href="${esc(url)}" hx-get="${esc(url)}&partial=1" hx-target="#site-panel" hx-swap="outerHTML" hx-push-url="${esc(url)}" ${attrs}>${label}</a>`;
}

export function dashboardRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/dashboard', async (c) => {
    const u = c.get('user' as never) as UserRow;
    const db = makeDb(c.env);
    const sort = SORTS.find(([key]) => key === c.req.query('sort'))?.[0] ?? 'name';
    const filter = FILTERS.find(([key]) => key === c.req.query('filter'))?.[0] ?? 'all';
    const search = (c.req.query('q') ?? '').trim().slice(0, 200);
    const requestedPage = Number(c.req.query('page') ?? '1');
    let page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const summary = await dashboardSummaryForUser(db, u.id);
    let result = await querySitesForUser(db, u.id, { sort, filter, search, page, perPage: PER_PAGE });
    const { total } = result;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (page > pages) {
      page = pages;
      result = await querySitesForUser(db, u.id, { sort, filter, search, page, perPage: PER_PAGE });
    }
    const qs = (over: Record<string, string> = {}) => {
      const p = new URLSearchParams({ sort, filter, q: search, page: String(page), ...over });
      return `/dashboard?${p.toString()}`;
    };
    const optionList = (options: Array<[string, string]>, value: string) => options.map(([key, label]) =>
      `<option value="${key}"${key === value ? ' selected' : ''}>${label}</option>`).join('');
    const tab = (key: SiteFilter, label: string, count: number) => panelLink(
      `${label}<span>${count}</span>`, qs({ filter: key, page: '1' }),
      `class="tab ${filter === key ? 'active' : ''}"${filter === key ? ' aria-current="page"' : ''}`,
    );
    const pagerButton = (label: string, symbol: string, target: number, disabled: boolean, reverse = false) => {
      const contents = `<span${reverse ? ' class="reverse"' : ''}>${icon(symbol)}</span>`;
      return disabled ? `<button disabled aria-label="${label}">${contents}</button>`
        : panelLink(contents, qs({ page: String(target) }), `aria-label="${label}"`);
    };
    const rows = result.rows.map((r) => `<tr>
<td><div class="website-cell"><span class="favicon color-${r.id % 6}">${esc(r.name.slice(0, 1).toUpperCase())}</span><div><a class="site-name" href="/sites/${r.id}">${esc(r.name)}</a><span class="client-name">${esc(new URL(r.url).hostname)}</span></div></div></td>
<td>${statusBadge(r)}</td>
<td><span class="metric">${scoreCell(r.pagespeedScore)}</span></td>
<td><span class="metric">${icon('clock')}${r.lastResponseMs == null ? '<span class="muted">—</span>' : `${(r.lastResponseMs / 1000).toFixed(1)}<small>s</small>`}</span></td>
<td><span class="metric ${r.sslProblems ? 'bad' : ''}" title="${r.sslProblems == null ? 'Not scanned yet' : r.sslProblems ? 'SSL problem' : 'No SSL problems'}">${icon('lock')}${r.sslProblems ?? '—'}</span></td>
<td><span class="metric" title="${r.updatesCount == null ? 'Not scanned yet' : 'Outdated components detected (approximate)'}"><span class="wp">W</span><span class="updates">${r.updatesCount ?? '—'}</span></span></td>
<td><a class="open-site" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer nofollow" aria-label="Open ${esc(r.name)} in a new tab">${icon('external')}</a></td>
</tr>`).join('');
    // Controls and results swap together so polling and navigation retain current filters.
    const panel = `<section id="site-panel" hx-get="${esc(qs({ partial: '1' }))}" hx-trigger="every 30s [!document.querySelector('#website-filters:focus-within')]" hx-swap="outerHTML">
<div class="overview" aria-label="Workspace overview">
  <div class="stat"><div class="stat-top">${icon('globe')}Total websites</div><div class="stat-line"><strong>${summary.total}</strong><small>in your workspace</small></div></div>
  <div class="stat"><div class="stat-top">${icon('pulse')}Online now</div><div class="stat-line"><strong class="good">${summary.online}</strong><small>running smoothly</small></div></div>
  <div class="stat"><div class="stat-top">${icon('shield')}Needs attention</div><div class="stat-line"><strong class="bad">${String(summary.down).padStart(2, '0')}</strong><small>currently offline</small></div></div>
  <div class="stat"><div class="stat-top">${icon('gauge')}Avg. performance</div><div class="stat-line"><strong>${summary.averageScore == null ? '—' : Math.round(summary.averageScore)}<span class="score-unit">/100</span></strong></div></div>
</div>
<form id="website-filters" action="/dashboard" method="GET" hx-get="/dashboard" hx-target="#site-panel" hx-swap="outerHTML" hx-push-url="true" hx-trigger="submit, input changed delay:400ms from:#q, change from:select" hx-sync="this:replace">
  <div class="tabbar"><nav class="tabs" aria-label="Website status">${tab('all', 'All websites', summary.total)}${tab('up', 'Online', summary.online)}${tab('down', 'Needs attention', summary.down)}</nav>
  <div class="search">${icon('search')}<input type="search" id="q" name="q" aria-label="Search websites" placeholder="Search websites…" value="${esc(search)}" maxlength="200"></div></div>
  <div class="toolbar"><div class="selects"><div class="select-wrap">${icon('sort')}<select name="sort" aria-label="Sort websites">${optionList(SORTS, sort)}</select></div><div class="select-wrap">${icon('filter')}<select name="filter" aria-label="Filter websites">${optionList(FILTERS, filter)}</select></div><button class="btn small apply-filters" type="submit">Apply</button></div><span class="results" role="status">${total} website${total === 1 ? '' : 's'} ${search || filter !== 'all' ? 'found' : 'in total'}</span></div>
</form>
<div class="table-scroll"><table class="table website-table" id="site-table"><thead><tr><th scope="col">Website</th><th scope="col">Status</th><th scope="col">Performance</th><th scope="col">Load time</th><th scope="col">Security</th><th scope="col">Updates</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>
${rows ? '' : `<div class="empty"><span class="empty-icon">${icon('globe')}</span><strong>${summary.total === 0 ? 'A home for all your websites.' : 'No websites found'}</strong><p>${summary.total === 0 ? 'Add your first website to start keeping an eye on its health.' : 'Try another search or change your filters.'}</p>${summary.total === 0 ? '<a class="btn primary" href="/sites#add-site">Add a website</a>' : panelLink('Clear filters', '/dashboard?filter=all', 'class="btn"')}</div>`}
<div class="pagination"><span>${total ? `Showing ${(page - 1) * PER_PAGE + 1}–${Math.min(page * PER_PAGE, total)} of ${total} websites` : 'Showing 0 websites'}</span><nav class="pages" aria-label="Website pages">${pagerButton('First page', 'double', 1, page === 1, true)}${pagerButton('Previous page', 'chevron', page - 1, page === 1, true)}<span class="page-label"><b>${page}</b> of ${pages}</span>${pagerButton('Next page', 'chevron', page + 1, page === pages)}${pagerButton('Last page', 'double', pages, page === pages)}</nav></div>
<p class="refresh-note">${icon('clock')}Status checks every 5 minutes · Dashboard refreshes every 30 seconds</p>
</section>`;
    if (c.req.query('partial') === '1' || c.req.header('HX-Request') === 'true') {
      // Keep partial=1 out of browser history so refresh always renders the full app.
      c.header('HX-Push-Url', qs());
      return c.html(panel);
    }
    return layout(c, {
      title: 'Websites', user: u, active: 'dashboard', htmx: true,
      content: `<div class="intro"><div><h1>Websites</h1><p class="subtitle">Your websites, in good hands.<br><strong>${summary.total} website${summary.total === 1 ? '' : 's'}</strong>. One calm place to keep everything in view.</p></div><a class="btn primary" href="/sites#add-site">${icon('plus')}Add a website</a></div>${panel}`,
    });
  });
  return app;
}
