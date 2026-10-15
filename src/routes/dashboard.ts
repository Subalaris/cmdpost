import { Hono } from 'hono';
import { makeDb } from '../db/client';
import { querySitesForUser, type SiteFilter, type SiteSort } from '../db/repos/sites';
import { layout, esc } from '../views/layout';
import type { Env } from '../env';
import type { UserRow } from '../db/repos/users';

function user(c: { get(k: string): unknown }): UserRow {
  return c.get('user') as UserRow;
}

const PER_PAGE = 25;
const SORTS: SiteSort[] = ['name', 'status', 'pagespeed', 'load', 'updates'];
const FILTERS: Array<[SiteFilter, string]> = [
  ['all', 'All'],
  ['down', 'Down'],
  ['updates', 'Has updates'],
  ['ssl', 'SSL issues'],
];

function parseSort(v: string | undefined): SiteSort {
  return (SORTS as string[]).includes(v ?? '') ? (v as SiteSort) : 'name';
}
function parseFilter(v: string | undefined): SiteFilter {
  return FILTERS.some(([f]) => f === v) ? (v as SiteFilter) : 'all';
}
function parsePage(v: string | undefined): number {
  const n = Number(v ?? '1');
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function statusBadge(r: { currentStatus: string; verifiedAt: string | null }, id: number): string {
  if (!r.verifiedAt) return `<a class="badge unknown" href="/sites/${id}" title="Not verified yet — monitoring has not started">unverified</a>`;
  const title = r.currentStatus === 'down' ? 'Down after 2 consecutive failures' : r.currentStatus === 'up' ? 'Up' : 'Not checked yet';
  return `<span class="badge ${r.currentStatus}" title="${title}">${r.currentStatus}</span>`;
}

function scoreCell(v: number | null): string {
  if (v === null || v === undefined) return '<span class="muted" title="No PageSpeed result yet">n/a</span>';
  const cls = v >= 90 ? 'good' : v >= 50 ? 'warn' : 'bad';
  return `<span class="score ${cls}">${v}</span><span class="muted small">/100</span>`;
}

function loadCell(ms: number | null): string {
  if (ms === null || ms === undefined) return '<span class="muted">—</span>';
  return `${(ms / 1000).toFixed(2)} s`;
}

function secCell(n: number): string {
  if (!n) return '<span class="muted" title="No SSL problems">&#128274; 0</span>';
  return `<span class="bad" title="SSL problem">&#128274; ${n}</span>`;
}

function wpCell(n: number | null): string {
  if (n === null || n === undefined) return '<span class="muted" title="Not scanned yet">&#9432; ?</span>';
  if (n === 0) return '<span class="muted" title="No outdated components detected">&#9432; 0</span>';
  return `<span class="warn" title="${n} outdated component(s) detected (approximate)">&#9432; ${n}</span>`;
}

/** Link that swaps the dashboard panel via htmx (falls back to a normal GET). */
function hxLink(label: string, qs: string, active: boolean): string {
  return `<a href="${esc(qs)}" hx-get="${esc(qs)}&partial=1" hx-target="#site-panel" hx-swap="outerHTML" class="${active ? 'active' : ''}">${label}</a>`;
}

/** Query-string builder that keeps current params and overrides some. */
function makeQs(params: URLSearchParams): (over: Record<string, string>) => string {
  return (over) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(over)) p.set(k, v);
    const s = p.toString();
    return `/dashboard${s ? '?' + s : ''}`;
  };
}

export function dashboardRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  const render = async (c: any, full: boolean) => {
    const u = user(c);
    const db = makeDb(c.env);
    const params = new URL(c.req.url).searchParams;
    const sort = parseSort(params.get('sort') ?? undefined);
    const filter = parseFilter(params.get('filter') ?? undefined);
    const search = (params.get('q') ?? '').trim().slice(0, 200);
    const page = parsePage(params.get('page') ?? undefined);
    const qs = makeQs(params);

    const { rows, total } = await querySitesForUser(db, u.id, { sort, filter, search, page, perPage: PER_PAGE });
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));

    const trs = rows
      .map(
        (r) => `<tr>
  <td><a href="/sites/${r.id}">${esc(r.name)}</a><div class="muted small">${esc(new URL(r.url).hostname)}</div></td>
  <td>${statusBadge(r, r.id)}</td>
  <td>${scoreCell(r.pagespeedScore)}</td>
  <td>${loadCell(r.lastResponseMs)}</td>
  <td>${secCell(r.sslProblems)}</td>
  <td>${wpCell(r.updatesCount)}</td>
  <td><a class="muted" href="${esc(r.url)}" target="_blank" rel="noopener nofollow" title="Open site">&#8599;</a></td>
</tr>`,
      )
      .join('');

    const pager =
      pages > 1
        ? `<div class="pager">
    ${page > 1 ? hxLink('&larr; prev', qs({ page: String(page - 1) }), false) : ''}
    <span class="muted">page ${page} / ${pages}</span>
    ${page < pages ? hxLink('next &rarr;', qs({ page: String(page + 1) }), false) : ''}
  </div>`
        : '';

    const tbody =
      trs ||
      `<tr><td colspan="7" class="muted">${total === 0 ? (search || filter !== 'all' ? 'No sites match.' : 'No sites yet — add one to get started.') : ''}</td></tr>`;

    // The swappable panel: table + pager. Auto-refresh polls it every 30 s.
    const panel = `<div id="site-panel" hx-get="${esc(qs({ partial: '1' }))}" hx-trigger="every 30s" hx-swap="outerHTML">
<section class="card">
  <table class="table" id="site-table">
    <thead><tr><th>Site</th><th>Status</th><th>PageSpeed</th><th>Load</th><th>Security</th><th>WP updates</th><th></th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  ${pager}
</section>
</div>`;

    if (!full) return c.html(panel);

    const filterTabs = FILTERS.map(([f, label]) => hxLink(label, qs({ filter: f, page: '1' }), filter === f)).join(' ');
    const sortLinks = [
      ['Name', 'name'],
      ['Status', 'status'],
      ['PageSpeed', 'pagespeed'],
      ['Load time', 'load'],
      ['Updates', 'updates'],
    ]
      .map(([label, key]) => hxLink(label + (sort === key ? ' ▾' : ''), qs({ sort: key, page: '1' }), sort === key))
      .join(' · ');

    return layout(c, {
      title: 'Dashboard',
      user: u,
      active: 'dashboard',
      htmx: true,
      content: `
<h1>You are currently monitoring ${total} website${total === 1 ? '' : 's'}</h1>
<div class="toolbar">
  <a class="btn primary" href="/sites">Manage sites</a>
  <form class="inline-form search-form" action="/dashboard" method="GET"
        hx-get="/dashboard" hx-target="#site-panel" hx-swap="outerHTML"
        hx-trigger="keyup changed delay:400ms from:#q, submit">
    <input type="search" id="q" name="q" placeholder="Search name or URL…" value="${esc(search)}">
    <input type="hidden" name="sort" value="${esc(sort)}">
    <input type="hidden" name="filter" value="${esc(filter)}">
    <input type="hidden" name="partial" value="1">
  </form>
  <div class="tabs">${filterTabs}</div>
</div>
<div class="sortbar muted small">Sort: ${sortLinks}</div>
${panel}
<p class="muted small">Status is checked every 5 minutes; this view refreshes every 30 seconds. PageSpeed, security and WP-update columns fill in with later milestones.</p>`,
    });
  };

  app.get('/dashboard', async (c) => {
    const partial = c.req.query('partial') === '1';
    return render(c, !partial);
  });

  return app;
}
