/**
 * WordPress fingerprint PARSERS — pure functions over HTML/text so they are
 * unit-testable with saved fixtures (spec requirement). No fetching here.
 *
 * What we detect (only what the page itself reveals — no enumeration):
 *  - core version: meta generator → /feed/ generator → /readme.html
 *  - plugins: /wp-content/plugins/<slug>/ in src/href, ?ver= when present
 *  - themes: /wp-content/themes/<slug>/ paths; active theme = the one whose
 *    path appears in a <link rel="stylesheet"> href
 */

export interface ParsedPlugin {
  slug: string;
  version: string | null;
  /** 'asset_ver' = from ?ver= on an asset URL (may differ from real version). */
  versionSource: 'asset_ver' | null;
}

export interface ParsedThemes {
  slugs: string[];
  activeSlug: string | null;
}

export function parseCoreVersion(html: string): string | null {
  const m = /<meta[^>]+name=["']?generator["']?[^>]+content=["']?WordPress\s+([\d][\w.\-]*)/i.exec(html);
  return m ? m[1] : null;
}

/** /feed/ → <generator>https://wordpress.org/?v=6.5.3</generator> (current WP)
 *  or <generator ... version="6.5.3">WordPress</generator> (older variants). */
export function parseFeedVersion(xml: string): string | null {
  const m = /<generator[^>]*version=["']([\d][\w.\-]*)["'][^>]*>\s*WordPress\s*<\/generator>/i.exec(xml);
  if (m) return m[1];
  const m2 = /<generator[^>]*>\s*WordPress\s+([\d][\w.\-]*)\s*<\/generator>/i.exec(xml);
  if (m2) return m2[1];
  const m3 = /<generator[^>]*>\s*https?:\/\/wordpress\.org\/\?v=([\d][\w.\-]*)\s*<\/generator>/i.exec(xml);
  return m3 ? m3[1] : null;
}

/** /readme.html → <h1>WordPress <span class="version">6.4.2</span></h1> */
export function parseReadmeVersion(html: string): string | null {
  const m = /<h1[^>]*>\s*WordPress\s*<span[^>]*class=["']version["'][^>]*>\s*([\d][\w.\-]*)\s*<\/span>/i.exec(html);
  if (m) return m[1];
  const m2 = /WordPress\s*<span[^>]*class=["']version["'][^>]*>\s*([\d][\w.\-]*)/i.exec(html);
  return m2 ? m2[1] : null;
}

/** readme.txt → "Stable tag: 5.7.2" */
export function parseStableTag(readmeTxt: string): string | null {
  const m = /^Stable tag:\s*(\S+)/im.exec(readmeTxt);
  return m ? m[1].trim() : null;
}

/** style.css header → "Version: 1.6" (within the first comment block). */
export function parseStyleCssVersion(css: string): string | null {
  const head = css.slice(0, 4000);
  const m = /^[\s\/*]*Version:\s*([\d][\w.\-]*)/im.exec(head);
  return m ? m[1] : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plugins: scan src=/href= attribute values for /wp-content/plugins/<slug>/
 * and capture ?ver= from the SAME url. Bounded regex over attribute values
 * (cheap, CPU-safe) rather than full HTML parsing.
 */
export function parsePlugins(html: string, max = 30): ParsedPlugin[] {
  const out = new Map<string, ParsedPlugin>();
  const attrRe = /(?:src|href)\s*=\s*["']([^"']*\/wp-content\/plugins\/[a-zA-Z0-9._-]+\/[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(html)) !== null) {
    const url = m[1];
    const slugM = /\/wp-content\/plugins\/([a-zA-Z0-9._-]+)\//.exec(url);
    if (!slugM) continue;
    const slug = slugM[1].toLowerCase();
    if (slug === 'wp-includes' || slug.length < 2) continue;
    const verM = /[?&]ver=([\w.\-]+)/.exec(url);
    const existing = out.get(slug);
    if (!existing) {
      out.set(slug, { slug, version: verM ? verM[1] : null, versionSource: verM ? 'asset_ver' : null });
    } else if (!existing.version && verM) {
      existing.version = verM[1];
      existing.versionSource = 'asset_ver';
    }
    if (out.size >= max) break;
  }
  return [...out.values()];
}

/** Themes: /wp-content/themes/<slug>/ paths; active = stylesheet link match. */
export function parseThemes(html: string): ParsedThemes {
  const slugs = new Set<string>();
  const re = /\/wp-content\/themes\/([a-zA-Z0-9._-]+)\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const s = m[1].toLowerCase();
    if (s.length >= 2) slugs.add(s);
    if (slugs.size >= 20) break;
  }
  // Active theme: first theme slug appearing in a <link rel="stylesheet">.
  let activeSlug: string | null = null;
  const linkRe = /<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null && !activeSlug) {
    const t = /\/wp-content\/themes\/([a-zA-Z0-9._-]+)\//i.exec(m[0]);
    if (t && slugs.has(t[1].toLowerCase())) activeSlug = t[1].toLowerCase();
  }
  return { slugs: [...slugs], activeSlug };
}
