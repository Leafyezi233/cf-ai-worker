import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { usageApp, parseUsageQuery } from "../src/admin/usage";
import { listUsage } from "../src/db/repo";
import { ensureSchema } from "../src/db/schema";
import type { Env } from "../src/types";
import { createRealD1, type RealD1 } from "./helpers/realD1";

const open: RealD1[] = [];
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
afterEach(() => { vi.restoreAllMocks(); open.splice(0).forEach(db => db.close()); });
async function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const d1 = createRealD1(); open.push(d1);
  const seen: { sql: string; binds: unknown[] }[] = [];
  const DB = { ...d1.DB, prepare(sql: string) {
    const statement = d1.DB.prepare(sql);
    const bind = statement.bind;
    statement.bind = (...binds: unknown[]) => { seen.push({ sql, binds }); return bind(...binds); };
    return statement;
  } };
  const env = { DB } as Env;
  await ensureSchema(env); seen.length = 0;
  const seed = (over: Record<string, unknown> = {}) => {
    const row = { created_at: NOW - 100, provider_id: "p", model: "exact", device_id: "d", status_code: 200, service_group_id: "sg", request_id: "req", ...over };
    const keys = Object.keys(row);
    d1.sql("INSERT INTO usage (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")", ...Object.values(row));
  };
  const get = (q = "") => usageApp.request("http://test/?" + q, {}, env);
  const csv = (q = "") => usageApp.request("http://test/export?" + q, {}, env);
  return { d1, env, seed, seen, get, csv };
}

