import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const apiPath = "../../web/src/api/usageRetention.ts";
const componentPath = "../../web/src/components/UsageRetentionMaintenance.tsx";
const clientPath = "../../web/src/api/client.ts";
const { usageRetentionApi, parseUsageRetentionUtcHour, validateUsageRetentionBatch, usageRetentionBatchFromText,
  canCleanupUsageRetention, sameUsageRetentionBatch, readPendingUsageRetentionCleanup, persistPendingUsageRetentionCleanup,
  clearPendingUsageRetentionCleanup, USAGE_RETENTION_PENDING_KEY } = await import(apiPath);
const { default: UsageRetentionMaintenance } = await import(componentPath);
const { setUnauthorizedHandler } = await import(clientPath);
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const cutoff = "2026-10-01T04:00:00Z";
const batch = { before: Date.UTC(2026, 9, 1, 4), limit: 100, after: { createdAt: 3600000, id: 42 } };
let fetchMock: ReturnType<typeof vi.fn>;
const response = (item: Record<string, unknown> = { provisional: "inspect server result", ok: true, status: "verified", enabled: true, scanned: 1, deleted: 1, next: { createdAt: 7200000, id: 999 } }) =>
  new Response(JSON.stringify({ item }), { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.stubGlobal("window", { location: { pathname: "/admin-prefix-example/usage" } });
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  fetchMock = vi.fn(async () => response()); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { setUnauthorizedHandler(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Element = { type?: unknown; props?: Record<string, any> };
function nodes(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  return [element, ...nodes(element.props?.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object") {
    const element = node as Element;
    if (typeof element.type === "function" && element.type.name === "JsonResult") return text(element.type(element.props));
    return text(element.props?.children);
  }
  return node == null || typeof node === "boolean" ? "" : String(node);
}
function harness() {
  const slots: any[] = [];
  let index = 0, tree: unknown;
  const dispatcher = {
    useState(initial: unknown) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(initial: unknown) { const i = index++; return slots[i] ||= { current: initial }; },
  };
  function render() {
    index = 0;
    const internal = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = internal.current; internal.current = dispatcher;
    try { tree = UsageRetentionMaintenance(); } finally { internal.current = previous; }
    return tree;
  }
  function button(label: string) { return nodes(tree).find(node => node.props?.onClick && text(node) === label)!; }
  function check(position: number, checked = true) {
    nodes(tree).filter(node => node.type === "input" && node.props?.type === "checkbox")[position].props!.onChange({ target: { checked } }); render();
  }
  function field(position: number, value: string) {
    nodes(tree).filter(node => node.props?.onChange && node.props?.type !== "checkbox")[position].props!.onChange({ target: { value } }); render();
  }
  async function click(label: string) { await button(label).props!.onClick(); render(); }
  async function ready() { check(0); field(0, cutoff); field(2, "3600000:42"); await click("执行校验"); await click("预览此批（不删除）"); }
  render();
  return { render, button, check, field, click, ready, text: () => text(tree), inputs: () => nodes(tree).filter(node => node.props?.onChange && node.props?.type !== "checkbox") };
}

describe("retention SSR and pure safety helpers", () => {
  it("starts default-off without even fetching; preserves all financial proof classes", () => {
    const html = renderToStaticMarkup(React.createElement(UsageRetentionMaintenance));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("默认关闭");
    for (const label of ["汇总", "钱包", "月卡", "审计", "计费凭证", "没有自动循环", "UTC", "最大 1000"]) expect(html).toContain(label);
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/disabled=""[^>]*>确认清理一批/);
    expect(html).toContain('value="100"');
    expect(html).not.toContain('type="datetime-local"');
  });
  it("parses only exact explicit UTC calendar hours, never local time or rounded input", () => {
    expect(parseUsageRetentionUtcHour(cutoff)).toBe(batch.before);
    for (const bad of ["", "2026-10-01T04:00", "2026-10-01T04:00:00+00:00", "2026-10-01T04:01:00Z", "2026-02-30T04:00:00Z", "2026-13-01T04:00:00Z", "2026-10-01T24:00:00Z"])
      expect(() => parseUsageRetentionUtcHour(bad)).toThrow();
  });
  it("accepts boundaries and exact composite cursors without coercing unsafe values", () => {
    expect(usageRetentionBatchFromText(cutoff, "100", "3600000:42")).toEqual(batch);
    expect(usageRetentionBatchFromText(cutoff, "1", "")).toEqual({ before: batch.before, limit: 1 });
    expect(validateUsageRetentionBatch({ ...batch, limit: 1000, after: { createdAt: 0, id: 0 } })).toEqual({ ...batch, limit: 1000, after: { createdAt: 0, id: 0 } });
    for (const limit of [0, 1001, 1.5, NaN, Infinity]) expect(() => validateUsageRetentionBatch({ ...batch, limit })).toThrow();
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateUsageRetentionBatch({ ...batch, after: { createdAt: 0, id: value } })).toThrow();
      expect(() => validateUsageRetentionBatch({ ...batch, after: { createdAt: value, id: 0 } })).toThrow();
    }
    for (const after of [42, {}, { createdAt: 3600000 }, { id: 42 }, { createdAt: "3600000", id: 42 }, { createdAt: 3600000, id: "42" }])
      expect(() => validateUsageRetentionBatch({ ...batch, after })).toThrow();
    for (const after of ["42", "3600000", "3600000:", ":42", "3600000:42:1", " 3600000:42", "3600000:42 ", "3.6e6:42", "3600000:1.5"])
      expect(() => usageRetentionBatchFromText(cutoff, "100", after)).toThrow();
    for (const value of ["1e2", "", "-1", "1.5", " 100 "]) expect(() => usageRetentionBatchFromText(cutoff, value, "")).toThrow();
    expect(() => validateUsageRetentionBatch({ ...batch, before: batch.before + 1 })).toThrow();
  });
  it("requires enabled, verification, exact successful preview and fresh confirmation", () => {
    const gate = { enabled: true, verified: true, confirmed: true, busy: false, batch, preview: { ...batch }, unknownCleanup: null };
    expect(canCleanupUsageRetention(gate)).toBe(true);
    for (const key of ["enabled", "verified", "confirmed"]) expect(canCleanupUsageRetention({ ...gate, [key]: false })).toBe(false);
    expect(canCleanupUsageRetention({ ...gate, busy: true })).toBe(false);
    expect(canCleanupUsageRetention({ ...gate, preview: null })).toBe(false);
    for (const changed of [{ ...batch, before: batch.before - 3_600_000 }, { ...batch, limit: 101 }, { ...batch, after: { createdAt: 3600001, id: 42 } }, { ...batch, after: { createdAt: 3600000, id: 43 } }, { before: batch.before, limit: batch.limit }]) {
      expect(sameUsageRetentionBatch(batch, changed)).toBe(false);
      expect(canCleanupUsageRetention({ ...gate, preview: changed })).toBe(false);
      expect(canCleanupUsageRetention({ ...gate, unknownCleanup: changed })).toBe(false);
    }
    expect(canCleanupUsageRetention({ ...gate, unknownCleanup: { ...batch } })).toBe(true);
  });
});

describe("retention admin API body serialization", () => {
  it("uses strict cookie credentials, exact routes and allowlisted request bodies", async () => {
    await usageRetentionApi.status(); await usageRetentionApi.backfill(); await usageRetentionApi.verify();
    await usageRetentionApi.preview({ before: batch.before, limit: 100 });
    await usageRetentionApi.cleanup({ ...batch, after: { ...batch.after, token: "never-forward" }, token: "never-forward", enabled: false }, true, "ui-op");
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["status", "backfill", "verify", "preview", "cleanup"].map(name => "/admin-prefix-example/api/usage-retention/" + name));
    expect(fetchMock.mock.calls.map(call => call[1].body)).toEqual([undefined, '{"limit":500}', '{}', JSON.stringify({ before: batch.before, limit: 100 }), JSON.stringify({ enabled: true, ...batch, confirm: "DELETE_USAGE_DETAILS", operation_id: "ui-op" })]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.credentials).toBe("include");
      expect(init.headers.Authorization).toBeUndefined(); expect(init.headers.authorization).toBeUndefined();
    }
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    for (const [, init] of fetchMock.mock.calls.slice(1)) { expect(init.method).toBe("POST"); expect(init.headers["Content-Type"]).toBe("application/json"); }
  });
  it("rejects unconfirmed cleanup and invalid inputs before fetching", () => {
    expect(() => usageRetentionApi.cleanup(batch, false, "ui-op")).toThrow();
    expect(() => usageRetentionApi.cleanup({ ...batch, limit: 1001 }, true, "ui-op")).toThrow();
    expect(() => usageRetentionApi.preview({ ...batch, after: -1 })).toThrow();
    for (const operationId of ["", "x".repeat(201)]) expect(() => usageRetentionApi.cleanup(batch, true, operationId)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not retry a lost ACK, while an explicit retry serializes identical cutoff/cursor/operation_id", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Lost ACK"));
    await expect(usageRetentionApi.cleanup(batch, true, "ui-op")).rejects.toThrow("Lost ACK");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: true, ...batch, confirm: "DELETE_USAGE_DETAILS", operation_id: "ui-op" });
    await usageRetentionApi.cleanup({ ...batch }, true, "ui-op");
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
  });
  it("rejects malformed envelopes rather than treating an empty success as a preview", async () => {
    for (const value of [{}, { item: null }, { item: [] }, { item: "ok" }]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status: 200 }));
      await expect(usageRetentionApi.preview(batch)).rejects.toThrow("item");
    }
  });
  it("uses the existing admin 401 handler rather than tokens", async () => {
    const unauthorized = vi.fn(); setUnauthorizedHandler(unauthorized);
    fetchMock.mockResolvedValueOnce(new Response('{"error":"admin required"}', { status: 401 }));
    await expect(usageRetentionApi.status()).rejects.toThrow("admin required"); expect(unauthorized).toHaveBeenCalledOnce();
  });
});

