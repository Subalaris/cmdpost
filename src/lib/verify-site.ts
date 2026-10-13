/**
 * Site ownership verification. A site is verified when ANY ONE of:
 *   a) DNS TXT record at _wpmonitor.<domain> contains the token
 *      (checked via DNS-over-HTTPS against Cloudflare's resolver)
 *   b) <meta name="wpmonitor-verification" content="TOKEN"> on the homepage
 *   c) a file at /wpmonitor-TOKEN.txt on the site containing the token
 *
 * Only the verification attempt itself makes requests (unverified sites
 * receive zero monitoring traffic). All fetches go through fetchPublic
 * (SSRF-validated, capped, timed out, identifying UA).
 */
import { fetchPublic } from './ssrf';
import { domainOf } from '../db/repos/sites';

export type VerifyMethod = 'dns' | 'meta' | 'file';

/** TXT lookup via Cloudflare DoH (application/dns-json). */
export async function verifyViaDns(domain: string, token: string): Promise<boolean> {
  const name = `_wpmonitor.${domain}`;
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
      { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { Answer?: { data?: string }[] };
    return (data.Answer ?? []).some((a) => (a.data ?? '').replace(/"/g, '').includes(token));
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect <meta name="wpmonitor-verification" content="TOKEN"> — either
 * attribute order, with or without quotes. Pure function (unit-testable).
 */
export function metaTagPresent(html: string, token: string): boolean {
  const t = escapeRe(token);
  const re = new RegExp(
    `<meta[^>]+name=["']?wpmonitor-verification["']?[^>]*content=["']?${t}["']?` +
      `|<meta[^>]+content=["']?${t}["']?[^>]*name=["']?wpmonitor-verification["']?`,
    'i',
  );
  return re.test(html);
}

export async function verifyViaMeta(siteUrl: string, token: string): Promise<boolean> {
  const r = await fetchPublic(siteUrl, { method: 'GET', maxBytes: 300_000, timeoutMs: 10000 });
  return r.ok && !!r.body && metaTagPresent(r.body, token);
}

export async function verifyViaFile(siteUrl: string, token: string): Promise<boolean> {
  // Always at the ORIGIN root, regardless of the site's path.
  const fileUrl = new URL(`/wpmonitor-${token}.txt`, siteUrl).toString();
  const r = await fetchPublic(fileUrl, { method: 'GET', maxBytes: 4096, timeoutMs: 10000 });
  return r.ok && !!r.body && r.body.trim() === token;
}

/** Try dns → meta → file; return the first method that proves ownership. */
export async function verifySite(siteUrl: string, token: string): Promise<VerifyMethod | null> {
  const domain = domainOf(siteUrl);
  if (domain && (await verifyViaDns(domain, token))) return 'dns';
  if (await verifyViaMeta(siteUrl, token)) return 'meta';
  if (await verifyViaFile(siteUrl, token)) return 'file';
  return null;
}
