/**
 * Up/Down state machine (pure, unit-tested).
 *
 * Rules (spec): a site flips to Down only after 2 CONSECUTIVE failures, and
 * back to Up after 1 success. Transitions are reported so the alert job
 * (milestone 4) can fire exactly once per Up↔Down flip.
 *
 * unknown + 1 failure  → unknown (fails=1)   — no alert
 * unknown + 2 failures → down                — no alert (never was up)
 * up      + 1 failure  → up (fails=1)        — no alert
 * up      + 2 failures → down                — alert "up-to-down"
 * down    + success    → up                  — alert "down-to-up"
 * any     + success    → up, fails reset to 0
 */

export type SiteStatus = 'up' | 'down' | 'unknown';

export interface SiteState {
  status: SiteStatus;
  consecutiveFailures: number;
}

export type Transition = 'up-to-down' | 'down-to-up' | null;

export interface NextState extends SiteState {
  /** Status value actually changed this check. */
  changed: boolean;
  /** Alert-worthy transition (only up↔down flips). */
  transition: Transition;
}

export const DOWN_AFTER_FAILURES = 2;

export function applyCheck(prev: SiteState, ok: boolean): NextState {
  if (ok) {
    const changed = prev.status !== 'up';
    return {
      status: 'up',
      consecutiveFailures: 0,
      changed,
      transition: changed && prev.status === 'down' ? 'down-to-up' : null,
    };
  }
  const fails = prev.consecutiveFailures + 1;
  if (prev.status === 'down') {
    return { status: 'down', consecutiveFailures: fails, changed: false, transition: null };
  }
  if (fails >= DOWN_AFTER_FAILURES) {
    return {
      status: 'down',
      consecutiveFailures: fails,
      changed: true,
      // unknown → down is NOT an up-to-down alert (the site was never up).
      transition: prev.status === 'up' ? 'up-to-down' : null,
    };
  }
  // First failure while up/unknown: keep the previous status.
  return { status: prev.status, consecutiveFailures: fails, changed: false, transition: null };
}
