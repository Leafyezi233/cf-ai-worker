import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const mock = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../../web/src/api/client", () => ({ api: { post: mock.post }, ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } } }));
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const componentPath = "../../web/src/components/ModelGroupMergePanel.tsx";
const { ModelGroupMergePanel } = await import(componentPath);
const apiPath = "../../web/src/api/client";
const { ApiError } = await import(apiPath);
const groups = [{ id: "s", name: "Source" }, { id: "t", name: "Target" }, { id: "u", name: "Other" }];
const result = (can_commit = true) => ({ fingerprint: "fingerprint", can_commit, blockers: can_commit ? [] : [{ code: "device_group_reference", message: "unsafe account permission" }], source: groups[0], target: groups[1],
  references: { aliases: [{ name: "old-public" }], policies: [{ token_id: "master" }] }, comparison: { source: { unit: "token", prices: { input_price_per_m: 9 } }, target: { unit: "token", prices: { input_price_per_m: 1 } }, merged_members: [{ model_id: "member" }] },
  mapping_changes: [{ id: "mapping", new_pricing_json: "independent full quote" }], legacy: { description: "retained tombstone, no deletion", source_remains: true, pool_changes: false }, warnings: ["no public price merge"] });

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
    if (typeof element.type === "function" && element.type.name === "JsonDetails") return text(element.type(element.props));
    return text(element.props?.children);
  }
  return node == null || typeof node === "boolean" ? "" : String(node);
}
function harness() {
  const slots: any[] = [], cleanups: (() => void)[] = [];
  let index = 0, effects: (() => void)[] = [], dirty = false;
  const onChanged = vi.fn(async () => {});
  let props = { groups, onChanged }, tree: unknown;
  const dispatcher = {
    useState(initial: unknown) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [slots[i], (value: any) => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial: unknown) { const i = index++; return slots[i] ||= { current: initial }; },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) { const i = index++; if (!slots[i] || deps.some((dep, n) => !Object.is(dep, slots[i][n]))) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); const cleanup = effect(); cleanups[i] = typeof cleanup === "function" ? cleanup : () => {}; }); } },
  };
  function render() {
    let rounds = 0;
    do {
      if (++rounds > 15) throw new Error("Hook harness render loop");
      dirty = false; index = 0;
      const internal = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
      const previous = internal.current; internal.current = dispatcher;
      try { tree = ModelGroupMergePanel(props); } finally { internal.current = previous; }
      const pending = effects; effects = []; pending.forEach(effect => effect());
    } while (dirty);
    return tree;
  }
  function select(position: number, value: string) { nodes(tree).filter(node => node.type === "select")[position].props!.onChange({ target: { value } }); render(); }
  function button(label: string) { return nodes(tree).find(node => node.props?.onClick && text(node).includes(label))!; }
  function check(position: number, checked = true) { nodes(tree).filter(node => node.type === "input" && node.props?.type === "checkbox")[position].props!.onChange({ target: { checked } }); render(); }
  function name(value = "Target") { nodes(tree).find(node => node.props?.["aria-label"] === "确认目标组名称")!.props!.onChange({ target: { value } }); render(); }
  function choose() { select(0, "s"); select(1, "t"); select(2, "disable"); }
  async function load(can = true) { mock.post.mockResolvedValueOnce(result(can)); await button("只读预览").props!.onClick(); render(); }
  function updateGroups(next: typeof groups) { props = { ...props, groups: next }; render(); }
  render();
  return { render, select, choose, button, check, name, load, updateGroups, onChanged, text: () => text(tree), unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("merge wizard real component hook/event contract (no browser DOM)", () => {
  it("requires explicit old-name choice before even the read-only request", async () => {
    const h = harness(); expect(h.button("只读预览").props!.disabled).toBe(true);
    h.select(0, "s"); h.select(1, "t");
    await h.button("只读预览").props!.onClick(); expect(mock.post).not.toHaveBeenCalled();
    h.select(2, "retain"); expect(h.text()).toContain("内部成员池也会扩大");
    expect(h.button("只读预览").props!.disabled).toBe(false);
    h.unmount();
  });
  it("shows full references/prices and needs both confirmations plus exact target name", async () => {
    const h = harness(); h.choose(); await h.load();
    expect(mock.post).toHaveBeenCalledWith("/api/model-group-merge/preview", { source_id: "s", target_id: "t", legacy_action: "disable" });
    expect(h.text()).toContain("old-public"); expect(h.text()).toContain("independent full quote"); expect(h.text()).toContain("master");
    expect(h.button("确认并原子迁移").props!.disabled).toBe(true);
    h.check(0); h.name(); expect(h.button("确认并原子迁移").props!.disabled).toBe(true);
    h.check(1); h.name("wrong"); expect(h.button("确认并原子迁移").props!.disabled).toBe(true);
    h.name(); expect(h.button("确认并原子迁移").props!.disabled).toBe(false);
    mock.post.mockResolvedValueOnce({ ok: true }); await h.button("确认并原子迁移").props!.onClick(); h.render();
    expect(mock.post).toHaveBeenLastCalledWith("/api/model-group-merge/commit", { source_id: "s", target_id: "t", legacy_action: "disable", fingerprint: "fingerprint", confirm_prices: true, confirm_permissions: true });
    expect(h.onChanged).toHaveBeenCalledOnce(); expect(h.text()).toContain("原子合并"); h.unmount();
  });
  it("a blocked preview explains the blocker and cannot invoke commit even through its handler", async () => {
    const h = harness(); h.choose(); await h.load(false); h.check(0); h.check(1); h.name();
    expect(h.text()).toContain("unsafe account permission"); expect(h.text()).toContain("禁止提交");
    expect(h.button("确认并原子迁移").props!.disabled).toBe(true);
    await h.button("确认并原子迁移").props!.onClick(); expect(mock.post).toHaveBeenCalledTimes(1); h.unmount();
  });
  it("409 clears the stale preview/confirmations and requires a new review", async () => {
    const h = harness(); h.choose(); await h.load(); h.check(0); h.check(1); h.name();
    mock.post.mockRejectedValueOnce(new ApiError("snapshot changed", 409)); await h.button("确认并原子迁移").props!.onClick(); h.render();
    expect(h.text()).toContain("请重新预览并确认"); expect(h.text()).not.toContain("5. 显式确认"); expect(h.onChanged).not.toHaveBeenCalled();
    await h.load(); expect(h.button("确认并原子迁移").props!.disabled).toBe(true); h.unmount();
  });
  it("selection changes discard reviewed confirmations and stale in-flight preview results", async () => {
    const h = harness(); h.choose(); await h.load(); h.check(0); h.check(1); h.name(); h.select(1, "u");
    expect(h.text()).not.toContain("5. 显式确认");
    const pending = deferred<ReturnType<typeof result>>(); mock.post.mockReturnValueOnce(pending.promise);
    const request = h.button("只读预览").props!.onClick(); h.render();
    h.updateGroups(groups.map(group => ({ ...group, name: group.name + " updated" })));
    pending.resolve(result()); await request; h.render();
    expect(h.text()).not.toContain("independent full quote"); expect(h.button("只读预览").props!.disabled).toBe(false); h.unmount();
  });
  it("prop updates do not unlock a pending commit, but completion always unlocks it", async () => {
    const h = harness(); h.choose(); await h.load(); h.check(0); h.check(1); h.name();
    const pending = deferred<unknown>(); mock.post.mockReturnValueOnce(pending.promise);
    const request = h.button("确认并原子迁移").props!.onClick(); h.render();
    h.updateGroups(groups.map(group => ({ ...group, name: group.name + " updated" })));
    expect(h.button("只读预览").props!.disabled).toBe(true);
    pending.resolve({ ok: true }); await request; h.render();
    expect(h.button("只读预览").props!.disabled).toBe(false); expect(h.onChanged).toHaveBeenCalledOnce(); h.unmount();
  });
});
