import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseCoreVersion, parseFeedVersion, parseReadmeVersion, parseStableTag,
  parseStyleCssVersion, parsePlugins, parseThemes,
} from '../src/lib/fingerprint';

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url) as unknown as string), 'utf8');

describe('fingerprint parsers — saved fixtures', () => {
  const normal = fx('wp-normal.html');
  const hidden = fx('wp-hidden.html');

  it('core version from meta generator', () => {
    expect(parseCoreVersion(normal)).toBe('6.4.2');
    expect(parseCoreVersion(hidden)).toBeNull(); // security plugin stripped it
  });

  it('core version from feed generator (fallback)', () => {
    expect(parseFeedVersion(fx('feed.xml'))).toBe('6.5.3');
    expect(parseFeedVersion('<rss><channel><title>x</title></channel></rss>')).toBeNull();
  });

  it('core version from readme.html (fallback)', () => {
    expect(parseReadmeVersion(fx('readme.html'))).toBe('6.3.1');
    expect(parseReadmeVersion('<html>no version here</html>')).toBeNull();
  });

  it('plugins: slug + ?ver= from the same URL', () => {
    const plugins = parsePlugins(normal);
    const bySlug = new Map(plugins.map((p) => [p.slug, p]));
    expect(bySlug.has('jetpack')).toBe(true);
    expect(bySlug.get('jetpack')!.version).toBe('13.0');
    expect(bySlug.get('jetpack')!.versionSource).toBe('asset_ver');
    expect(bySlug.get('contact-form-7')!.version).toBe('5.8.6');
    expect(bySlug.get('woocommerce')!.version).toBeNull(); // no ?ver=
    expect(bySlug.get('elementor')!.version).toBeNull();
  });

  it('plugins: hidden-version fixture still finds slugs', () => {
    const plugins = parsePlugins(hidden);
    const slugs = plugins.map((p) => p.slug);
    expect(slugs).toContain('secret-premium-plugin');
    expect(slugs).toContain('other-plugin');
    expect(plugins.find((p) => p.slug === 'secret-premium-plugin')!.version).toBe('9.9.9');
  });

  it('plugins: dedupes slugs, prefers a URL that has ?ver=', () => {
    const html = '<script src="/wp-content/plugins/myplug/a.js"></script><script src="/wp-content/plugins/myplug/b.js?ver=2.0"></script>';
    const plugins = parsePlugins(html);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].version).toBe('2.0');
  });

  it('plugins: ignores uploads and non-plugin paths', () => {
    const plugins = parsePlugins(normal);
    expect(plugins.map((p) => p.slug)).not.toContain('uploads');
  });

  it('themes: slugs + active theme from stylesheet link', () => {
    const themes = parseThemes(normal);
    expect(themes.slugs).toContain('twentytwentyfour');
    expect(themes.activeSlug).toBe('twentytwentyfour');
  });

  it('themes: hidden fixture — slug found, active theme is the stylesheet', () => {
    const themes = parseThemes(hidden);
    expect(themes.slugs).toContain('flavor');
    expect(themes.activeSlug).toBe('flavor');
  });

  it('themes: no stylesheet link → active null', () => {
    const themes = parseThemes('<img src="/wp-content/themes/child/s.png">');
    expect(themes.slugs).toEqual(['child']);
    expect(themes.activeSlug).toBeNull();
  });

  it('readme.txt Stable tag', () => {
    expect(parseStableTag('=== Plugin ===\nStable tag: 5.7.2\n\nChangelog')).toBe('5.7.2');
    expect(parseStableTag('Stable tag: 1.0-beta3')).toBe('1.0-beta3');
    expect(parseStableTag('no header here')).toBeNull();
  });

  it('style.css Version header', () => {
    expect(parseStyleCssVersion('/*\nTheme Name: X\nVersion: 1.6\n*/\nbody{}')).toBe('1.6');
    expect(parseStyleCssVersion('/* Version: 2024.10.1 */')).toBe('2024.10.1');
    expect(parseStyleCssVersion('body { color: red }')).toBeNull();
  });
});
