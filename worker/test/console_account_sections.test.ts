import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const f = vi.hoisted(() => ({
  queries: [] as Array<{ key: string; fetcher: () => Promise<unknown>; options: { enabled: boolean; ttlMs: number } }>,
  create: vi.fn(), tokens: vi.fn(), calls: vi.fn(), refresh: vi.fn(), setCalls: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}));
vi.mock("../../web/src/hooks/useQuery", () => ({
  useQuery: (key: string, fetcher: () => Promise<unknown>, options: { enabled: boolean; ttlMs: number }) => {
    f.queries.push({ key, fetcher, options });
    return { data: key.endsWith(":calls") ? { calls_enabled: false } : { items: [
      { id: "live", name: "研发", enabled: true, revoked: false },
      { id: "dead", name: "已撤销令牌", enabled: false, revoked: true },
    ], remaining: 4, limit: 5 }, loading: false, error: null, refresh: f.refresh, mutate: vi.fn() };
  },
}));
vi.mock("../../web/src/api/consoleClient", () => ({
  consoleAccountApi: { tokens: f.tokens, calls: f.calls, createToken: f.create, setCalls: f.setCalls },
  ConsoleError: class extends Error {},
}));
vi.mock("../../web/src/components/Toast", () => ({ useToast: () => ({ success: f.success, error: f.error }) }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const accountPath = "../../web/src/components/ConsoleAccount.tsx";
const { AccountPanel } = await import(accountPath);
const props = { scope: "account-test", onCallsChange: vi.fn() };
type Section = "keys" | "security" | undefined;
function ssr(section?: Section): string { return renderToStaticMarkup(React.createElement(AccountPanel, { ...props, section })); }
type Element = { props?: Record<string, any>; type?: unknown };
function nodes(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...nodes(value.props?.children)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text(value.props?.children);
  return value == null || typeof value === "boolean" ? "" : String(value);
}
function harness(onOpenGuide?: () => void) {
  const slots: any[] = []; let cursor = 0; let effects: Array<() => void> = [];
  const same = (a: unknown[], b: unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const dispatcher = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? (next as Function)(slots[i]) : next; }]; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(fn: () => any, deps: unknown[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) {
      const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
    } },
  };
  return {
    render(section: Section = "keys", scope = props.scope, active = true) {
      cursor = 0; effects = [];
      const current = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
      const previous = current.current; current.current = dispatcher;
      let tree; try { tree = AccountPanel({ ...props, scope, section, active, onOpenGuide }); } finally { current.current = previous; }
      for (const effect of effects) effect();
      return tree;
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
const click = (tree: any, label: string) => nodes(tree).find(n => n.props?.onClick && text(n) === label)!.props!.onClick();
function prepareCreate(h: ReturnType<typeof harness>) {
  const tree = h.render();
  nodes(tree).find(n => n.props?.placeholder === "用途备注，例如 ci-runner")!.props!.onChange({ target: { value: "CI" } });
  return click(h.render(), "新建");
}
beforeEach(() => { vi.clearAllMocks(); f.queries.length = 0; f.create.mockResolvedValue({ item: { name: "CI" }, token: "ONE_TIME_SECRET" }); });

describe("AccountPanel section SSR and query enablement (not browser E2E)", () => {
  it("keeps omitted section compatible with the combined panel", () => {
    const html = ssr();
    for (const label of ["账户与 Token", "主 Token 调用", "子 Token", "令牌调用策略与模型范围", "用途备注"]) expect(html).toContain(label);
    expect(f.queries.map(q => q.options)).toEqual([{ ttlMs: 0, enabled: true }, { ttlMs: 0, enabled: true }]);
  });
  it("keys renders existing tokens/policies/groups, not the master calls switch", async () => {
    const html = ssr("keys");
    for (const label of ["API 密钥与 Token", "策略编辑对象", "账户默认", "子 Token · 研发", "子 Token 不会跟随主 Token 的单独设置", "用途备注"]) expect(html).toContain(label);
    expect(html).not.toContain("禁止调用"); expect(html).not.toContain("恢复调用");
    expect(html).not.toContain('value="dead"');
    expect(f.queries.map(q => [q.key, q.options.enabled])).toEqual([["console:account-test:tokens", true], ["console:account-test:calls", false]]);
    await Promise.all(f.queries.filter(q => q.options.enabled).map(q => q.fetcher()));
    expect(f.tokens).toHaveBeenCalledWith(false); expect(f.calls).not.toHaveBeenCalled();
    const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("security renders the existing master switch without token form, list or policy editor", async () => {
    const html = ssr("security");
    for (const label of ["账户安全", "主 Token 调用", "恢复调用", "子 Token 和控制台登录不受影响"]) expect(html).toContain(label);
    for (const label of ["用途备注", "策略编辑对象", "显示已撤销", "研发", "新建"]) expect(html).not.toContain(label);
    expect(f.queries.map(q => q.options.enabled)).toEqual([false, true]);
    await Promise.all(f.queries.filter(q => q.options.enabled).map(q => q.fetcher()));
    expect(f.calls).toHaveBeenCalledOnce(); expect(f.tokens).not.toHaveBeenCalled();
  });
  it("SSR does not eagerly invoke fetchers or expose newly generated plaintext", () => {
    ssr(); ssr("keys"); ssr("security");
    expect(f.tokens).not.toHaveBeenCalled(); expect(f.calls).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    expect(ssr("keys")).not.toContain("ONE_TIME_SECRET");
  });
  it("clears an already displayed secret on security and never restores it on returning", async () => {
    const h = harness(); await prepareCreate(h);
    expect(text(h.render())).toContain("ONE_TIME_SECRET");
    expect(text(h.render("security"))).not.toContain("ONE_TIME_SECRET");
    expect(text(h.render("keys"))).not.toContain("ONE_TIME_SECRET"); h.unmount();
  });
  it("hidden keys retains non-secret drafts but clears plaintext and disables reads", async () => {
    const h = harness(); await prepareCreate(h); expect(text(h.render())).toContain("ONE_TIME_SECRET");
    f.queries.length = 0; expect(text(h.render("keys", props.scope, false))).not.toContain("ONE_TIME_SECRET");
    expect(f.queries.map(q=>q.options.enabled)).toEqual([false,false]);
    expect(text(h.render("keys"))).not.toContain("ONE_TIME_SECRET"); h.unmount();
  });
  it("late response after hidden keys cannot resurrect its one-time secret", async () => {
    let resolve!: (value: unknown) => void; f.create.mockReturnValue(new Promise(r=>{resolve=r;}));
    const h=harness();const pending=prepareCreate(h);h.render("keys",props.scope,false);h.render("keys");
    resolve({item:{name:"CI"},token:"ONE_TIME_SECRET"});await pending;expect(text(h.render())).not.toContain("ONE_TIME_SECRET");h.unmount();
  });
  it("rejects a late create response after keys → security → keys and skips stale refresh", async () => {
    let resolve!: (value: unknown) => void;
    f.create.mockReturnValue(new Promise(r => { resolve = r; }));
    const h = harness(); const pending = prepareCreate(h);
    h.render("security"); h.render("keys");
    resolve({ item: { name: "CI" }, token: "ONE_TIME_SECRET" }); await pending;
    expect(text(h.render())).not.toContain("ONE_TIME_SECRET"); expect(f.refresh).not.toHaveBeenCalled();
    expect(f.success).toHaveBeenCalledWith(expect.stringContaining("明文已清除")); h.unmount();
  });
  it("clears displayed secrets when the account scope changes", async () => {
    const h = harness(); await prepareCreate(h);
    expect(text(h.render())).toContain("ONE_TIME_SECRET");
    expect(text(h.render("keys", "another-account"))).not.toContain("ONE_TIME_SECRET"); h.unmount();
  });
  it("guide callback receives no arguments and clears plaintext before navigation", async () => {
    const guide = vi.fn(); const h = harness(guide); await prepareCreate(h);
    click(h.render(), "前往接入指南"); expect(guide).toHaveBeenCalledWith();
    expect(text(h.render())).not.toContain("ONE_TIME_SECRET"); h.unmount();
  });
  it("keeps guide navigation optional and preserves the save acknowledgement", async () => {
    const h = harness(); await prepareCreate(h); const tree = h.render();
    expect(text(tree)).not.toContain("前往接入指南"); click(tree, "我已保存");
    expect(text(h.render())).not.toContain("ONE_TIME_SECRET"); h.unmount();
  });
});
