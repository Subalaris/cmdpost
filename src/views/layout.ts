import type { Context } from 'hono';
import type { UserRow } from '../db/repos/users';
import { icon, iconSprite } from './icons';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** Shared cmdPost shell for the dashboard, site management and account pages. */
export function layout(
  c: Context,
  opts: { title: string; content: string; user?: UserRow; active?: string; htmx?: boolean; charts?: boolean },
): Response {
  const { title, content, user, active } = opts;
  const htmxTag = opts.htmx ? '<script src="https://unpkg.com/htmx.org@1.9.12" defer></script>' : '';
  const chartTag = opts.charts
    ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.min.css">' +
      '<script src="https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.iife.min.js"></script>'
    : '';
  const brand = `<a class="brand" href="/dashboard" aria-label="cmdPost home"><span class="brand-mark">${icon('chevron')}</span>cmdPost<span>·</span></a>`;
  const navLink = (path: string, key: string, symbol: string, label: string) =>
    `<a href="${path}" ${active === key ? 'class="active" aria-current="page"' : ''}>${icon(symbol)}${label}</a>`;
  const initials = user?.name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'CP';
  const shell = user ? `
<aside class="sidebar" id="sidebar" aria-label="Main navigation">
  ${brand}
  <a class="workspace" href="/settings"><span class="avatar">${esc(initials)}</span><span><strong>${esc(user.name)}</strong><small>Personal workspace</small></span>${icon('down')}</a>
  <nav class="nav" aria-label="Workspace">
    ${navLink('/dashboard', 'dashboard', 'grid', 'Websites')}
    <span class="nav-label">WORKSPACE TOOLS</span>
    ${navLink('/sites', 'sites', 'globe', 'Manage websites')}
  </nav>
  <nav class="nav bottom-nav" aria-label="Account">
    <span class="nav-label">MY ACCOUNT</span>
    ${navLink('/settings', 'settings', 'settings', 'Settings & profile')}
    ${user.isAdmin ? navLink('/admin', 'admin', 'shield', 'Administration') : ''}
    <a href="/privacy">${icon('lock')}Privacy</a>
    <form method="POST" action="/auth/logout"><button type="submit">${icon('external')}Sign out</button></form>
  </nav>
  <div class="side-footer"><span>YOUR SITES. SORTED.</span><span>v.1.0</span></div>
</aside><button class="sidebar-backdrop" aria-label="Close navigation" tabindex="-1" hidden></button>`
    : `<header class="topbar">${brand}<nav><a href="/privacy">Privacy</a><a href="/login">Sign in</a></nav></header>`;
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ba2873">
<title>${esc(title)} — cmdPost</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;650;700;750;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
${htmxTag}${chartTag}
<script src="/app.js" defer></script>
</head>
<body class="${user ? 'app-shell' : 'public-shell'}">
${iconSprite}
<a class="skip-link" href="#main">Skip to content</a>
${shell}
<main id="main" class="container">
${user ? `<div class="topline"><div class="breadcrumb"><button class="mobile-menu" id="menu" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button><a href="/dashboard">Workspace</a>${icon('chevron')}<span>${esc(title)}</span></div><span class="top-right">${icon('shield')}Your websites, in good hands.</span></div>` : ''}
${content}
<footer class="footnote"><span>${icon('shield')}Your command center for a healthier web.</span><span><a href="/privacy">Privacy</a><a href="mailto:abuse@wpmonitor.example">Issues or abuse? Get in touch ↗</a></span></footer>
</main>
</body>
</html>`);
}

export function pageHead(opts: { title: string; user?: UserRow; active?: string }): string {
  return `<h1>${esc(opts.title)}</h1>`;
}