describe("retention reload journal safety", () => {
  it("restores an uncertain cleanup across remount, requires verification and confirmation, and replays the identical operation", async () => {
    const first = harness(); await first.ready(); first.check(1);
    fetchMock.mockRejectedValueOnce(new Error("lost ACK")); await first.click("确认清理一批");
    const original = fetchMock.mock.calls[2][1].body;
    const pending = readPendingUsageRetentionCleanup(); expect(pending.operationId).toBe(JSON.parse(original).operation_id);
    const count = fetchMock.mock.calls.length;
    const restored = harness(); expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(restored.inputs().map(n => n.props!.value)).toEqual([cutoff, "100", "3600000:42"]);
    expect(restored.inputs().every(n => n.props!.disabled)).toBe(true);
    expect(restored.button("相同参数安全重试清理一批").props!.disabled).toBe(true);
    restored.check(0); await restored.click("预览此批（不删除）"); expect(fetchMock).toHaveBeenCalledTimes(count);
    await restored.click("执行校验"); await restored.click("预览此批（不删除）"); restored.check(1);
    await restored.click("相同参数安全重试清理一批");
    expect(fetchMock.mock.calls.at(-1)![1].body).toBe(original);
    expect(readPendingUsageRetentionCleanup()).toBeNull();
  });
  it("never dispatches cleanup when persistence fails", async () => {
    const h = harness(); await h.ready(); h.check(1);
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => { throw new Error("storage denied"); } });
    await h.click("确认清理一批");
    expect(fetchMock.mock.calls.filter(c => c[0].endsWith("/cleanup"))).toHaveLength(0);
    expect(h.text()).toContain("未发送清理请求");
  });
  it("fails closed on corrupt journal without mount-time network", () => {
    (globalThis as any).sessionStorage.setItem(USAGE_RETENTION_PENDING_KEY, '{"operationId":"lost","batch":{}}');
    const h = harness(); h.check(0);
    expect(h.text()).toContain("禁止清理"); expect(fetchMock).not.toHaveBeenCalled();
    expect(h.button("确认清理一批").props!.disabled).toBe(true);
  });
  it("refuses to overwrite or clear another uncertain operation and stores no credentials", () => {
    const intent = { operationId: "original", batch };
    persistPendingUsageRetentionCleanup(intent);
    expect(JSON.parse((globalThis as any).sessionStorage.getItem(USAGE_RETENTION_PENDING_KEY)!)).toEqual(intent);
    expect(() => persistPendingUsageRetentionCleanup({ ...intent, operationId: "different" })).toThrow();
    expect(() => clearPendingUsageRetentionCleanup({ ...intent, batch: { ...batch, limit: 2 } })).toThrow();
    expect(readPendingUsageRetentionCleanup()).toEqual(intent);
  });
  it("keeps the original journal on malformed success instead of accepting it as an ACK", async () => {
    const h = harness(); await h.ready(); h.check(1);
    fetchMock.mockResolvedValueOnce(response({})); await h.click("确认清理一批");
    expect(readPendingUsageRetentionCleanup()).not.toBeNull(); expect(h.text()).toContain("结果未知");
  });
});

