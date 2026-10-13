/**
 * Seed two test users with sites (milestone-2 dashboard demo).
 * Run from the project root: node scripts/seed.mjs
 * Targets the LOCAL wrangler dev D1 file (idempotent).
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';

const dir = new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url).pathname;
const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'));
if (!file) {
  console.error('Local D1 file not found. Start `npx wrangler dev` once, then re-run.');
  process.exit(1);
}
const db = new DatabaseSync(dir + file);
db.exec('PRAGMA foreign_keys = ON;');

const now = new Date().toISOString();

function upsertUser(email, isAdmin = 0) {
  db.prepare('INSERT OR IGNORE INTO users (email, name, status, is_admin, alert_email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, email.split('@')[0], 'approved', isAdmin, email, now);
  return db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
}

function addSite(ownerId, url, name, verified) {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  db.prepare(
    `INSERT OR IGNORE INTO sites
       (owner_id, url, name, active, verification_token, verified_at, verification_method, current_status, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    ownerId, url, name, token,
    verified ? now : null, verified ? 'meta' : null,
    verified ? 'up' : 'unknown', now,
  );
}

const alice = upsertUser('alice@example.com');
const bob = upsertUser('bob@example.com');
upsertUser('admin@example.com', 1);

// Alice: 3 sites (2 verified, 1 unverified)
addSite(alice, 'https://alice-blog.example.com', 'Alice Blog', true);
addSite(alice, 'https://alice-shop.example.com', 'Alice Shop', true);
addSite(alice, 'https://alice-unverified.example.com', 'Alice Unverified', false);
// Bob: 2 sites (1 verified, 1 unverified)
addSite(bob, 'https://bob-portfolio.example.com', 'Bob Portfolio', true);
addSite(bob, 'https://bob-news.example.com', 'Bob News', false);

const counts = db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sites) AS sites').get();
console.log(`seeded: users=${counts.users} sites=${counts.sites}`);
console.log('log in as alice@example.com / bob@example.com / admin@example.com (magic link prints to the dev console)');
