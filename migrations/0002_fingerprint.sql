-- Milestone 6: fingerprint scheduling column on sites.
ALTER TABLE sites ADD COLUMN last_scanned_at TEXT;

CREATE INDEX idx_sites_last_scanned ON sites (last_scanned_at);
