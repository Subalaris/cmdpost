import type { Env } from '../env';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  ok: boolean;
  channel: 'resend' | 'console';
  error?: string;
}

/**
 * Send email via Resend. When RESEND_API_KEY is empty the email body (and any
 * magic-link URL inside it) is printed to the console instead — local dev
 * works with zero external accounts.
 */
export async function sendEmail(env: Env, input: SendEmailInput): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    // eslint-disable-next-line no-console
    console.log(
      '--------------------------------------------------------------\n' +
        `[email:console] TO: ${input.to}\n` +
        `[email:console] SUBJECT: ${input.subject}\n` +
        input.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() +
        '\n--------------------------------------------------------------',
    );
    return { ok: true, channel: 'console' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'WPMonitor <onboarding@resend.dev>',
        to: [input.to],
        subject: input.subject,
        html: input.html,
      }),
    });
    if (!res.ok) {
      return { ok: false, channel: 'resend', error: `resend ${res.status}` };
    }
    return { ok: true, channel: 'resend' };
  } catch (err) {
    return { ok: false, channel: 'resend', error: String(err) };
  }
}

/** Build the public base URL for magic links (APP_BASE_URL or request origin). */
export function baseUrlFor(env: Env, req: Request): string {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, '');
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'http://localhost:8787';
  }
}
