import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { makeWalletFixture } from "./helpers/walletFixture";

const componentPath = "../../web/src/components/AdminVideoTasks.tsx";
const clientPath = "../../web/src/api/client.ts";
const filtersPath = "../../web/src/hooks/useAdminFilters.ts";
const { default: AdminVideoTasks, recordTimeDefaults, recordQuery, useAdminRecordPage } = await import(componentPath);
const { api } = await import(clientPath);
const { readAdminFilters, writeAdminFilters } = await import(filtersPath);
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const { MemoryRouter } = requireWeb("react-router-dom");
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const f = await makeWalletFixture(); f.env.SESSION_SECRET = "audit-local-session";
  const cookie = buildSessionCookie(await signSession(f.env.SESSION_SECRET, 0)).split(";")[0];
  const get = (path: string) => adminApp.request("https://gateway.test" + path, { headers: { cookie } }, f.env);
  const seed = (time: number, action = "device.update", actor = "admin", target = "device", id = "dev-1", ip = "127.0.0.1", summary = "safe", details = "{}") =>
    f.d1.sql("INSERT INTO audit_logs (created_at,action,actor_type,target_type,target_id,ip,summary,details_json) VALUES (?,?,?,?,?,?,?,?)", time, action, actor, target, id, ip, summary, details);
  return { ...f, get, seed };
}
type AuditPage = { items: { id: number }[]; next_cursor: string | null; has_more: boolean; total?: number };
const ids = (page: unknown) => (page as AuditPage).items.map(row => row.id);
describe("audit exact bounded record queries", () => {
  it("orders tied times by id and excludes concurrent newer inserts on the next cursor page", async () => {
    const f = await setup(); f.seed(100); f.seed(100); f.seed(101);
    const first = await (await f.get("/audit-logs?limit=1")).json() as AuditPage;
    expect(ids(first)).toEqual([3]); expect(first.has_more).toBe(true); expect(first.total).toBeUndefined();
    f.seed(102);
    const second = await (await f.get("/audit-logs?limit=1&cursor=" + encodeURIComponent(first.next_cursor!))).json() as AuditPage;
    expect(ids(second)).toEqual([2]);
    const third = await (await f.get("/audit-logs?limit=1&cursor=" + encodeURIComponent(second.next_cursor!))).json() as AuditPage;
    expect(ids(third)).toEqual([1]); expect(third.has_more).toBe(false); expect(third.next_cursor).toBeNull();
    expect((await f.get("/audit-logs?action=other&cursor=" + encodeURIComponent(first.next_cursor!))).status).toBe(400);
  });
  it("applies exact action/actor/IP/object/time filters before limit and uses identical export predicates", async () => {
    const f = await setup();
    f.seed(100); f.seed(101); f.seed(99); f.seed(102);
    f.seed(100, "device.update.extra"); f.seed(100, "device.update", "console");
    f.seed(100, "device.update", "admin", "model"); f.seed(100, "device.update", "admin", "device", "dev-other");
    f.seed(100, "device.update", "admin", "device", "dev-1", "192.0.2.1");
    const query = "action=device.update&actor_type=admin&target_type=device&target_id=dev-1&ip=127.0.0.1&from=100&to=101&limit=1";
    const response = await f.get("/audit-logs?" + query); expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.json(); expect(ids(page)).toEqual([2]);
    const exported = await f.get("/audit-logs/export?" + query);
    expect(exported.headers.get("x-export-truncated")).toBe("true");
    const csv = await exported.text(); expect(csv.split("\n")).toHaveLength(2); expect(csv).toContain('"device.update"');
    expect((await f.get("/audit-logs/export?" + query.replace("limit=1", "limit=2"))).headers.get("x-export-truncated")).toBe("false");
    expect(ids(await (await f.get("/audit-logs?target_id=" + encodeURIComponent("x' OR '1'='1"))).json())).toEqual([]);
  });
  it("preserves formula neutralization, quotes and multiline escaping on every CSV text field", async () => {
    const f = await setup(); f.seed(100, "=1+1", "+admin", "@device", "-id", "=ip", '=HYPERLINK("x")\nnext', "=details");
    const csv = await (await f.get("/audit-logs/export")).text();
    for (const safe of ["'=1+1", "'+admin", "'@device", "'-id", "'=ip", "'=details", `'=HYPERLINK(""x"")\nnext`]) expect(csv).toContain(safe);
  });
  it.each(["limit=0", "limit=-1", "limit=201", "limit=NaN", "limit=1.5", "from=2&to=1", "from=0&to=2764800000", "from=100", "to=Infinity", "offset=10001", "offset=-1", "cursor=bad", "actor_type=%00", "target_id=" + "x".repeat(257)])("rejects invalid audit input %s", async query => {
    const f = await setup(); expect((await f.get("/audit-logs?" + query)).status).toBe(400);
  });
  it("caps export at 1000 (not repository's old 200) and executes one lookahead SELECT without COUNT", async () => {
    const f = await setup(); for (let i = 0; i < 1001; i++) f.seed(i);
    const spy = vi.spyOn(f.env.DB, "prepare");
    const response = await f.get("/audit-logs/export?limit=1000");
    expect((await response.text()).split("\n")).toHaveLength(1001); expect(response.headers.get("x-export-truncated")).toBe("true");
    const queries = spy.mock.calls.map(call => String(call[0])).filter(sql => /FROM audit_logs/i.test(sql));
    expect(queries).toHaveLength(1); expect(queries[0]).toContain("ORDER BY created_at DESC, id DESC LIMIT ?");
    expect(queries[0]).not.toMatch(/SELECT \*|COUNT\(|LIKE|OFFSET/i);
    expect((await f.get("/audit-logs/export?limit=1001")).status).toBe(400);
  });
});

function harness(initialQuery = "from=1&to=2", path = "/api/audit-logs") {
  const slots: any[] = []; let index = 0, effects: (() => void)[] = [], query = initialQuery;
  const same = (a: unknown[], b: unknown[]) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const dispatcher = {
    useState(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as Function)() : initial;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? (next as Function)(slots[i]) : next; }]; },
    useRef(initial: unknown) { const i = index++; return slots[i] ??= { current: initial }; },
    useCallback(fn: Function, deps: unknown[]) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn: () => any, deps: unknown[]) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) {
      const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
    } },
  };
  return { render(next = query) { query = next; index = 0; effects = [];
    const internal = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = internal.current; internal.current = dispatcher; let result;
    try { result = useAdminRecordPage(path, query); } finally { internal.current = previous; }
    for (const effect of effects) effect(); return result;
  }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const page = (id: string, cursor: string | null = null) => ({ items: [{ id }], next_cursor: cursor, has_more: !!cursor });
describe("audit/task UI query isolation and response safety", () => {
  it.each(["/api/audit-logs", "/api/video-tasks"])("caps %s at 1000 unique rows without changing exports or pretending completeness", async path => {
    let offset = 0;
    const spy = vi.spyOn(api, "get").mockImplementation(async (...args: unknown[]) => {
      const params = new URL(String(args[0]), "https://local.test").searchParams;
      const limit = Number(params.get("limit"));
      const rows = Array.from({ length: limit }, (_, i) => ({ id: "row-" + (offset + i) }));
      offset += limit;
      return { items: rows, has_more: true, next_cursor: "cursor-" + offset } as any;
    });
    const h = harness(undefined, path); h.render(); await tick();
    while (h.render().items.length < 1000) await h.render().more();
    expect(h.render().items).toHaveLength(1000); expect(h.render().capped).toBe(true);
    expect(spy.mock.calls.at(-1)![0]).toContain("limit=10");
    const count = spy.mock.calls.length;
    await h.render().more(); await h.render().retry();
    expect(spy).toHaveBeenCalledTimes(count);
    spy.mockRejectedValueOnce(new Error("offline")); await h.render().refresh();
    expect(h.render().items).toHaveLength(1000); expect(h.render().capped).toBe(true);
    await h.render().retry(); expect(h.render().items).toHaveLength(30); expect(h.render().capped).toBe(false);
    h.render("from=2&to=4"); await tick(); expect(h.render().items).toHaveLength(30);
    h.unmount();
  });
  it("deduplicates within the first page and stops overlapping responses from exceeding the bound", async () => {
    const spy = vi.spyOn(api, "get").mockResolvedValueOnce({ items: [{id:"same"}, {id:"same"}], has_more:true, next_cursor:"tail" });
    const h = harness(); h.render(); await tick(); expect(h.render().items).toEqual([{id:"same"}]);
    spy.mockResolvedValueOnce({items: Array.from({length:1200}, (_,i)=>({id:"extra-"+i})), has_more:true,next_cursor:"more"});
    await h.render().more(); expect(h.render().items).toHaveLength(1000); expect(h.render().capped).toBe(true);
    h.unmount();
  });

  it("ignores slow prior filter responses, retains old data on error, and retries the failed page", async () => {
    const first = deferred<unknown>(), second = deferred<unknown>();
    const spy = vi.spyOn(api, "get").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const h = harness(); h.render(); h.render("from=2&to=3");
    second.resolve(page("new", "next")); await tick(); first.resolve(page("obsolete")); await tick();
    expect(h.render().items).toEqual([{ id: "new" }]);
    spy.mockRejectedValueOnce(new Error("offline")); await h.render().more();
    expect(h.render().error).toBe("offline"); expect(h.render().items).toEqual([{ id: "new" }]);
    spy.mockResolvedValueOnce(page("tail")); await h.render().retry();
    expect(spy.mock.calls.at(-1)![0]).toContain("cursor=next"); expect(h.render().items).toEqual([{ id: "new" }, { id: "tail" }]);
    expect(h.render().cursor).toBeNull(); h.unmount();
  });
  it("latest manual refresh wins over stale failures; unmount prevents late writes", async () => {
    vi.spyOn(api, "get").mockResolvedValueOnce(page("initial")); const h = harness(); h.render(); await tick();
    const old = deferred<unknown>(), fresh = deferred<unknown>();
    vi.mocked(api.get).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const pending = h.render().refresh(), latest = h.render().refresh();
    fresh.resolve(page("latest")); await latest; old.reject(new Error("old failure")); await pending;
    expect(h.render().items).toEqual([{ id: "latest" }]); expect(h.render().error).toBe("");
    const late = deferred<unknown>(); vi.mocked(api.get).mockReturnValueOnce(late.promise);
    const lateRequest = h.render().refresh(); h.unmount(); late.resolve(page("after-unmount")); await lateRequest;
    expect(h.render().items).toEqual([{ id: "latest" }]);
  });
  it("persists only unique whitelisted audit/task fields, never financial/settings drafts", () => {
    const defaults = { audit_action: "", audit_target_id: "", ...recordTimeDefaults("audit_", Date.UTC(2026, 10, 15)) };
    const url = writeAdminFilters("?list_task_status=failed&other=keep", defaults, { ...defaults, audit_action: "device.update", password: "SECRET" });
    expect(url).toContain("list_audit_action=device.update"); expect(url).toContain("list_task_status=failed"); expect(url).not.toContain("SECRET");
    expect(readAdminFilters("?" + url, defaults).audit_action).toBe("device.update");
    const query = recordQuery({ ...defaults, audit_target_id: "dev-1", password: "SECRET" }, "audit_", ["action", "target_id"]);
    expect(query).toContain("target_id=dev-1"); expect(query).not.toContain("SECRET");
    const params = new URLSearchParams(query); expect(Number(params.get("to")) - Number(params.get("from"))).toBe(30 * 86400000);
    expect(() => recordQuery({ ...defaults, audit_from: "bad" }, "audit_", [])).toThrow();
  });
  it("renders safe task management SSR controls without any fetch or mutation; settings initializer is audit-independent", () => {
    const spy = vi.spyOn(api, "get");
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(AdminVideoTasks)));
    for (const text of ["视频任务管理（只读）", "最近 30 天", "任务状态", "账户 ID", "任务 ID", "任务开始时间", "任务结束时间", "查询任务", "手动刷新", "不轮询上游"]) expect(html).toContain(text);
    expect(spy).not.toHaveBeenCalled();
    const source = readFileSync(new URL("../../web/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
    expect(source).toContain("[loadIpWhitelist, loadKeyRotation, loadSnapshots]"); expect(source).toContain("<AdminVideoTasks />");
    const taskSource = readFileSync(new URL(componentPath, import.meta.url), "utf8");
    expect(taskSource).not.toMatch(/setInterval|api\.post|reconcile|diagnostics/);
  });
});
