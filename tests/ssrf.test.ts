import { describe, it, expect } from 'vitest';
import { validatePublicUrl, MONITOR_UA } from '../src/lib/ssrf';

describe('SSRF validator', () => {
  it('accepts normal public URLs', () => {
    for (const u of [
      'https://example.com',
      'https://blog.example.org/path/page?x=1',
      'http://sub.example.co.uk/',
    ]) {
      const r = validatePublicUrl(u);
      expect(r.ok, u).toBe(true);
    }
  });

  it('rejects non-http schemes', () => {
    for (const u of ['file:///etc/passwd', 'gopher://example.com', 'ftp://example.com', 'javascript:alert(1)']) {
      expect(validatePublicUrl(u).ok, u).toBe(false);
    }
  });

  it('rejects IP literals (public and private)', () => {
    for (const u of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://8.8.8.8/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/']) {
      expect(validatePublicUrl(u).ok, u).toBe(false);
    }
  });

  it('rejects localhost and reserved suffixes', () => {
    for (const u of ['http://localhost/', 'http://localhost:8787/', 'http://db.internal/', 'http://x.local/', 'http://host.lan/']) {
      expect(validatePublicUrl(u).ok, u).toBe(false);
    }
  });

  it('rejects bare hostnames without a dot', () => {
    expect(validatePublicUrl('http://myserver/').ok).toBe(false);
  });

  it('rejects garbage', () => {
    expect(validatePublicUrl('not a url').ok).toBe(false);
    expect(validatePublicUrl('').ok).toBe(false);
  });

  it('exposes the identifying User-Agent', () => {
    expect(MONITOR_UA).toBe('WPMonitor/1.0 (private monitoring)');
  });
});
