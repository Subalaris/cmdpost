import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

/**
 * WPMonitor schema. Source of truth for structure is migrations/*.sql;
 * this file must stay in sync with it.
 */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'disabled'] }).notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  alertEmail: text('alert_email'),
  webhookUrl: text('webhook_url'),
  createdAt: text('created_at').notNull(),
  lastLoginAt: text('last_login_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ idx: index('idx_sessions_user').on(t.userId) }),
);

export const loginTokens = sqliteTable(
  'login_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (t) => ({ idx: index('idx_login_tokens_email').on(t.email) }),
);

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    windowStart: text('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => ({ idx: index('idx_rate_limits_window').on(t.windowStart) }),
);

export const blockedDomains = sqliteTable('blocked_domains', {
  domain: text('domain').primaryKey(),
});

export const sites = sqliteTable(
  'sites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    name: text('name').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    verificationToken: text('verification_token'),
    verifiedAt: text('verified_at'),
    verificationMethod: text('verification_method', { enum: ['dns', 'meta', 'file'] }),
    currentStatus: text('current_status', { enum: ['up', 'down', 'unknown'] })
      .notNull()
      .default('unknown'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastCheckedAt: text('last_checked_at'),
    lastResponseMs: integer('last_response_ms'),
    statusChangedAt: text('status_changed_at'),
    lastScannedAt: text('last_scanned_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ uq: uniqueIndex('uq_sites_owner_url').on(t.ownerId, t.url), ownerIdx: index('idx_sites_owner').on(t.ownerId), statusIdx: index('idx_sites_status').on(t.currentStatus) }),
);

export const checks = sqliteTable(
  'checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    checkedAt: text('checked_at').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    statusCode: integer('status_code'),
    responseMs: integer('response_ms'),
    error: text('error'),
  },
  (t) => ({ siteTime: index('idx_checks_site_time').on(t.siteId, t.checkedAt), timeIdx: index('idx_checks_time').on(t.checkedAt) }),
);

export const dailyStats = sqliteTable(
  'daily_stats',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    // SQLite REAL is fine for uptime_pct; D1 returns JS numbers either way.
    uptimePct: integer('uptime_pct'),
    avgResponseMs: integer('avg_response_ms'),
    checksCount: integer('checks_count').notNull().default(0),
  },
  (t) => ({ uq: uniqueIndex('uq_daily_stats').on(t.siteId, t.date), dateIdx: index('idx_daily_stats_date').on(t.date) }),
);

export const pagespeedResults = sqliteTable(
  'pagespeed_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    checkedAt: text('checked_at').notNull(),
    performanceScore: integer('performance_score'),
    strategy: text('strategy').notNull().default('mobile'),
  },
  (t) => ({ idx: index('idx_pagespeed_site_time').on(t.siteId, t.checkedAt) }),
);

export const sslStatus = sqliteTable(
  'ssl_status',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    checkedAt: text('checked_at').notNull(),
    validTo: text('valid_to'),
    daysLeft: integer('days_left'),
    issuer: text('issuer'),
    state: text('state', { enum: ['ok', 'warning', 'critical', 'invalid'] }).notNull().default('ok'),
  },
  (t) => ({ idx: index('idx_ssl_site_time').on(t.siteId, t.checkedAt) }),
);

export const wpFingerprints = sqliteTable(
  'wp_fingerprints',
  {
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    scannedAt: text('scanned_at').notNull(),
    wpVersion: text('wp_version'),
    wpVersionSource: text('wp_version_source', { enum: ['meta', 'feed', 'readme'] }),
    wpLatest: text('wp_latest'),
    coreOutdated: integer('core_outdated', { mode: 'boolean' }).notNull().default(false),
    wpDetected: integer('wp_detected', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({ uq: uniqueIndex('uq_fingerprints_site').on(t.siteId) }),
);

export const siteComponents = sqliteTable(
  'site_components',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: integer('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['plugin', 'theme'] }).notNull(),
    slug: text('slug').notNull(),
    detectedVersion: text('detected_version'),
    versionSource: text('version_source', { enum: ['asset_ver', 'readme', 'style_css'] }),
    latestVersion: text('latest_version'),
    outdated: integer('outdated', { mode: 'boolean' }).notNull().default(false),
    status: text('status', {
      enum: ['checked', 'premium_unknown', 'version_hidden'],
    }).notNull().default('version_hidden'),
  },
  (t) => ({ uq: uniqueIndex('uq_components_site_type_slug').on(t.siteId, t.type, t.slug) }),
);

export const alertLog = sqliteTable('alert_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  sentAt: text('sent_at').notNull(),
  channel: text('channel').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull().default(false),
});

export const wpOrgCache = sqliteTable('wp_org_cache', {
  type: text('type', { enum: ['plugin', 'theme', 'core'] }).notNull(),
  slug: text('slug').notNull(),
  latestVersion: text('latest_version'),
  notFound: integer('not_found', { mode: 'boolean' }).notNull().default(false),
  fetchedAt: text('fetched_at').notNull(),
});
