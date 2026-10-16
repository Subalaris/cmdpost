import { describe, it, expect } from 'vitest';
import { compareVersions, isOutdated } from '../src/lib/version-compare';

describe('compareVersions (tolerant)', () => {
  it('numeric segments', () => {
    expect(compareVersions('6.4.2', '6.4.1')).toBe(1);
    expect(compareVersions('6.4.1', '6.4.2')).toBe(-1);
    expect(compareVersions('6.4.2', '6.4.2')).toBe(0);
    expect(compareVersions('6.10', '6.9')).toBe(1); // numeric, not lexicographic
  });

  it('missing parts equal zero', () => {
    expect(compareVersions('6.4', '6.4.0')).toBe(0);
    expect(compareVersions('6.4.1', '6.4')).toBe(1);
  });

  it('prerelease sorts below release', () => {
    expect(compareVersions('6.4.2-beta1', '6.4.2')).toBe(-1);
    expect(compareVersions('6.4.2', '6.4.2-beta1')).toBe(1);
    expect(compareVersions('1.0.0-rc1', '1.0.0-beta2')).toBe(1); // rc > beta lexicographically
  });

  it('date-style and junk suffixes', () => {
    expect(compareVersions('20241001.1', '20241001.0')).toBe(1);
    expect(compareVersions('5.7.2+build5', '5.7.2')).toBe(-1);
    expect(compareVersions('v6.4.2', '6.4.2')).toBe(0); // leading v ignored
  });

  it('garbage does not throw', () => {
    expect(() => compareVersions('abc', '1.2.3')).not.toThrow();
    expect(() => compareVersions('', '')).not.toThrow();
  });
});

describe('isOutdated', () => {
  it('older detected → true', () => expect(isOutdated('5.7.1', '5.7.2')).toBe(true));
  it('equal → false', () => expect(isOutdated('5.7.2', '5.7.2')).toBe(false));
  it('newer detected (beta ahead) → false', () => expect(isOutdated('6.5-beta1', '6.4.3')).toBe(false));
  it('unknown detected → false (never claim outdated)', () => expect(isOutdated(null, '5.7.2')).toBe(false));
  it('unknown latest → false', () => expect(isOutdated('5.7.2', null)).toBe(false));
});