describe("phase3 usage exact bounded filters and seek SQL", () => {
  it("bounds legacy no-range calls and exposes a reusable from/to snapshot", async () => {
    const { get, seed } = await fixture(); seed(); seed({ created_at: NOW - 2 * DAY });
    const body = await (await get()).json() as any;
    expect(body).toMatchObject({ from: NOW - DAY, to: NOW, has_more: false, next_cursor: null });
    expect(body.items).toHaveLength(1);
  });
  it.each(["from=no", "from=-1", "limit=-2", "offset=1.2", "from=0&to=" + NOW, "from=20&to=10", "status=oops", "cursor=not-json"])("rejects invalid/broad conditions in BOTH endpoints: %s", async q => {
    const { get, csv, seen } = await fixture();
    expect((await get(q)).status).toBe(400); expect((await csv(q)).status).toBe(400);
    expect(seen.filter(s => /SELECT \* FROM usage/.test(s.sql))).toHaveLength(0);
  });
  it("shares exact provider/model/device/status/request/group conditions with CSV", async () => {
    const { seed, get, csv } = await fixture();
    seed({ status_code: 500 });
    for (const change of [{ provider_id: "other" }, { model: "exact-more" }, { device_id: "other" }, { status_code: 200 }, { request_id: "other" }, { service_group_id: "other" }]) seed({ status_code: 500, ...change });
    const q = "provider_id=p&model=exact&device_id=d&status=error&request_id=req&service_group_id=sg&from=" + (NOW - DAY) + "&to=" + NOW;
    const body = await (await get(q)).json() as any;
    expect(body.items).toHaveLength(1);
    const text = await (await csv(q)).text();
    expect(text.trim().split("\r\n")).toHaveLength(2);
    expect(text).toContain("500");
  });
  it("keeps timestamp ties stable across concurrent inserts and avoids COUNT", async () => {
    const { seed, get, seen, d1 } = await fixture();
    for (let i = 0; i < 5; i++) seed();
    const first = await (await get("limit=2")).json() as any;
    expect(first.items.map((r: any) => r.id)).toEqual([5, 4]);
    seed();  
    const second = await (await get("limit=2&cursor=" + encodeURIComponent(first.next_cursor))).json() as any;
    expect(second.items.map((r: any) => r.id)).toEqual([3, 2]);
    const third = await (await get("limit=2&cursor=" + encodeURIComponent(second.next_cursor))).json() as any;
    expect(third.items.map((r: any) => r.id)).toEqual([1]); expect(third.has_more).toBe(false);
    const sql = seen.filter(s => /SELECT \* FROM usage/.test(s.sql));
    expect(sql).toHaveLength(3); expect(sql.every(s => !/COUNT/i.test(s.sql))).toBe(true);
    expect(sql[1].sql).toContain("(created_at, id) < (?, ?)");
    expect(sql[1].binds.slice(-2)).toEqual([3, 0]);
  });
  it("rejects cursor scope/window changes and mixed offset", async () => {
    const { seed, get } = await fixture(); seed(); seed();
    const body = await (await get("limit=1&provider_id=p")).json() as any;
    for (const suffix of ["&provider_id=other", "&provider_id=p&to=" + (NOW + 1), "&provider_id=p&offset=1"]) {
      expect((await get("cursor=" + encodeURIComponent(body.next_cursor) + suffix)).status).toBe(400);
    }
  });
  it("retains offset contract and exact status-code/NULL semantics", async () => {
    const { seed, get } = await fixture(); seed(); seed({ status_code: null }); seed({ status_code: 302 }); seed({ status_code: 500 });
    expect(((await (await get("limit=1&offset=1")).json()) as any).items[0].id).toBe(3);
    expect(((await (await get("status=success")).json()) as any).items.map((r: any) => r.id)).toEqual([3, 1]);
    expect(((await (await get("status=500")).json()) as any).items.map((r: any) => r.id)).toEqual([4]);
  });
  it("signals capped exports and continuation without another count query", async () => {
    const { seed, csv } = await fixture(); seed(); seed();
    const result = await csv("limit=1");
    expect(result.headers.get("X-Usage-Truncated")).toBe("true");
    expect(result.headers.get("X-Usage-From")).toBe(String(NOW - DAY));
    expect(JSON.parse(decodeURIComponent(result.headers.get("X-Usage-Next-Cursor")!))).toMatchObject({ id: 2, to: NOW });
  });
  it("plans bounded time/device seek using shipped indexes, without sort or full scan", async () => {
    const { env, d1, seen } = await fixture();
    for (const device_id of [undefined, "d"]) {
      await listUsage(env, { from: NOW - DAY, to: NOW, device_id, cursor: { created_at: NOW - 10, id: 100 }, limit: 51, offset: 0 });
      const query = seen.filter(s => /SELECT \* FROM usage/.test(s.sql)).at(-1)!;
      const plan = d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + query.sql, ...query.binds).map(r => r.detail).join(" | ");
      expect(plan).toMatch(/SEARCH usage USING INDEX idx_usage_(?:created_at|device_created|rollup_cleanup_page)/);
      expect(plan).not.toMatch(/SCAN usage|TEMP B-TREE/);
    }
  });
  it("normalizes parameters without making SQL from filter input", () => {
    expect(parseUsageQuery({ model: "  a' OR 1=1 -- " }).model).toBe("a' OR 1=1 --");
  });
  it("frontend explicitly applies whitelisted filters and shares immutable query with export", () => {
    const source = readFileSync(new URL("../../web/src/pages/UsagePage.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("usage-page-items"); expect(source).not.toContain("buildQuery(items.length)");
    expect(source).toContain("应用筛选"); expect(source).toContain("encodeURIComponent(nextCursor)");
    expect(source).toContain("monthlySequence.current"); expect(source).toContain("analyticsSequence.current");
    expect(source).not.toContain("setInterval"); expect(source).toContain("已有数据为旧快照");
  });
});
const ui = vi.hoisted(() => ({ get: vi.fn(), download: vi.fn(), location: { pathname: "/admin/usage", search: "", hash: "" }, navigate: vi.fn() }));
vi.mock("../../web/src/api/client", () => ({ api: { get: ui.get, download: ui.download }, fmtNum: String, fmtTime: String }));
vi.mock("../../web/src/hooks/useQuery", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
vi.doMock((requireWeb as unknown as { resolve(id: string): string }).resolve("react-router-dom"), () => ({ useLocation: () => ui.location, useNavigate: () => ui.navigate }));
const React = requireWeb("react");
const pagePath = "../../web/src/pages/UsagePage";
const { default: UsagePage } = await import(pagePath);
function componentHarness() {
  const slots: any[] = []; let index = 0;
  const effects: (() => void)[] = [];
  const equal = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const dispatcher = {
    useState(initial: any) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(value: any) { const i = index++; return slots[i] ||= { current: value }; },
    useCallback(fn: any, deps: any[]) {
      const i = index++;
      if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn };
      return slots[i].value;
    },
    useEffect(fn: any, deps: any[]) {
      const i = index++;
      if (!slots[i] || !equal(slots[i].deps, deps)) {
        const previous = slots[i]; slots[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  function render(): any {
    index = 0;
    const current = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = current.current; current.current = dispatcher;
    try { return UsagePage(); } finally { current.current = previous; }
  }
  return { render, effects: () => effects.splice(0).forEach(fn => fn()) };
}
function nodes(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
function button(tree: any, label: string) { return nodes(tree).find(n => n.props?.onClick && text(n).includes(label) && n.props?.children && !Array.isArray(n.props.children?.props)); }
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function resetUi() {
  ui.get.mockReset(); ui.download.mockReset(); ui.navigate.mockReset();
  ui.location = { pathname: "/admin/usage", search: "", hash: "" };
  ui.navigate.mockImplementation((next: any) => { ui.location = next; });
}
describe("usage page real hook lifecycle", () => {
  it.each(["?list_status=succes", "?list_model=" + "x".repeat(257)])("preserves invalid URL filters so backend rejects instead of widening scope: %s", async search => {
    resetUi(); ui.location.search = search;
    ui.get.mockRejectedValue(new Error("invalid_usage_filter"));
    const h = componentHarness(); h.render(); h.effects(); await settle();
    const params = new URL("http://test" + ui.get.mock.calls[0][0]).searchParams;
    if (search.includes("status")) expect(params.get("status")).toBe("succes");
    else expect(params.get("model")).toHaveLength(257);
    const tree = h.render(); expect(text(tree)).toContain("invalid_usage_filter");
    expect(button(tree, "导出 CSV").props.disabled).toBe(true);
    expect(ui.download).not.toHaveBeenCalled();
  });
  it("deduplicates overlapping pages and caps retained DOM rows at 1000 without pretending complete", async () => {
    resetUi(); let page = 0;
    ui.get.mockImplementation(async () => {
      const start = page++ * 49;
      return { items: Array.from({length:50}, (_,i) => ({id:start+i+1})), has_more:true, next_cursor:String(page) };
    });
    const h = componentHarness(); h.render(); h.effects(); await settle();
    let tree = h.render();
    for (let n=0;n<22;n++) {
      const more = button(tree,"加载更多历史数据");
      if (!more) break;
      await more.props.onClick(); tree = h.render();
    }
    expect(nodes(tree).filter(n=>n.type==="tbody").flatMap(n=>nodes(n.props.children).filter(r=>r.type==="tr"))).toHaveLength(1000);
    expect(text(tree)).toContain("列表已达 1,000 条上限");
    expect(text(tree)).not.toContain("已加载全部结果");
    expect(ui.get).toHaveBeenCalledTimes(21);
  });
  it("accepts dashboard today link as browser-local midnight rather than rolling 24h", () => {
    resetUi(); ui.location.search = "?list_range=today"; ui.get.mockReturnValue(new Promise(() => {}));
    const h = componentHarness(); h.render(); h.effects();
    const params = new URL("http://local" + ui.get.mock.calls[0][0]).searchParams;
    const to = Number(params.get("to")); expect(Number(params.get("from"))).toBe(new Date(new Date(to).setHours(0, 0, 0, 0)).getTime());
  });
  it("does not fetch per keystroke, whitelists applied URL, and exports the exact loaded snapshot", async () => {
    resetUi();
    const pending = deferred(); ui.get.mockReturnValue(pending.promise);
    const h = componentHarness(); let tree = h.render(); h.effects();
    expect(ui.get).toHaveBeenCalledTimes(1);
    const url = ui.get.mock.calls[0][0];
    pending.resolve({ items: [], has_more: false, next_cursor: null }); await settle();
    tree = h.render(); h.effects();
    const input = nodes(tree).find(n => n.props?.placeholder === "按模型名筛选…");
    input.props.onChange({ target: { value: "new-model" } });
    tree = h.render(); h.effects(); expect(ui.get).toHaveBeenCalledTimes(1);
    await button(tree, "导出 CSV").props.onClick();
    const exportUrl = ui.download.mock.calls[0][0];
    const list = new URL("http://test" + url); const exported = new URL("http://test" + exportUrl);
    expect(exported.searchParams.get("from")).toBe(list.searchParams.get("from"));
    expect(exported.searchParams.get("to")).toBe(list.searchParams.get("to"));
    expect(exported.searchParams.has("model")).toBe(false);
    button(tree, "应用筛选").props.onClick(); expect(ui.location.search).toContain("list_model=new-model");
    tree = h.render(); tree = h.render(); h.effects();
    expect(ui.get.mock.calls.at(-1)![0]).toContain("model=new-model");
  });
  it("drops stale log responses after a filter changes without replacing newer rows", async () => {
    resetUi(); const old = deferred(); const fresh = deferred();
    ui.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const h = componentHarness(); h.render(); h.effects();
    ui.location.search = "?list_model=fresh"; h.render(); h.render(); h.effects();
    fresh.resolve({ items: [{ id: 2, model: "fresh-row", created_at: NOW, cost_usd: 0 }], has_more: false, next_cursor: null }); await settle();
    old.resolve({ items: [{ id: 1, model: "old-row", created_at: NOW, cost_usd: 0 }], has_more: false, next_cursor: null }); await settle();
    const tree = h.render(); expect(text(tree)).toContain("fresh-row"); expect(text(tree)).not.toContain("old-row");
  });
  it("invalidates monthly and analytics requests immediately when switching away", async () => {
    resetUi(); const logs = deferred(); const month = deferred(); const analytics = deferred();
    ui.get.mockReturnValueOnce(logs.promise).mockReturnValueOnce(month.promise).mockReturnValueOnce(analytics.promise);
    const h = componentHarness(); let tree = h.render(); h.effects();
    button(tree, "📅 月度报表").props.onClick(); tree = h.render(); h.effects();
    button(tree, "🏆 消费排行与异常").props.onClick(); tree = h.render(); h.effects();
    month.resolve({ month: "stale-month" }); await settle();
    button(tree, "📋 调用日志").props.onClick(); tree = h.render(); h.effects();
    analytics.resolve({ marker: "stale-analytics" }); await settle();
    expect(text(h.render())).not.toContain("stale-month");
    expect(text(h.render())).not.toContain("stale-analytics");
  });
});
