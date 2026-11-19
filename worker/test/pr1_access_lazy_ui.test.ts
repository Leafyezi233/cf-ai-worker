import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
// A deterministic hook harness drives the real drawer event handlers without adding a DOM dependency.
const slots: any[] = []; let cursor = 0;
const state = (initial: any) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; };
vi.doMock((requireWeb as any).resolve("react"), () => ({ ...React, useState: state, useRef: (initial: any) => { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }); }, useEffect: () => {}, useMemo: (fn: any) => fn(), useCallback: (fn: any) => fn }));
const summary = { device_id: "acct", issues: [], wallet: { balance_usd: 1, reserved_usd: 0, available_usd: 1 }, month_cost_usd: 0, cost_limit_monthly: 0, monthly_pass: null, models: [], models_loaded: false, checked_at: 1, truncated: false };
const get = vi.fn(async (url: string) => url.includes("models=1") ? { ...summary, models_loaded: true, next_cursor: "resume", partial: true } : summary);
vi.doMock("../../web/src/api/client", () => ({ api: { get }, fmtTime: () => "now" }));
let loaded = false;
vi.doMock("../../web/src/hooks/useQuery", () => ({ useQuery: (_key: string, fetcher: () => Promise<any>) => { if (!loaded) { loaded = true; void fetcher(); } return { data: summary, loading: false, error: null, refresh: fetcher }; } }));
const drawerPath = "../../web/src/components/AccountDetailDrawer";
const { AccountDetailDrawer } = await import(drawerPath);
const props = { device: { id: "acct", name: "A" }, onClose: () => {}, onTopup: () => {}, onEdit: () => {}, onScope: () => {}, onSubTokens: () => {} };
function render() { cursor = 0; return AccountDetailDrawer(props); }
function elements(node: any): any[] { if (!node || typeof node !== "object") return []; const children = node.props?.children; return [node, ...(Array.isArray(children) ? children : [children]).flatMap(elements)]; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe("PR1 account drawer lazy event handlers", () => {
  it("only requests summary on opening, then models on click, keeps the continuation cursor and displays fetch errors", async () => {
    const initial = render(); await flush();
    expect(get.mock.calls.map(c => c[0])).toEqual(["/api/devices/acct/access"]);
    const button = elements(initial).find(e => e.props?.children === "检查模型"); expect(button).toBeDefined();
    button.props.onClick(); await flush();
    expect(get.mock.calls[1][0]).toBe("/api/devices/acct/access?models=1&limit=5&cursor=");
    const next = elements(render()).find(e => e.props?.children === "继续下一页 / 续查未检查模型");
    expect(next).toBeDefined(); next.props.onClick(); await flush();
    expect(get.mock.calls[2][0]).toContain("cursor=resume");
    get.mockRejectedValueOnce(Error("database unavailable")); next.props.onClick(); await flush();
    expect(elements(render()).some(e => e.props?.role === "alert")).toBe(true);
  });
});
