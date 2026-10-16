import { D1DatabaseStub } from './d1';
import { eq } from 'drizzle-orm';
import { makeDb, nowIso } from '../../src/db/client';
import { users } from '../../src/db/schema';

export function applySchema(db: D1DatabaseStub): void {
  db.exec('PRAGMA foreign_keys = ON;');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x: string) => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
}
export interface TestEnv {
  DB: D1Database;
  [key: string]: unknown;
}

export function makeTestEnv(overrides: Record<string, unknown> = {}): TestEnv {
  const stub = new D1DatabaseStub();
  applySchema(stub);
  return {
    DB: stub as unknown as D1Database,
    SIGNUP_MODE: 'approval',
    ADMIN_EMAIL: 'admin@example.com',
    MAX_USERS: '50',
    MAX_SITES_PER_USER: '5',
    MAX_SITES_TOTAL: '150',
    DEV_MODE: 'true',
    ...overrides,
  };
}

/** Create a user row directly (bypasses the signup flow). Returns user id. */
export async function seedUser(
  env: TestEnv,
  opts: { email: string; status?: 'pending' | 'approved' | 'disabled'; isAdmin?: boolean; name?: string },
): Promise<number> {
  const email = opts.email;
  const status = opts.status ?? 'approved';
  const res = await env.DB.prepare(
    'INSERT INTO users (email, name, status, is_admin, alert_email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(email, opts.name ?? email.split('@')[0], status, opts.isAdmin ? 1 : 0, email, nowIso())
    .run();
  return res.meta.last_row_id;
}

export async function getUserById(env: TestEnv, id: number) {
  const db = makeDb(env as never);
  return await db.select().from(users).where(eq(users.id, id)).get();
}
