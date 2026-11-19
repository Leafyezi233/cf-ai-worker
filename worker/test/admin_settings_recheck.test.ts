import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const f = vi.hoisted(() => ({
  data: {} as Record<string, any>, refresh: {} as Record<string, ReturnType<typeof vi.fn>>,
  success: vi.fn(), error: vi.fn(),
}));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: f.success, error: f.error }) }));
vi.mock("../../web/src/hooks/useQuery", () => ({ useQuery: (key: string) => ({
  data: f.data[key], loading: false, error: null, refresh: f.refresh[key],
}) }));
vi.mock("../../web/src/hooks/useAdminFilters", () => ({ useAdminFilters: (defaults: any) => [defaults, vi.fn(), vi.fn()] }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const pagePath = "../../web/src/pages/SettingsPage";
const clientPath = "../../web/src/api/client";
const { default: SettingsPage } = await import(pagePath);
const { api } = await import(clientPath);

function harness(props?: any) {
  const slots: any[] = []; let index = 0; let effects: (() => void)[] = [];
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const dispatcher = {
    useState(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial: any) { const i = index++; return slots[i] ??= { current: initial }; },
    useCallback(fn: any, deps: any[]) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useMemo(fn: any, deps: any[]) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn: any, deps: any[]) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) {
      const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
    } },
  };
  return { render() {
    index = 0; effects = [];
    const internal = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = internal.current; internal.current = dispatcher;
    let tree; try { tree = SettingsPage(props); } finally { internal.current = previous; }
    effects.forEach(fn => fn()); return tree;
  }, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function nodes(v: any): any[] {
  if (Array.isArray(v)) return v.flatMap(nodes);
  return v && typeof v === "object" ? [v, ...nodes(v.props?.children)] : [];
}
function text(v: any): string {
  if (Array.isArray(v)) return v.map(text).join("");
  return v && typeof v === "object" ? text(v.props?.children) : v == null || typeof v === "boolean" ? "" : String(v);
}
const card = (tree: any, id: string) => nodes(tree).find(n => n.props?.id === id);
const form = (tree: any, id: string) => nodes(card(tree, id)).find(n => n.type === "form").props;
const field = (tree: any, id: string) => nodes(card(tree, id)).find(n => n.props?.onChange && n.props.value !== undefined).props;
const checkbox = (tree: any) => nodes(card(tree, "settings-access")).find(n => n.props?.type === "checkbox").props;
const exportButton = (tree: any) => nodes(tree).find(n => n.props?.onClick && text(n) === "导出审计 CSV").props;
function deferred<T = any>() { let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const submit = { preventDefault() {} };
const configs = [
  { name: "budget", id: "settings-budget", key: "budget-data", property: "monthly_budget_usd", a: 101, b: 202 },
  { name: "announcement", id: "settings-announcement", key: "announcement-data", property: "title", a: "title A", b: "title B" },
  { name: "webhook", id: "settings-webhook", key: "webhook-data", property: "url", a: "https://a.test", b: "https://b.test" },
];
beforeEach(() => {
  f.success.mockReset(); f.error.mockReset();
  f.data = {
    "settings-data": { gateway_base_url: "https://gateway.test", providers: [] },
    "budget-data": { monthly_budget_usd: 10, budget_action: "warn", alert_threshold_pct: 80, spent_this_month_usd: 1 },
    "announcement-data": { enabled: false, level: "info", title: "server", message: "message", updated_at: null },
    "webhook-data": { url: "https://server.test", events: ["budget_exceeded"] },
  };
  f.refresh = Object.fromEntries(configs.map(c => [c.key, vi.fn().mockResolvedValue(undefined)]));
  vi.spyOn(api, "get").mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]);
    if (path.endsWith("ip-whitelist")) return { enabled: false, allowed_ips: [], client_ip: "127.0.0.1" };
    return { items: [], providers: [], has_more: false, next_cursor: null };
  });
  vi.spyOn(api, "put").mockResolvedValue({});
  vi.stubGlobal("window", { location: { origin: "https://gateway.test", pathname: "/admin/settings" }, URL: { createObjectURL: vi.fn(() => "blob:csv"), revokeObjectURL: vi.fn() } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mounted(props?: any) { const h = harness(props); h.render(); await flush(); h.render(); return h; }
function serverValue(c: typeof configs[number], value: any) { f.data[c.key] = { ...f.data[c.key], [c.property]: value }; }
function edit(h: ReturnType<typeof harness>, c: typeof configs[number], value: any) {
  const input = field(h.render(), c.id); expect(input.disabled).not.toBe(true);
  input.onChange({ target: { value: String(value) } });
}

describe("settings draft recheck with real React dispatcher", () => {
  it.each(configs)("hydrates $name repeatedly while clean, but preserves a dirty draft", async c => {
    const h = await mounted(); serverValue(c, c.a); h.render(); expect(field(h.render(), c.id).value).toBe(c.a);
    edit(h, c, c.b); serverValue(c, c.a); h.render(); expect(field(h.render(), c.id).value).toBe(c.b); h.unmount();
  });
  for (const phase of ["PUT", "refresh"]) it.each(configs)("preserves $name edit B during " + phase + " for save A, then can save B", async c => {
    const h = await mounted(); const put = deferred(); const refresh = deferred();
    vi.mocked(api.put).mockImplementationOnce(() => put.promise);
    f.refresh[c.key].mockImplementationOnce(() => refresh.promise);
    edit(h, c, c.a); const saving = form(h.render(), c.id).onSubmit(submit);
    expect(api.put).toHaveBeenLastCalledWith("/api/settings/" + c.name, expect.objectContaining({ [c.property]: c.a }));
    if (phase === "refresh") { put.resolve({}); await flush(); expect(f.refresh[c.key]).toHaveBeenCalledTimes(1); }
    edit(h, c, c.b);
    if (phase === "PUT") { put.resolve({}); await flush(); }
    serverValue(c, c.a); h.render(); refresh.resolve(f.data[c.key]); await saving;
    expect(field(h.render(), c.id).value).toBe(c.b);
    serverValue(c, c.a); h.render(); expect(field(h.render(), c.id).value).toBe(c.b);
    await form(h.render(), c.id).onSubmit(submit);
    expect(api.put).toHaveBeenLastCalledWith("/api/settings/" + c.name, expect.objectContaining({ [c.property]: c.b }));
    serverValue(c, c.a); h.render(); expect(field(h.render(), c.id).value).toBe(c.a); h.unmount();
  });
  it("does not mark unrelated forms dirty or clear a failed save's draft", async () => {
    const h = await mounted(); const [budget, announcement] = configs;
    edit(h, budget, budget.b); serverValue(announcement, announcement.a); h.render();
    expect(field(h.render(), announcement.id).value).toBe(announcement.a);
    vi.mocked(api.put).mockRejectedValueOnce(new Error("save rejected"));
    await form(h.render(), budget.id).onSubmit(submit); serverValue(budget, budget.a); h.render();
    expect(field(h.render(), budget.id).value).toBe(budget.b); expect(f.error).toHaveBeenCalledWith("保存预算失败: save rejected"); h.unmount();
  });
  it("protects IP whitelist edits from a pending initial GET and PUT response", async () => {
    const initial = deferred(); vi.mocked(api.get).mockImplementation(async (path: string) => path.endsWith("ip-whitelist") ? initial.promise : { items: [] });
    (globalThis as any).window.location.search = "?tab=security";
    const h = harness(); h.render(); checkbox(h.render()).onChange({ target: { checked: true } });
    initial.resolve({ enabled: false, allowed_ips: [], client_ip: "127.0.0.1" }); await flush();
    expect(checkbox(h.render()).checked).toBe(true);
    const put = deferred(); vi.mocked(api.put).mockImplementationOnce(() => put.promise);
    const saving = form(h.render(), "settings-access").onSubmit(submit);
    checkbox(h.render()).onChange({ target: { checked: false } });
    put.resolve({ enabled: true, allowed_ips: [], client_ip: "127.0.0.1" }); await saving;
    expect(checkbox(h.render()).checked).toBe(false); h.unmount();
  });
});

describe("audit export metadata and incomplete-result feedback", () => {
  function downloadResponse(truncated?: string, limit?: string) {
    const headers = new Headers({ "Content-Disposition": 'attachment; filename="audit.csv"' });
    if (truncated !== undefined) headers.set("X-Export-Truncated", truncated);
    if (limit !== undefined) headers.set("X-Export-Limit", limit);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("csv", { headers })));
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } }); return anchor;
  }
  it.each([["true", "1000", true, 1000], ["false", "1000", false, 1000], [undefined, undefined, false, null], ["false", "invalid", false, null]])(
    "returns response header metadata %s / %s while retaining file download", async (header, limit, truncated, expectedLimit) => {
      const anchor = downloadResponse(header as string | undefined, limit as string | undefined);
      await expect(api.download("/api/audit-logs/export?limit=1000")).resolves.toEqual({ truncated, limit: expectedLimit });
      expect(anchor.download).toBe("audit.csv"); expect(anchor.click).toHaveBeenCalledTimes(1);
      expect((globalThis as any).window.URL.revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    });
  it("reads real download response headers and warns instead of claiming complete success", async () => {
    const h = await mounted({ view: "audit" }); downloadResponse("true", "1000");
    await exportButton(h.render()).onClick();
    expect(f.error).toHaveBeenCalledWith("审计日志 CSV 仅导出前 1000 条，结果不完整；请缩小时间范围后重新导出。");
    expect(f.success).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("limit=1000"), expect.anything()); h.unmount();
  });
  it.each([{ truncated: false, limit: 1000 }, undefined])("keeps complete exports and legacy undefined-return mocks compatible: %s", async result => {
    const h = await mounted({ view: "audit" }); vi.spyOn(api, "download").mockResolvedValue(result);
    await exportButton(h.render()).onClick(); expect(f.success).toHaveBeenCalledWith("审计日志 CSV 导出成功"); expect(f.error).not.toHaveBeenCalled(); h.unmount();
  });
});
