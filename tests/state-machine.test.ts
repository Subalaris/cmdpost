import { describe, it, expect } from 'vitest';
import { applyCheck, type SiteState, type NextState } from '../src/lib/state-machine';

const up: SiteState = { status: 'up', consecutiveFailures: 0 };
const unknown: SiteState = { status: 'unknown', consecutiveFailures: 0 };
const down: SiteState = { status: 'down', consecutiveFailures: 2 };

describe('Up/Down state machine (spec: down after 2 consecutive failures, up after 1 success)', () => {
  it('success always → up, failures reset', () => {
    expect(applyCheck(up, true)).toMatchObject({ status: 'up', consecutiveFailures: 0, changed: false, transition: null });
    expect(applyCheck(unknown, true)).toMatchObject({ status: 'up', changed: true, transition: null });
    expect(applyCheck(down, true)).toMatchObject({ status: 'up', changed: true, transition: 'down-to-up' });
  });

  it('first failure does NOT flip to down', () => {
    expect(applyCheck(up, false)).toMatchObject({ status: 'up', consecutiveFailures: 1, changed: false, transition: null });
    expect(applyCheck(unknown, false)).toMatchObject({ status: 'unknown', consecutiveFailures: 1, changed: false, transition: null });
  });

  it('second consecutive failure flips up → down with up-to-down alert', () => {
    const oneFail = applyCheck(up, false);
    const twoFail = applyCheck(oneFail, false);
    expect(twoFail).toMatchObject({ status: 'down', consecutiveFailures: 2, changed: true, transition: 'up-to-down' });
  });

  it('unknown → down is NOT an alert (site was never up)', () => {
    const f1 = applyCheck(unknown, false);
    const f2 = applyCheck(f1, false);
    expect(f2).toMatchObject({ status: 'down', changed: true, transition: null });
  });

  it('repeated failures while down never re-alert', () => {
    let s: NextState = applyCheck(applyCheck(up, false), false);
    for (let i = 0; i < 5; i++) {
      s = applyCheck(s, false);
      expect(s.status).toBe('down');
      expect(s.transition).toBeNull();
      expect(s.changed).toBe(false);
    }
    expect(s.consecutiveFailures).toBe(7);
  });

  it('success resets the failure counter mid-streak', () => {
    const f1 = applyCheck(up, false); // fails=1
    const ok = applyCheck(f1, true); // success
    expect(ok).toMatchObject({ status: 'up', consecutiveFailures: 0 });
    // now a fresh failure starts a new streak of 1
    expect(applyCheck(ok, false)).toMatchObject({ status: 'up', consecutiveFailures: 1 });
  });

  it('full cycle up → down → up produces exactly one alert each way', () => {
    let s: NextState = { ...up, changed: false, transition: null };
    const transitions: string[] = [];
    s = applyCheck(s, false);
    s = applyCheck(s, false);
    if (s.transition) transitions.push(s.transition);
    s = applyCheck(s, true);
    if (s.transition) transitions.push(s.transition);
    expect(transitions).toEqual(['up-to-down', 'down-to-up']);
  });
});
