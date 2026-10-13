import type { Context, Next } from 'hono';
import type { Env } from '../env';

export interface TurnstileResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a Cloudflare Turnstile response token.
 * - DEV_MODE=true  -> skip entirely (local dev; loud warning elsewhere)
 * - TURNSTILE_SECRET_KEY empty -> skip (so local dev works without an account)
 * - otherwise POST to https://challenges.cloudflare.com/turnstile/v0/siteverify
 */
export async function verifyTurnstile(env: Env, token: string | undefined): Promise<TurnstileResult> {
  if (env.DEV_MODE === 'true') return { ok: true };
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true };
  if (!token) return { ok: false, reason: 'missing_token' };

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(env.TURNSTILE_SECRET_KEY)}&response=${encodeURIComponent(token)}&origin=${env.APP_BASE_URL ?? ''}`,
    });
    if (!res.ok) return { ok: false, reason: 'verify_failed' };
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (data.success) return { ok: true };
    return { ok: false, reason: data['error-codes']?.join(',') ?? 'rejected' };
  } catch {
    return { ok: false, reason: 'verify_error' };
  }
}

/**
 * Middleware: require a valid Turnstile token in the POST body (form field
 * 'cf-turnstile-response') or the ?token query param.
 */
export function requireTurnstile(env: Env) {
  return async (c: Context, next: Next) => {
    const token =
      (await readBodyField(c, 'cf-turnstile-response')) ??
      c.req.query('token');
    const result = await verifyTurnstile(env, token);
    if (!result.ok) {
      return c.json({ error: 'Verification failed. Please try again.' }, 400);
    }
    await next();
  };
}

async function readBodyField(c: Context, field: string): Promise<string | undefined> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await c.req.text();
    return new URLSearchParams(text).get(field) ?? undefined;
  }
  if (ct.includes('application/json')) {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const v = body[field];
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
