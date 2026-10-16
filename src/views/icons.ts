/** Small shared icon set from the cmdPost design reference. */
export const iconSprite = `
<svg xmlns="http://www.w3.org/2000/svg" class="icon-sprite" aria-hidden="true">
<symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/></symbol>
<symbol id="i-tasks" viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/></symbol>
<symbol id="i-help" viewBox="0 0 24 24"><path d="M4 14v-3a8 8 0 0 1 16 0v3M4 12H3v6h4v-6Zm16 0h1v6h-4v-6Zm0 6v2h-6"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 3 3-1 2 2 3-1 1-3 3-1 1-3-2-2 1-3-3-2-3 1-2-2Z"/><circle cx="11" cy="11" r="3"/></symbol>
<symbol id="i-chevron" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></symbol>
<symbol id="i-down" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></symbol>
<symbol id="i-double" viewBox="0 0 24 24"><path d="m5 5 7 7-7 7m7-14 7 7-7 7"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></symbol>
<symbol id="i-external" viewBox="0 0 24 24"><path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/></symbol>
<symbol id="i-gauge" viewBox="0 0 24 24"><path d="M3 17a9 9 0 1 1 18 0v3H3Zm9-1 5-7M6 11l2 1m4-7v3"/><circle cx="12" cy="16" r="1.5"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="6" y="10" width="12" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></symbol>
<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></symbol>
<symbol id="i-pulse" viewBox="0 0 24 24"><path d="M2 12h5l3-8 4 16 3-8h5"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6"/></symbol>
<symbol id="i-bell" viewBox="0 0 24 24"><path d="M5 16h14l-2-3V8A5 5 0 0 0 7 8v5Zm5 4h4"/></symbol>
<symbol id="i-sort" viewBox="0 0 24 24"><path d="M4 6h16M4 12h11M4 18h6"/></symbol>
<symbol id="i-filter" viewBox="0 0 24 24"><path d="M3 4h18l-7 8v7l-4 2v-9Z"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-card" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20m-15 5h3"/></symbol>
<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></symbol>
</svg>`;

export function icon(name: string): string {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
