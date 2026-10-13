import { describe, it, expect } from 'vitest';
import { metaTagPresent } from '../src/lib/verify-site';

const TOKEN='***';

describe('meta tag verification parser', () => {
  it('detects the meta tag (name first)', () => {
    const html = `<html><head><meta name="wpmonitor-verification" content="${TOKEN}"></head>`;
    expect(metaTagPresent(html, TOKEN)).toBe(true);
  });

  it('detects the meta tag (content first)', () => {
    const html = `<head><meta content="${TOKEN}" name="wpmonitor-verification">`;
    expect(metaTagPresent(html, TOKEN)).toBe(true);
  });

  it('detects unquoted attributes', () => {
    const html = `<meta name=wpmonitor-verification content=${TOKEN}>`;
    expect(metaTagPresent(html, TOKEN)).toBe(true);
  });

  it('rejects a wrong token', () => {
    const html = `<meta name="wpmonitor-verification" content="wrong-token">`;
    expect(metaTagPresent(html, TOKEN)).toBe(false);
  });

  it('rejects a meta tag with the token in the wrong attribute', () => {
    const html = `<meta name="${TOKEN}" content="wpmonitor-verification">`;
    expect(metaTagPresent(html, TOKEN)).toBe(false);
  });

  it('rejects unrelated pages', () => {
    expect(metaTagPresent('<html><head><title>Hi</title></head>', TOKEN)).toBe(false);
    expect(metaTagPresent('', TOKEN)).toBe(false);
  });

  it('is case-insensitive on the tag/attr names', () => {
    const html = `<META NAME="WPMonitor-Verification" CONTENT="${TOKEN}">`;
    expect(metaTagPresent(html, TOKEN)).toBe(true);
  });
});
