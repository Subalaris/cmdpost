/**
 * Alert job (milestone 4).
 *
 * Rules (spec):
 * - Fire ONLY on Up↔Down transitions (no repeats) and on a site FIRST
 *   entering SSL warning/critical/invalid (milestone 7 wires that up).
 * - Deliver ONLY to the SITE OWNER's alert_email and webhook_url — never
 *   to anyone else, regardless of who triggered anything.
 * - Include site, status, status code/error, and downtime duration on
 *   recovery.
 * - Log every send attempt in alert_log (channel + ok).
 * - Webhooks are SSRF-validated like every other outbound request and use
 *   a Slack/Discord-compatible JSON body ({text, content}).
 * - Shares the invocation's subrequest budget; skips sends when exhausted.
 */
import { makeDb, nowIso, type Db } from '../db/client';
import { alertLog } from '../db/schema';
import { getAlertTargets } from '../db/repos/users';
import { sendEmail } from '../lib/email';
import { validatePublicUrl, MONITOR_UA } from '../lib/ssrf';
import type { SubrequestBudget } from './uptime';
import { makeBudget } from './uptime';
import type { Env } from '../env';

export type AlertKind = 'up-to-down' | 'down-to-up' | 'ssl-warning' | 'ssl-critical' | 'ssl-invalid';

export interface AlertSite {
  id: number;
  url: string;
  name: string;
  ownerId: number;
  statusChangedAt: string | null;
}

export interface AlertEvent {
  site: AlertSite;
  kind: AlertKind;
  /** Extra detail: status code / error / days left, etc. */
  detail?: string;
}

export interface AlertReport {
  sent: number;
  failed: number;
  skipped: number;
  logged: number;
}

function formatDowntime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function render(event: AlertEvent): { subject: string; html: string; text: string } {
  const { site, kind, detail } = event;
  const domain = (() => {
    try {
      return new URL(site.url).hostname;
    } catch {
      return site.url;
    }
  })();

  if (kind === 'up-to-down') {
    return {
      subject: `WPMonitor: ${site.name} is DOWN`,
      html:
        `<p><strong>${site.name}</strong> (${site.url}) is <strong>DOWN</strong>.</p>` +
        (detail ? `<p>Detail: ${detail}</p>` : '') +
        `<p>Detected at ${new Date().toUTCString()}.</p>` +
        `<p>You will get another email when it recovers.</p>`,
      text: `WPMonitor: ${site.name} (${domain}) is DOWN${detail ? ` (${detail})` : ''} as of ${new Date().toUTCString()}.`,
    };
  }
  if (kind === 'down-to-up') {
    const downtime = site.statusChangedAt ? formatDowntime(Date.now() - Date.parse(site.statusChangedAt)) : 'unknown';
    return {
      subject: `WPMonitor: ${site.name} is UP again`,
      html:
        `<p><strong>${site.name}</strong> (${site.url}) recovered and is <strong>UP</strong> again.</p>` +
        `<p>Downtime: <strong>${downtime}</strong>.</p>`,
      text: `WPMonitor: ${site.name} (${domain}) is UP again after ${downtime} of downtime.`,
    };
  }
  // SSL state alerts (fired on FIRST entry into the state — milestone 7).
  const label = kind === 'ssl-invalid' ? 'INVALID' : kind === 'ssl-critical' ? 'CRITICAL (≤7 days left)' : 'WARNING (≤21 days left)';
  return {
    subject: `WPMonitor: SSL ${kind.slice(4)} for ${site.name}`,
    html:
      `<p>SSL certificate for <strong>${site.name}</strong> (${site.url}) is <strong>${label}</strong>.</p>` +
      (detail ? `<p>Detail: ${detail}</p>` : ''),
    text: `WPMonitor: SSL ${label} for ${site.name} (${domain})${detail ? ` — ${detail}` : ''}.`,
  };
}

async function deliver(
  env: Env,
  db: Db,
  event: AlertEvent,
  budget: SubrequestBudget,
  report: AlertReport,
): Promise<void> {
  const targets = await getAlertTargets(db, [event.site.ownerId]);
  const target = targets.get(event.site.ownerId);
  if (!target) {
    report.skipped++;
    return;
  }
  const { subject, html, text } = render(event);
  const logs: Array<{ siteId: number; kind: string; sentAt: string; channel: string; ok: boolean }> = [];

  // 1) Email → owner's alert email (falls back to login email in the repo).
  if (budget.take()) {
    const r = await sendEmail(env, { to: target.alertEmail, subject, html });
    logs.push({ siteId: event.site.id, kind: event.kind, sentAt: nowIso(), channel: r.channel, ok: r.ok });
    r.ok ? report.sent++ : report.failed++;
  } else {
    report.skipped++;
  }

  // 2) Webhook → owner's webhook URL (SSRF-validated, Slack/Discord compatible).
  if (target.webhookUrl) {
    const v = validatePublicUrl(target.webhookUrl);
    if (!v.ok) {
      logs.push({ siteId: event.site.id, kind: event.kind, sentAt: nowIso(), channel: 'webhook', ok: false });
      report.failed++;
    } else if (budget.take()) {
      let ok = false;
      try {
        const res = await fetch(v.url.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'User-Agent': MONITOR_UA },
          body: JSON.stringify({ text, content: text }), // Slack uses text, Discord uses content
          signal: AbortSignal.timeout(8000),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      logs.push({ siteId: event.site.id, kind: event.kind, sentAt: nowIso(), channel: 'webhook', ok });
      ok ? report.sent++ : report.failed++;
    } else {
      report.skipped++;
    }
  }

  if (logs.length > 0) {
    await db.batch(logs.map((l) => db.insert(alertLog).values(l)) as unknown as Parameters<typeof db.batch>[0]);
    report.logged += logs.length;
  }
}

/** Send uptime-transition alerts (called right after the uptime job). */
export async function sendTransitionAlerts(
  env: Env,
  db: Db = makeDb(env),
  events: AlertEvent[],
  budget: SubrequestBudget = makeBudget(45),
): Promise<AlertReport> {
  const report: AlertReport = { sent: 0, failed: 0, skipped: 0, logged: 0 };
  for (const event of events) {
    await deliver(env, db, event, budget, report);
  }
  if (events.length > 0) {
    console.log(`[alerts] events=${events.length} sent=${report.sent} failed=${report.failed} skipped=${report.skipped} logged=${report.logged}`);
  }
  return report;
}
