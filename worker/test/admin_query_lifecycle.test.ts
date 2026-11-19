import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react");
const queryPath = "../../web/src/hooks/useQuery.ts";
const { useQuery, invalidateCache, getCacheData, setCacheData } = await import(queryPath);

function harness(key: string | null, fetcher: () => Promise<unknown>, options = {}) {
  const slots: any[] = []; let cursor = 0; let effects: (() => void)[] = [];
  const same = (a: unknown[], b: unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const dispatcher = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as Function)() : initial;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? (next as Function)(slots[i]) : next; }]; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn: Function, deps: unknown[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn: () => any, deps: unknown[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) {
      const previous = slots[i]; slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
    } },
  };
  function render(nextKey = key) {
    key = nextKey; cursor = 0; effects = [];
    const current = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = current.current; current.current = dispatcher;
    let result; try { result = useQuery(key, fetcher, options); } finally { current.current = previous; }
    for (const effect of effects) effect();
    return result;
  }
  return { render, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { invalidateCache(); vi.restoreAllMocks(); });
describe("query freshness and concurrent response safety", () => {
  it("configuration opt-in reuses fresh cache; manual refresh still requests", async () => {
    setCacheData("admin", "cached"); const fetcher = vi.fn(async () => "fresh");
    const h = harness("admin", fetcher, { revalidateIfFresh: false });
    const result = h.render(); expect(result.data).toBe("cached"); expect(fetcher).not.toHaveBeenCalled();
    await result.refresh(); expect(fetcher).toHaveBeenCalledOnce(); expect(h.render().data).toBe("fresh"); h.unmount();
  });
  it("expired configuration data is retained while revalidating", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100); setCacheData("admin", "old");
    vi.mocked(Date.now).mockReturnValue(60_101); const pending = deferred<string>();
    const h = harness("admin", () => pending.promise, { revalidateIfFresh: false });
    expect(h.render().data).toBe("old"); expect(h.render().isRefreshing).toBe(true);
    pending.resolve("new"); await tick(); expect(h.render().data).toBe("new"); h.unmount();
  });
  it("default public/live queries still revalidate fresh cached data", async () => {
    setCacheData("console", "old"); const f = vi.fn(async () => "new"); const h = harness("console", f);
    h.render(); await tick(); expect(f).toHaveBeenCalledOnce(); expect(h.render().data).toBe("new"); h.unmount();
  });
  it("a slow earlier refresh cannot overwrite the latest refresh or its cache", async () => {
    setCacheData("admin", "initial"); const a=deferred<string>(), b=deferred<string>();
    const f=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const h=harness("admin", f, { revalidateIfFresh:false }); const r=h.render();
    const first=r.refresh(), second=r.refresh(); b.resolve("newest"); await second; a.resolve("stale"); await first;
    expect(h.render().data).toBe("newest"); expect(getCacheData("admin")).toBe("newest"); h.unmount();
  });
  it("an old error does not replace a later successful response", async () => {
    setCacheData("admin", "initial"); const a=deferred<string>(), b=deferred<string>();
    const f=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const h=harness("admin", f, { revalidateIfFresh:false }); const r=h.render();
    const first=r.refresh().catch(() => {}), second=r.refresh(); b.resolve("newest"); await second;
    a.reject(Error("old failure")); await first; expect(h.render().error).toBeNull(); expect(h.render().data).toBe("newest"); h.unmount();
  });
  it("failed refresh retains old successful data and exposes an error", async () => {
    setCacheData("admin", "old"); const h=harness("admin", async () => { throw Error("unavailable"); }, { revalidateIfFresh:false });
    await expect(h.render().refresh()).rejects.toThrow("unavailable");
    expect(h.render().data).toBe("old"); expect(h.render().error?.message).toBe("unavailable"); h.unmount();
  });
  it("invalidation prevents a pending request from repopulating a removed cache", async () => {
    const a=deferred<string>(); const h=harness("admin", () => a.promise); h.render(); invalidateCache("admin");
    a.resolve("stale"); await tick(); expect(getCacheData("admin")).toBeUndefined(); h.unmount();
  });
  it("disabled query never requests; mutation wins over an older response", async () => {
    const no=vi.fn(async () => "x"); const disabled=harness(null,no); disabled.render(); expect(no).not.toHaveBeenCalled(); disabled.unmount();
    const a=deferred<string>(); const h=harness("admin", () => a.promise); const r=h.render(); r.mutate("saved");
    a.resolve("old"); await tick(); expect(h.render().data).toBe("saved"); expect(getCacheData("admin")).toBe("saved"); h.unmount();
  });
});
