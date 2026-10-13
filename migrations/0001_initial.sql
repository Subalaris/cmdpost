-- WPMonitor initial schema (applied with: npm run db:init  /  npx wrangler d1 execute wpmonitor --local --file=migrations/0001_initial.sql)
-- Timestamps are ISO-8601 UTC strings (lexicographically sortable).
-- Booleans are stored as INTEGER 0/1 (Drizzle mode: 'boolean').

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'disabled')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  alert_email TEXT,
  webhook_url TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

CREATE TABLE blocked_domains (
  domain TEXT PRIMARY KEY
);

CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  verification_token TEXT,
  verified_at TEXT,
  verification_method TEXT CHECK (verification_method IN ('dns', 'meta', 'file')),
  current_status TEXT NOT NULL DEFAULT 'unknown' CHECK (current_status IN ('up', 'down', 'unknown')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_response_ms INTEGER,
  status_changed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, url)
);
CREATE INDEX idx_sites_owner ON sites(owner_id);
CREATE INDEX idx_sites_status ON sites(current_status);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  response_ms INTEGER,
  error TEXT
);
CREATE INDEX idx_checks_site_time ON checks(site_id, checked_at);
CREATE INDEX idx_checks_time ON checks(checked_at);

CREATE TABLE daily_stats (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  uptime_pct INTEGER,
  avg_response_ms INTEGER,
  checks_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, date)
);
CREATE INDEX idx_daily_stats_date ON daily_stats(date);

CREATE TABLE pagespeed_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  performance_score INTEGER,
  strategy TEXT NOT NULL DEFAULT 'mobile'
);
CREATE INDEX idx_pagespeed_site_time ON pagespeed_results(site_id, checked_at);

CREATE TABLE ssl_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  valid_to TEXT,
  days_left INTEGER,
  issuer TEXT,
  state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'warning', 'critical', 'invalid'))
);
CREATE INDEX idx_ssl_site_time ON ssl_status(site_id, checked_at);

CREATE TABLE wp_fingerprints (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  scanned_at TEXT NOT NULL,
  wp_version TEXT,
  wp_version_source TEXT CHECK (wp_version_source IN ('meta', 'feed', 'readme')),
  wp_latest TEXT,
  core_outdated INTEGER NOT NULL DEFAULT 0,
  wp_detected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id)
);

CREATE TABLE site_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('plugin', 'theme')),
  slug TEXT NOT NULL,
  detected_version TEXT,
  version_source TEXT CHECK (version_source IN ('asset_ver', 'readme', 'style_css')),
  latest_version TEXT,
  outdated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'version_hidden' CHECK (status IN ('checked', 'premium_unknown', 'version_hidden')),
  UNIQUE (site_id, type, slug)
);

CREATE TABLE alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE wp_org_cache (
  type TEXT NOT NULL CHECK (type IN ('plugin', 'theme', 'core')),
  slug TEXT NOT NULL,
  latest_version TEXT,
  not_found INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (type, slug)
);
