/**
 * Environment / config access.
 * All env vars are read here and nowhere else — tests build plain objects.
 */
export interface Env {
  DB: D1Database;
  SIGNUP_MODE?: string;
  ADMIN_EMAIL?: string;
  MAX_USERS?: string;
  MAX_SITES_PER_USER?: string;
  MAX_SITES_TOTAL?: string;
  APP_BASE_URL?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  PAGESPEED_API_KEY?: string;
  INGEST_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DEV_MODE?: string;
  RUN_JOBS_IN_DEV?: string;
  UPTIME_BATCH?: string;
  UPTIME_MIN_INTERVAL_MS?: string;
  PAGESPEED_BATCH?: string;
  FINGERPRINT_BATCH?: string;
}

export interface Config {
  signupMode: 'open' | 'approval' | 'closed';
  adminEmail: string;
  maxUsers: number;
  maxSitesPerUser: number;
  maxSitesTotal: number;
  appBaseUrl: string;
  devMode: boolean;
  resendApiKey: string;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  pagespeedApiKey: string;
  ingestToken: string;
  googleClientId: string;
  googleClientSecret: string;
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: Env): Config {
  const rawMode = (env.SIGNUP_MODE ?? 'approval').toLowerCase();
  const signupMode: Config['signupMode'] =
    rawMode === 'open' || rawMode === 'closed' ? rawMode : 'approval';
  return {
    signupMode,
    adminEmail: (env.ADMIN_EMAIL ?? '').toLowerCase(),
    maxUsers: toInt(env.MAX_USERS, 50),
    maxSitesPerUser: toInt(env.MAX_SITES_PER_USER, 5),
    maxSitesTotal: toInt(env.MAX_SITES_TOTAL, 150),
    appBaseUrl: (env.APP_BASE_URL ?? '').replace(/\/+$/, ''),
    devMode: env.DEV_MODE === 'true',
    resendApiKey: env.RESEND_API_KEY ?? '',
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '',
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY ?? '',
    pagespeedApiKey: env.PAGESPEED_API_KEY ?? '',
    ingestToken: env.INGEST_TOKEN ?? '',
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
  };
}

/** Loud, unmissable warning — spec: DEV_MODE must never be on in production.
 *  Warn once per process (not per request) — the app is rebuilt per fetch. */
let devModeWarned = false;
export function warnDevMode(cfg: Config): void {
  if (cfg.devMode && !devModeWarned) {
    devModeWarned = true;
    // eslint-disable-next-line no-console
    console.error(
      '============================================================\n' +
        '  *** WPMONITOR: DEV_MODE=TRUE IS SET ***\n' +
        '  *** Turnstile verification is SKIPPED. ***\n' +
        '  *** NEVER deploy with DEV_MODE=true. ***\n' +
        '============================================================',
    );
  }
}
