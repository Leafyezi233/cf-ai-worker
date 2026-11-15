import { createRequire } from "node:module";
import { INIT_STATEMENTS, MIGRATION_ALTERS } from "../../src/db/schema";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface RealD1 {
  DB: any;
  sql: (statement: string, ...params: unknown[]) => void;
  rows: <T = Record<string, unknown>>(statement: string, ...params: unknown[]) => T[];
  row: <T = Record<string, unknown>>(statement: string, ...params: unknown[]) => T | null;
  close: () => void;
}

export interface RealD1Options {
  init?: string[];
  alters?: string[];
}

export function createRealD1(options: RealD1Options = {}): RealD1 {
  const db = new DatabaseSync(":memory:");

  for (const statement of options.init ?? INIT_STATEMENTS) db.exec(statement);
  for (const statement of options.alters ?? MIGRATION_ALTERS) {
    try {
      db.exec(statement);
    } catch {
    }
  }

  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    let binds: unknown[] = [];
    const self = {
      sql,
      bind: (...args: unknown[]) => {
        binds = args;
        return self;
      },
      first: async () => {
        const got = statement.get(...(binds as never[]));
        return got ?? null;
      },
      all: async () => ({ results: statement.all(...(binds as never[])) }),
      run: async () => {
        const info = statement.run(...(binds as never[]));
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return self;
  };

  let batchQueue: Promise<unknown> = Promise.resolve();
  return {
    DB: {
      prepare,
      batch: (statements: { sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> }[]) => {
        const pending = batchQueue.then(async () => {
          db.exec("BEGIN");
          try {
            const out: unknown[] = [];
            for (const statement of statements) out.push(await (/^\s*(SELECT|PRAGMA)\b/i.test(statement.sql) ? statement.all() : statement.run()));
            db.exec("COMMIT");
            return out;
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        });
        batchQueue = pending.catch(() => undefined);
        return pending;
      },
    },
    sql: (statement, ...params) => {
      db.prepare(statement).run(...(params as never[]));
    },
    rows: (statement, ...params) => db.prepare(statement).all(...(params as never[])) as never,
    row: (statement, ...params) => (db.prepare(statement).get(...(params as never[])) ?? null) as never,
    close: () => db.close(),
  };
}
