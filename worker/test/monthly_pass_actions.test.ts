import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const helperPath = "../../web/src/api/monthlyPassActions.ts";
const { runMonthlyAction, readPendingMonthlyAction } = await import(helperPath);
let values: Map<string,string>;
let fetchMock: ReturnType<typeof vi.fn>;
const ok = () => new Response(JSON.stringify({ item: { id: "s1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.stubGlobal("window", { location: { pathname: "/admin-prefix-example/monthly-passes" } });
  values = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string,v: string) => values.set(k,v), removeItem: (k: string) => values.delete(k) });
  fetchMock = vi.fn(async () => ok()); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe("monthly management UI commit/retry state (pure controller, no browser E2E)", () => {
  it("does not turn committed renewal into failure when follow-up GET fails", async () => {
    const refresh = vi.fn(async () => { throw new Error("offline"); });
    const result = await runMonthlyAction("a", {kind:"renew",subscriptionId:"s1"}, refresh);
    expect(result.status).toBe("committed"); expect(result.refreshError).toContain("操作已成功");
    expect(readPendingMonthlyAction("a")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retries network-unknown renewal with the same persisted key even after reloading helper state", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network lost after commit"));
    const request = {kind:"renew",subscriptionId:"s1"};
    expect((await runMonthlyAction("a", request, async()=>{})).status).toBe("unknown");
    const pending = readPendingMonthlyAction("a"); expect(pending.action).toEqual(request);
    expect((await runMonthlyAction("a", pending.action, async()=>{})).status).toBe("committed");
    const keys = fetchMock.mock.calls.map(([,init]) => JSON.parse(init.body).operation_id);
    expect(keys[0]).toBe(keys[1]); expect(readPendingMonthlyAction("a")).toBeNull();
  });
  it("preserves 500 unknown result and forbids issuing a different plan/action while unresolved", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:"storage_error"}),{status:500}));
    expect((await runMonthlyAction("a",{kind:"issue",planId:"p1"},async()=>{})).status).toBe("unknown");
    const retry=await runMonthlyAction("a",{kind:"issue",planId:"p2"},async()=>{});
    expect(retry.status).toBe("rejected"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("isolates pending operation by account and sends operation_id for issue", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await runMonthlyAction("a",{kind:"issue",planId:"p1"},async()=>{});
    expect(readPendingMonthlyAction("b")).toBeNull();
    await runMonthlyAction("b",{kind:"issue",planId:"p1"},async()=>{});
    const a=JSON.parse(fetchMock.mock.calls[0][1].body),b=JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(a.plan_id).toBe("p1");expect(a.operation_id).not.toBe(b.operation_id);
  });
  it("generates a new key only for a new action after prior success", async () => {
    await runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{});
    await runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).operation_id).not.toBe(JSON.parse(fetchMock.mock.calls[1][1].body).operation_id);
  });
  it("releases pending intent on definitive 409 without pretending success", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:"monthly_subscription_not_current"}),{status:409}));
    expect((await runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{})).status).toBe("rejected");
    expect(readPendingMonthlyAction("a")).toBeNull();
  });
  it("fails closed before dispatch when durable tab receipt cannot be saved", async () => {
    vi.stubGlobal("sessionStorage",{getItem:()=>null,setItem:()=>{throw new Error("denied");}});
    expect((await runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{})).status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not discard a corrupt receipt and submit a new mutation", async () => {
    values.set("admin:monthly-pending:a","{}");
    expect((await runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{})).status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401,403,429,400,404])("keeps the original unknown key across pre-operation HTTP %i then login/retry", async status => {
    fetchMock.mockRejectedValueOnce(new Error("commit response lost"));
    const request={kind:"renew",subscriptionId:"s1"};
    expect((await runMonthlyAction("a",request,async()=>{})).status).toBe("unknown");
    const original=readPendingMonthlyAction("a");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error:"gateway_denial"}),{status}));
    expect((await runMonthlyAction("a",request,async()=>{})).status).toBe("unknown");
    expect(readPendingMonthlyAction("a")).toEqual(original);
    expect((await runMonthlyAction("a",request,async()=>{})).status).toBe("committed");
    expect(new Set(fetchMock.mock.calls.map(([,init])=>JSON.parse(init.body).operation_id)).size).toBe(1);
  });
  it("replays a captured remount receipt even when the original request succeeded and cleared storage", async()=>{
    let resolve!: (r: Response)=>void;fetchMock.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;}));
    const request={kind:"renew",subscriptionId:"s1"};
    const first=runMonthlyAction("a",request,async()=>{});
    const remountedReceipt=readPendingMonthlyAction("a");  
    expect(remountedReceipt).not.toBeNull();resolve(ok());expect((await first).status).toBe("committed");
    expect(readPendingMonthlyAction("a")).toBeNull();
    expect((await runMonthlyAction("a",remountedReceipt.action,async()=>{},remountedReceipt)).status).toBe("committed");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).operation_id).toBe(JSON.parse(fetchMock.mock.calls[1][1].body).operation_id);
  });
  it("does not overwrite a newer intent with a stale remount receipt",async()=>{
    fetchMock.mockRejectedValueOnce(new Error("lost"));await runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{});
    const current=readPendingMonthlyAction("a");
    const result=await runMonthlyAction("a",current.action,async()=>{},{...current,operationId:"stale"});
    expect(result.status).toBe("rejected");expect(readPendingMonthlyAction("a")).toEqual(current);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects concurrent click before the first submission returns", async () => {
    let resolve!: (r: Response)=>void; fetchMock.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;}));
    const first=runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{});
    expect((await runMonthlyAction("a",{kind:"renew",subscriptionId:"s1"},async()=>{})).status).toBe("rejected");
    resolve(ok()); expect((await first).status).toBe("committed");expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
