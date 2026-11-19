import type { Env } from "../types";

export class AccessBudgetExceeded extends Error {
  constructor() { super("Account diagnostic D1 budget exhausted"); }
}

/** Request-local only. Counts D1 executions (batch counts once), not prepares. */
export function accessBudgetEnv(env: Env, limit: number) {
  let used = 0;
  let failed: unknown;
  const memo = new Map<string, Promise<unknown>>();
  const inflight = new Set<Promise<unknown>>();
  const originals = new WeakMap<object, D1PreparedStatement>();
  const selectKeys = new WeakMap<object, string>();
  const execute = (key: string | null, action: () => Promise<unknown>): Promise<unknown> => {
    if (failed) return Promise.reject(failed);
    if (key && memo.has(key)) return memo.get(key)!;
    if (used >= limit) { failed = new AccessBudgetExceeded(); return Promise.reject(failed); }
    used++;
    const pending = Promise.resolve().then(action).then(value => {
      const results = Array.isArray(value) ? value : [value];
      if (results.some(r => r && typeof r === "object" && (r.success === false || r.error))) throw new Error("Account diagnostic D1 execution failed");
      return value;
    }).catch(error => { failed = error; throw error; });
    inflight.add(pending);
    void pending.then(() => inflight.delete(pending), () => inflight.delete(pending));
    if (key) memo.set(key, pending);
    else memo.clear();
    return pending;
  };
  const wrap = (sql: string, statement: D1PreparedStatement, params: unknown[]): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, prop) {
      if (prop === "bind") return (...values: unknown[]) => wrap(sql, target.bind(...values), values);
      if (["first", "all", "run", "raw"].includes(String(prop))) return (...args: unknown[]) => {
        const key = /^\s*SELECT\b/i.test(sql) ? JSON.stringify([sql, params, prop, args]) : null;
        return execute(key, () => Reflect.apply(Reflect.get(target, prop), target, args));
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement);
    if (/^\s*SELECT\b/i.test(sql)) selectKeys.set(proxy, JSON.stringify([sql, params]));
    return proxy;
  };
  const DB = new Proxy(env.DB, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => wrap(sql, target.prepare(sql), []);
    if (prop === "batch") return (statements: D1PreparedStatement[]) => {
      const keys = statements.map(s => selectKeys.get(s));
      const key = keys.every(k => k !== undefined) ? JSON.stringify(["batch", keys]) : null;
      return execute(key, () => target.batch(statements.map(s => originals.get(s) ?? s)));
    };
    if (prop === "exec") return (sql: string) => execute(null, () => target.exec(sql));
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...env, DB }, used: () => used, assertHealthy: () => { if (failed) throw failed; },
    settle: async () => {
      await Promise.allSettled([...inflight]);
      if (failed && !(failed instanceof AccessBudgetExceeded)) throw failed;
    },
  };
}
