/**
 * SSRF protection for all outbound requests to user-provided URLs.
 *
 * Rules (spec): http/https only, no IP literals, no localhost or private
 * ranges. Redirects are followed MANUALLY (max 3) and every hop is
 * re-validated. Response bodies are capped. A short timeout and an
 * identifying User-Agent are always applied.
 *
 * Note: Workers cannot resolve DNS before connecting, so hostname-based
 * blocking covers literal IPs and reserved names; a hostile domain that
 * *resolves* to a private IP is mitigated by the fact that we only ever
 * request sites the user added AND verified ownership of, and we never
 * send credentials. (Documented limitation, standard for this architecture.)
 */

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan', '.localdomain'];

export const MONITOR_UA = 'WPMonitor/1.0 (private monitoring)';

export interface SsrfOk { ok: true; url: URL }
export interface SsrfFail { ok: false; reason: string }
export type SsrfResult = SsrfOk | SsrfFail;

function isIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
}

function isPrivateV4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Validate a URL is safe and public. Never fetch a URL that fails this. */
export function validatePublicUrl(raw: string): SsrfResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }
  const host = url.hostname.toLowerCase();

  // IPv6 literal (URL keeps brackets) — block all: cheap ULA/loopback checks
  // are error-prone, and no legitimate monitored site needs a literal.
  if (host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'ip_literal' };

  if (isIpv4(host)) {
    // Spec: no IP literals at all (private ones are doubly rejected).
    return { ok: false, reason: isPrivateV4(host.split('.').map(Number)) ? 'private_range' : 'ip_literal' };
  }

  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'blocked_host' };
  }
  if (!host.includes('.')) return { ok: false, reason: 'no_domain' };
  if (host.startsWith('.') || host.endsWith('.')) return { ok: false, reason: 'bad_hostname' };

  return { ok: true, url };
}

export interface FetchPublicOptions {
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface FetchPublicResult {
  ok: boolean;
  status: number;
  body?: string;
  error?: string;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null; // timeout or network error
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return out;
}

/**
 * Fetch a public URL with manual redirect following (max 3 hops, each
 * re-validated), a hard timeout, a capped body, and the WPMonitor UA.
 * Never throws: failures come back as { ok: false, error }.
 */
export async function fetchPublic(rawUrl: string, opts: FetchPublicOptions = {}): Promise<FetchPublicResult> {
  const { method = 'GET', timeoutMs = 10000, maxBytes = 200_000 } = opts;
  let current = rawUrl;

  for (let hop = 0; hop <= 3; hop++) {
    const v = validatePublicUrl(current);
    if (!v.ok) return { ok: false, status: 0, error: `ssrf:${v.reason}` };

    const res = await fetchWithTimeout(
      v.url.toString(),
      { method, redirect: 'manual', headers: { 'User-Agent': MONITOR_UA, Accept: '*/*', ...opts.headers } },
      timeoutMs,
    );
    if (!res) return { ok: false, status: 0, error: 'timeout' };

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, status: res.status, error: 'redirect_no_location' };
      try {
        current = new URL(loc, current).toString();
      } catch {
        return { ok: false, status: res.status, error: 'bad_redirect' };
      }
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: `http_${res.status}` };
    }
    if (method === 'HEAD') return { ok: true, status: res.status };
    return { ok: true, status: res.status, body: await readCapped(res, maxBytes) };
  }
  return { ok: false, status: 0, error: 'too_many_redirects' };
}
