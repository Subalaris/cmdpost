import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../env';
import * as schema from './schema';

/** Build a Drizzle instance bound to the D1 database. */
export function makeDb(env: Env) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof makeDb>;

/** Timestamps stored as ISO-8601 UTC strings so they sort lexicographically. */
export function nowIso(d = new Date()): string {
  return d.toISOString();
}
