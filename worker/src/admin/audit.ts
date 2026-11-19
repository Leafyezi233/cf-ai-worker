import { Hono } from "hono";
import type { Env, AuditLogRow } from "../types";
import { ensureSchema } from "../db/schema";
import { sanitizeCsvCell } from "../utils/csv";

export const auditApp = new Hono<{ Bindings: Env }>();
auditApp.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

function auditConditions(query: Record<string, string>, exporting: boolean) {
  const integer = (key: string, fallback: number, max: number) => {
    if (query[key] === undefined) return fallback;
    if (!/^\d+$/.test(query[key]) || !Number.isSafeInteger(Number(query[key])) || Number(query[key]) > max)
      throw new Error("invalid_audit_filters");
    return Number(query[key]);
  };
  const limit = integer("limit", exporting ? 500 : 50, exporting ? 1000 : 200);
  const offset = integer("offset", 0, 10000);
  const from = integer("from", 0, 8640000000000000);
  const to = integer("to", 8640000000000000, 8640000000000000);
  if (limit < 1 || from > to || (query.cursor && offset)) throw new Error("invalid_audit_filters");
  if ((query.from !== undefined || query.to !== undefined) &&
      (query.from === undefined || query.to === undefined || to - from > 31 * 86400000))
    throw new Error("invalid_audit_filters");
  const conditions = ["created_at >= ?", "created_at <= ?"];
  const binds: (string | number)[] = [from, to];
  const exact = ["action", "actor_type", "target_type", "target_id", "ip"] as const;
  for (const key of exact) {
    const value = query[key];
    if (!value) continue;
    if (value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid_audit_filters");
    conditions.push(key + " = ?"); binds.push(value);
  }
  const signature = JSON.stringify([from, to, ...exact.map(key => query[key] || "")]);
  if (query.cursor) {
    try {
      if (query.cursor.length > 4096) throw new Error();
      const cursor: unknown = JSON.parse(decodeURIComponent(query.cursor));
      if (!Array.isArray(cursor) || cursor.length !== 3 || !Number.isSafeInteger(cursor[0]) || cursor[0] < from || cursor[0] > to ||
          !Number.isSafeInteger(cursor[1]) || cursor[1] < 1 || cursor[2] !== signature) throw new Error();
      binds[1] = Math.min(to, cursor[0]);  
      conditions.push("(created_at, id) < (?, ?)"); binds.push(cursor[0], cursor[1]);
    } catch { throw new Error("invalid_audit_filters"); }
  }
  return { limit, offset, signature, binds, where: "WHERE " + conditions.join(" AND ") };
}

async function readAuditPage(env: Env, filters: ReturnType<typeof auditConditions>) {
  await ensureSchema(env);
  const rows = await env.DB.prepare("SELECT id, actor_type, ip, action, target_type, target_id, summary, details_json, created_at " +
    "FROM audit_logs " + filters.where + " ORDER BY created_at DESC, id DESC LIMIT ?" + (filters.offset ? " OFFSET ?" : ""))
    .bind(...filters.binds, filters.limit + 1, ...(filters.offset ? [filters.offset] : [])).all<AuditLogRow>();
  const all = rows.results || [];
  const items = all.slice(0, filters.limit);
  const hasMore = all.length > filters.limit;
  const last = items.at(-1);
  return { items, has_more: hasMore, next_cursor: hasMore && last
    ? encodeURIComponent(JSON.stringify([last.created_at, last.id, filters.signature])) : null, limit: filters.limit };
}

auditApp.get("/", async c => {
  let filters: ReturnType<typeof auditConditions>;
  try { filters = auditConditions(c.req.query(), false); }
  catch { return c.json({ error: "invalid_audit_filters" }, 400); }
  return c.json(await readAuditPage(c.env, filters));
});

auditApp.get("/export", async c => {
  let filters: ReturnType<typeof auditConditions>;
  try { filters = auditConditions(c.req.query(), true); }
  catch { return c.json({ error: "invalid_audit_filters" }, 400); }
  const res = await readAuditPage(c.env, filters);
  const header = "\uFEFF操作时间,操作人类型,客户端 IP,动作,对象类型,对象 ID,摘要描述,变更详情\n";
  const rows = res.items.map((item) => {
    const timeStr = new Date(item.created_at).toISOString().replace("T", " ").slice(0, 19);
    const escapeCsv = (str: string | null | undefined) =>
      `"${sanitizeCsvCell(str).replace(/"/g, '""')}"`;
    return [
      escapeCsv(timeStr),
      escapeCsv(item.actor_type),
      escapeCsv(item.ip || "-"),
      escapeCsv(item.action),
      escapeCsv(item.target_type),
      escapeCsv(item.target_id || "-"),
      escapeCsv(item.summary),
      escapeCsv(item.details_json || "-"),
    ].join(",");
  });

  const csv = header + rows.join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Export-Truncated": String(res.has_more),
      "X-Export-Limit": String(filters.limit),
      "Content-Disposition": `attachment; filename="audit-logs-${Date.now()}.csv"`,
    },
  });
});