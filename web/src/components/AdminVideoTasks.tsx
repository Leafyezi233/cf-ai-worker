import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtTime } from "../api/client";
import { useAdminFilters } from "../hooks/useAdminFilters";
import { Button, Card, Empty, Input, Select } from "./ui";

export function recordTimeDefaults(prefix: string, now = Date.now()) {
  const local = (ms: number) => {
    const date = new Date(ms);
    return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  return { [prefix + "from"]: local(now - 30 * 86400000), [prefix + "to"]: local(now) };
}

export function recordQuery(filters: Record<string, string>, prefix: string, fields: readonly string[]) {
  const params = new URLSearchParams();
  for (const field of fields) {
    const value = filters[prefix + field]?.trim();
    if (!value) continue;
    if (value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("筛选值无效");
    params.set(field, value);
  }
  const from = new Date(filters[prefix + "from"]).getTime();
  const to = new Date(filters[prefix + "to"]).getTime();
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to || to > 8640000000000000)
    throw new Error("请选择有效的起止时间");
  if (to - from > 31 * 86400000) throw new Error("单次查询最多 31 天，请缩小时间范围");
  params.set("from", String(from)); params.set("to", String(to));
  return params.toString();
}

export const ADMIN_RECORD_VISIBLE_LIMIT = 1000;

export function useAdminRecordPage<T extends { id: string | number }>(path: string, query: string, validationError = "") {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const sequence = useRef(0);
  const activeQuery = useRef(query); activeQuery.current = query;
  const retryCursor = useRef<string | null>(null);
  const visibleItems = useRef<T[]>([]);
  const load = useCallback(async (next: string | null = null) => {
    if (next && visibleItems.current.length >= ADMIN_RECORD_VISIBLE_LIMIT) return;
    const generation = ++sequence.current;
    retryCursor.current = next;
    if (validationError) { setError(validationError); setCursor(null); setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const remaining = next ? ADMIN_RECORD_VISIBLE_LIMIT - visibleItems.current.length : ADMIN_RECORD_VISIBLE_LIMIT;
      const params = new URLSearchParams(query); params.set("limit", String(Math.min(30, remaining)));
      if (next) params.set("cursor", next);
      const page = await api.get<{ items: T[]; next_cursor: string | null; has_more: boolean }>(path + "?" + params);
      if (sequence.current !== generation || activeQuery.current !== query) return;
      const previous = next ? visibleItems.current : [];
      const seen = new Set(previous.map(row => row.id));
      const merged = [...previous, ...page.items.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; })].slice(0, ADMIN_RECORD_VISIBLE_LIMIT);
      visibleItems.current = merged;
      setItems(merged);
      setCursor(page.has_more ? page.next_cursor : null); setLoadedQuery(query);
    } catch (err) {
      if (sequence.current === generation && activeQuery.current === query) setError(err instanceof Error ? err.message : "加载失败");
    } finally { if (sequence.current === generation) setLoading(false); }
  }, [path, query, validationError]);
  useEffect(() => { setCursor(null); void load(); return () => { ++sequence.current; }; }, [load]);
  return { items, cursor, loading, error, capped: items.length >= ADMIN_RECORD_VISIBLE_LIMIT && !!cursor, stale: items.length > 0 && loadedQuery !== query,
    refresh: () => load(), more: () => load(cursor), retry: () => load(retryCursor.current) };
}

interface TaskRow {
  id: string; device_id: string; status: string; model?: string; error_code?: string;
  created_at: number; updated_at: number;
}
const statuses = ["review", "all", "submitting", "submission_unknown", "pending", "succeeded", "failed"];
export default function AdminVideoTasks() {
  const [defaults] = useState(() => ({ task_status: "review", task_device_id: "", task_task_id: "", ...recordTimeDefaults("task_") }));
  const [filters, setFilter, resetFilters] = useAdminFilters(defaults);
  const [draft, setDraft] = useState(filters);
  const filterKey = JSON.stringify(filters);
  useEffect(() => setDraft(JSON.parse(filterKey)), [filterKey]);
  let query = "", invalid = "";
  try {
    if (!statuses.includes(filters.task_status) || [filters.task_device_id, filters.task_task_id].some(value => /[\x00-\x20\x7f]/.test(value)))
      throw new Error("任务筛选值无效");
    query = recordQuery(filters, "task_", ["status", "device_id", "task_id"]);
  } catch (err) { invalid = (err as Error).message; }
  const page = useAdminRecordPage<TaskRow>("/api/video-tasks", query, invalid);
  return <Card title="任务列表">
    <p className="text-xs text-slate-500 mb-3">默认显示最近 30 天内待核对的任务。</p>
    <form className="grid gap-2 sm:grid-cols-3" onSubmit={event => {
      event.preventDefault();
      for (const key of Object.keys(defaults)) setFilter(key, draft[key]);
      if (Object.keys(defaults).every(key => filters[key] === draft[key])) void page.refresh();
    }}>
      <label>状态<Select aria-label="任务状态" value={draft.task_status} onChange={e => setDraft({ ...draft, task_status: e.target.value })}>
        {statuses.map(status => <option key={status} value={status}>{status === "review" ? "待复核 (pending / submission_unknown)" : status}</option>)}
      </Select></label>
      {[["device_id", "账户 ID"], ["task_id", "任务 ID"], ["from", "任务开始时间"], ["to", "任务结束时间"]].map(([field, label]) => <label key={field}>{label}
        <Input aria-label={label} type={field === "from" || field === "to" ? "datetime-local" : "text"} maxLength={256}
          value={draft["task_" + field]} onChange={e => setDraft({ ...draft, ["task_" + field]: e.target.value })} />
      </label>)}
      <div className="flex flex-wrap items-end gap-2"><Button type="button" variant="ghost" onClick={() => { setDraft(defaults); resetFilters(); }}>清空任务筛选</Button><Button type="submit">查询任务</Button><Button type="button" variant="outline" disabled={page.loading} onClick={() => void page.refresh()}>手动刷新</Button></div>
    </form>
    {page.error && <div role="alert">{page.error}（保留上次成功结果） <Button type="button" onClick={() => void page.retry()} disabled={page.loading}>重试</Button></div>}
    {page.loading && <p role="status">正在加载任务…</p>}
    {page.stale && <p role="status">下方为旧筛选结果，等待新查询成功。</p>}
    {page.items.length ? <div className="overflow-x-auto mt-3"><table className="w-full text-xs"><thead><tr>{["任务", "账户", "状态", "模型", "创建时间", "更新时间", "错误码"].map(title => <th key={title}>{title}</th>)}</tr></thead>
      <tbody>{page.items.map(task => <tr key={task.id}><td>{task.id}</td><td>{task.device_id}</td><td>{task.status}</td><td>{task.model || "-"}</td><td>{fmtTime(task.created_at)}</td><td>{fmtTime(task.updated_at)}</td><td>{task.error_code || "-"}</td></tr>)}</tbody></table></div>
      : !page.loading && !page.error && <Empty text="没有匹配的视频任务" />}
    {page.capped && !page.stale && <p role="status">已展示 1000 条任务。为控制页面开销，请缩小时间或筛选范围；这不是全部匹配记录。</p>}
    {page.cursor && !page.capped && !page.stale && <Button type="button" disabled={page.loading || !!page.error} onClick={() => void page.more()}>加载更多任务</Button>}
  </Card>;
}
