import { describe, it, expect } from 'vitest';
import { randomToken, sha256hex, timingSafeEqual } from '../src/lib/tokens';

describe('tokens', () => {
  it('randomToken returns 64 hex chars for 32 bytes', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[a-f0-9]{64}$/);
  });

  it('randomToken values are unique', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toEqual(b);
  });

  it('sha256hex matches the known vector', async () => {
    expect(await sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('sha256hex is deterministic', async () => {
    const a = await sha256hex('hello world');
    const b = await sha256hex('hello world');
    expect(a).toBe(b);
  });

  it('timingSafeEqual compares correctly', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
