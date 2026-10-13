/** Mint a dev session for a user in the LOCAL wrangler D1 (dev-testing helper). */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const email = process.argv[2];
if (!email) { console.error('usage: node scripts/dev-session.mjs <email>'); process.exit(1); }
const dir = new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url).pathname;
const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'));
const db = new DatabaseSync(dir + file);
const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (!u) { console.error('no such user'); process.exit(1); }
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const exp = new Date(Date.now() + 3600_000).toISOString();
db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)').run(u.id, hash, exp, new Date().toISOString());
console.log(token);
