/**
 * In-memory D1 database stub for vitest (node:sqlite under the hood).
 *
 * Implements the D1Database surface used by drizzle-orm/d1 and our repos/tests:
 *   prepare(sql) → Statement { bind(...).run() | .first() | .all() | .raw() }
 *   batch(statements[])
 *
 * Contract verified against drizzle-orm's D1 session (node_modules source):
 *  - run() → { success: true, meta: { changes, last_row_id } }
 *  - all() → { results: Row[], meta }        (drizzle: .all().then(({results}) => …))
 *  - raw() → Row[][] (array of value arrays, positional)
 *  - drizzle calls .then() on all()/raw()/run() results → we attach a then
 *    so the same objects also work when accessed synchronously (in tests).
 *  - drizzle fills `$name`-style placeholders positionally; we rewrite them to
 *    `?` in order of first appearance and re-order object params to match.
 *  - node:sqlite's run() returns `lastInsertRowid` (lowercase d) — D1 calls
 *    it `last_row_id`; we normalize.
 */
import { DatabaseSync } from 'node:sqlite';

export interface D1Meta {
  changes: number;
  last_row_id: number;
  size_after: number;
}

type Thenable<T> = T & {
  then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => unknown;
};

/**
 * drizzle's D1 session both `await`s statement results AND calls `.then()`
 * on them (e.g. `stmt.all().then(({results}) => …)`), so results must be
 * thenables. CRITICAL: the `.then` handler must hand the resolver a copy
 * WITHOUT the `.then` property — otherwise `resolve(copiedThenable)` re-
 * adopts the same object and loops forever (the hang we hit).
 */
function asThenable<T extends object>(obj: T): Thenable<T> {
  if (typeof (obj as { then?: unknown }).then === 'function') return obj as Thenable<T>;
  Object.defineProperty(obj, 'then', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
      const plain: unknown = Array.isArray(obj) ? [...obj] : Object.assign({}, obj);
      let result: unknown;
      try {
        result = onF ? onF(plain) : plain;
      } catch (err) {
        return onR ? Promise.resolve(onR(err)) : Promise.reject(err);
      }
      const p: Promise<unknown> = Promise.resolve(result);
      return onR ? p.catch(onR) : p;
    },
  });
  return obj as Thenable<T>;
}

export interface D1Statement {
  bind(...params: unknown[]): D1Statement;
  run(): Thenable<{ success: true; meta: D1Meta }>;
  first<T = unknown>(): T | undefined;
  all<T = unknown>(): Thenable<{ results: T[]; meta: D1Meta }>;
  raw<T = unknown>(): Thenable<T[]>;
}

export class D1DatabaseStub {
  private db: DatabaseSync;

  constructor(databaseFile = ':memory:') {
    this.db = new DatabaseSync(databaseFile, { readOnly: false });
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  /** Execute raw SQL (multi-statement OK) — used to apply migrations. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): D1Statement {
    const { sql: stmtSql, order } = rewriteNamedPlaceholders(sql);
    const stmt = this.db.prepare(stmtSql);

    function normalize(v: unknown): unknown {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    }
    function resolveParams(params: unknown[]): unknown[] {
      let values = params;
      if (
        values.length === 1 &&
        values[0] !== null &&
        typeof values[0] === 'object' &&
        !Array.isArray(values[0])
      ) {
        const obj = values[0] as Record<string, unknown>;
        values = order.map((name) => obj[name] ?? obj[`$${name}`] ?? null);
      }
      return values.map(normalize);
    }

    let params: unknown[] = [];
    let bound = false;

    const api: D1Statement = {
      bind(...values: unknown[]) {
        params = resolveParams(values);
        bound = true;
        return api;
      },
      run() {
        const res = (
          stmt as unknown as {
            run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
          }
        ).run(...(bound ? params : []));
        const meta: D1Meta = {
          changes: res.changes,
          last_row_id: Number(res.lastInsertRowid),
          size_after: -1,
        };
        return asThenable({ success: true, meta });
      },
      first<T>() {
        const row = (stmt as unknown as { get: (...p: unknown[]) => T | undefined }).get(
          ...(bound ? params : []),
        );
        return row === undefined ? undefined : (row as T);
      },
      all<T>() {
        const rows = (stmt as unknown as { all: (...p: unknown[]) => unknown[] }).all(
          ...(bound ? params : []),
        ) as T[];
        return asThenable({
          results: rows,
          meta: { changes: rows.length, last_row_id: 0, size_after: -1 },
        });
      },
      raw<T>() {
        const rows = (stmt as unknown as { all: (...p: unknown[]) => unknown[] }).all(
          ...(bound ? params : []),
        );
        return asThenable((rows as unknown[][]).map((r) => Object.values(r)) as unknown as T[]);
      },
    };
    return api;
  }

  batch(statements: D1Statement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const s of statements) {
      // All of our batched statements are inserts/updates/deletes (no RETURNING
      // reads), so run() is the correct path. Drizzle's batch mapper reads
      // `result.results` for mapped queries — provide it so either path works.
      const plain = s.run() as { success: boolean; meta: D1Meta };
      results.push({ ...plain, results: [] });
    }
    return Promise.resolve(results);
  }

  close(): void {
    this.db.close();
  }

  // D1Database interface completeness (not used by our code paths):
  withSession<T>(_name: string, fn: (db: D1DatabaseStub) => T): T {
    return fn(this);
  }
  async dump(_format?: string): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

function rewriteNamedPlaceholders(sql: string): { sql: string; order: string[] } {
  const order: string[] = [];
  let out = '';
  let inString: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === inString && sql[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === '$' && /[A-Za-z0-9_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (!order.includes(name)) order.push(name);
      out += '?';
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return { sql: out, order };
}
