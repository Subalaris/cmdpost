import type { Context } from 'hono';
import type { UserRow } from '../db/repos/users';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** Shared HTML shell (header nav + footer with abuse contact). */
export function layout(
  c: Context,
  opts: { title: string; content: string; user?: UserRow; active?: string; htmx?: boolean; charts?: boolean },
): Response {
  const { title, content, user, active } = opts;
  const htmxTag = opts.htmx
    ? '<script src="https://unpkg.com/htmx.org@1.9.12" defer></script>'
    : '';
  const chartTag = opts.charts
    ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.min.css">' +
      '<script src="https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.iife.min.js"></script>'
    : '';
  const nav = user
    ? `<nav class="nav">
        <a href="/dashboard" class="${active === 'dashboard' ? 'active' : ''}">Dashboard</a>
        <a href="/sites" class="${active === 'sites' ? 'active' : ''}">Sites</a>
        <a href="/settings" class="${active === 'settings' ? 'active' : ''}">Settings</a>
        ${user.isAdmin ? `<a href="/admin" class="${active === 'admin' ? 'active' : ''}">Admin</a>` : ''}
        <form method="POST" action="/auth/logout" class="inline-form"><button type="submit" class="linkish">Sign out</button></form>
      </nav>`
    : `<nav class="nav"><a href="/privacy">Privacy</a><a href="/login">Sign in</a></nav>`;
  return c.html(/* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — WPMonitor</title>
<link rel="stylesheet" href="/styles.css">
${htmxTag}
${chartTag}
</head>
<body>
<header class="topbar">
  <div class="brand"><a href="/dashboard">WPMonitor</a></div>
  ${nav}
</header>
<main class="container">
${content}
</main>
<footer class="footer">
  <span>WPMonitor — monitoring only, we never write to your sites.</span>
  <span>Issues or abuse? <a href="mailto:abuse@wpmonitor.example">abuse@wpmonitor.example</a></span>
  <span><a href="/privacy">Privacy</a></span>
</footer>
</body>
</html>`);
}

export function pageHead(opts: { title: string; user?: UserRow; active?: string }): string {
  return `<h1>${esc(opts.title)}</h1>`;
}