describe("retention real hook/event safety without a browser DOM", () => {
  it("gates deletion and invalidates preview/confirmation after each field or status change", async () => {
    const h = harness();
    await h.click("确认清理一批"); expect(fetchMock).not.toHaveBeenCalled();
    await h.ready(); expect(h.button("确认清理一批").props!.disabled).toBe(true);
    h.check(1); expect(h.button("确认清理一批").props!.disabled).toBe(false);
    h.field(1, "101"); expect(h.button("确认清理一批").props!.disabled).toBe(true);
    await h.click("确认清理一批"); expect(fetchMock).toHaveBeenCalledTimes(2);
    await h.click("预览此批（不删除）"); h.check(1); await h.click("刷新状态");
    expect(h.button("确认清理一批").props!.disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(call => call[0].endsWith("/cleanup"))).toHaveLength(0);
  });
  it.each([
    { ok: false, status: "verified" },
    { ok: true, status: "incomplete" },
    { ok: true },
    { status: "verified" },
    { ok: "true", status: "verified" },
    { ok: 1, status: "verified" },
    {},
  ])("an acknowledged unsuccessful verify cannot unlock preview or cleanup: %j", async item => {
    const h = harness(); await h.ready(); h.check(1);
    expect(h.button("确认清理一批").props!.disabled).toBe(false);
    fetchMock.mockResolvedValueOnce(response(item)); await h.click("执行校验");
    expect(h.button("预览此批（不删除）").props!.disabled).toBe(true);
    expect(h.button("确认清理一批").props!.disabled).toBe(true);
    await h.click("预览此批（不删除）"); h.check(1); await h.click("确认清理一批");
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["verify", "preview", "verify"].map(name => "/admin-prefix-example/api/usage-retention/" + name));
    expect(h.text()).not.toContain("结果未知");
  });
  it("cleanup is one batch, clears confirmation, and never advances the provisional cursor", async () => {
    const h = harness(); await h.ready(); h.check(1); await h.click("确认清理一批");
    expect(fetchMock.mock.calls.filter(call => call[0].endsWith("/cleanup"))).toHaveLength(1);
    expect(h.inputs()[2].props!.value).toBe("3600000:42");
    expect(h.button("确认清理一批").props!.disabled).toBe(true);
    expect(h.text()).toContain("不代表全部清理完成"); expect(h.text()).toContain("provisional");
  });
  it("separate explicit completed cleanup of the same batch gets a new operation_id", async () => {
    const h = harness(); await h.ready(); h.check(1);
    fetchMock.mockResolvedValueOnce(response({ enabled: true, scanned: 1, deleted: 1, next: null }));
    await h.click("确认清理一批");
    expect(h.button("确认清理一批").props!.disabled).toBe(true);
    await h.click("确认清理一批");
    expect(fetchMock.mock.calls.filter(call => call[0].endsWith("/cleanup"))).toHaveLength(1);
    await h.click("预览此批（不删除）"); h.check(1);
    fetchMock.mockResolvedValueOnce(response({ enabled: true, scanned: 0, deleted: 0, next: null }));
    await h.click("确认清理一批");
    const bodies = fetchMock.mock.calls.filter(call => call[0].endsWith("/cleanup")).map(call => JSON.parse(call[1].body));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toEqual({ enabled: true, ...batch, confirm: "DELETE_USAGE_DETAILS", operation_id: expect.any(String) });
    expect(bodies[0].operation_id).not.toBe("");
    expect(bodies[1].operation_id).not.toBe("");
    expect(bodies[1].operation_id).not.toBe(bodies[0].operation_id);
    expect(h.inputs()[2].props!.value).toBe("3600000:42");
  });
  it("lost cleanup ACK freezes parameters and requires fresh preview/confirmation with the same operation_id", async () => {
    const h = harness(); await h.ready(); h.check(1);
    fetchMock.mockRejectedValueOnce(new TypeError("Lost ACK")); await h.click("确认清理一批");
    const original = fetchMock.mock.calls[2][1].body;
    const originalBody = JSON.parse(original);
    expect(originalBody).toEqual({ enabled: true, ...batch, confirm: "DELETE_USAGE_DETAILS", operation_id: expect.any(String) });
    expect(originalBody.operation_id).not.toBe("");
    expect(h.text()).toContain("结果未知"); expect(h.text()).toContain("不是已完成");
    expect(h.button("相同参数安全重试清理一批").props!.disabled).toBe(true);
    h.field(2, "7200000:999"); expect(h.inputs()[2].props!.value).toBe("3600000:42");
    await h.click("刷新状态"); expect(h.text()).toContain("结果仍未知");
    await h.click("预览此批（不删除）"); expect(h.button("相同参数安全重试清理一批").props!.disabled).toBe(true);
    h.check(1); await h.click("相同参数安全重试清理一批");
    expect(fetchMock.mock.calls[5][1].body).toBe(original);
    expect(JSON.parse(fetchMock.mock.calls[5][1].body).operation_id).toBe(originalBody.operation_id);
    expect(fetchMock.mock.calls.filter(call => call[0].endsWith("/cleanup"))).toHaveLength(2);
  });
  it("backfill invalidates verification; a lost backfill ACK only offers fixed one-batch retry", async () => {
    const h = harness(); await h.ready(); h.check(1);
    fetchMock.mockRejectedValueOnce(new Error("Lost ACK")); await h.click("回填一批（500）");
    expect(h.button("确认清理一批").props!.disabled).toBe(true);
    await h.click("相同参数手动重试上次请求");
    expect(fetchMock.mock.calls[2][1].body).toBe('{"limit":500}'); expect(fetchMock.mock.calls[3][1].body).toBe('{"limit":500}');
    expect(h.button("预览此批（不删除）").props!.disabled).toBe(true);
  });
  it("an acknowledged server rejection leaves cleanup locked but allows correcting inputs", async () => {
    const h = harness(); h.check(0); h.field(0, cutoff); await h.click("执行校验");
    fetchMock.mockResolvedValueOnce(new Response('{"error":"cutoff rejected"}', { status: 400 }));
    await h.click("预览此批（不删除）");
    expect(h.text()).toContain("服务器拒绝"); expect(h.button("确认清理一批").props!.disabled).toBe(true);
    h.field(2, "3600000:88"); expect(h.inputs()[2].props!.value).toBe("3600000:88");
  });
  it("a malformed or lost preview ACK cannot enable cleanup", async () => {
    const h = harness(); h.check(0); h.field(0, cutoff); await h.click("执行校验");
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await h.click("预览此批（不删除）"); h.check(1); await h.click("确认清理一批");
    expect(h.text()).toContain("结果未知");
    expect(fetchMock.mock.calls.filter(call => call[0].endsWith("/cleanup"))).toHaveLength(0);
  });
  it("blocks duplicate clicks immediately even before a hook rerender", async () => {
    const h = harness(); h.check(0);
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const handler = h.button("回填一批（500）").props!.onClick;
    const pending = handler(); await handler(); expect(fetchMock).toHaveBeenCalledOnce();
    finish(response()); await pending; h.render();
  });
});
