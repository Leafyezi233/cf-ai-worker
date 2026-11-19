import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { makeWalletFixture } from "./helpers/walletFixture";

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const f = await makeWalletFixture({ deviceIds: ["dev-1", "other"] });
  f.env.SESSION_SECRET = "phase3-local-session";
  const cookie = buildSessionCookie(await signSession(f.env.SESSION_SECRET, 0)).split(";")[0];
  const get = (path: string, authenticated = true) => adminApp.request("https://gateway.test" + path,
    { headers: authenticated ? { cookie } : {} }, f.env);
  const seedTask = (id: string, created: number, status = "pending", device = "dev-1", route = JSON.stringify({ public_model: "video", provider_id: "p", provider_api_key: "SECRET" })) =>
    f.d1.sql("INSERT INTO video_tasks (id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) VALUES (?,?,?,'private-hash',?,?,0,'{}',?,?)",
      id, device, id, status, route, created, created);
  return { ...f, get, seedTask };
}
interface Page { items: { id: string | number }[]; has_more: boolean; next_cursor: string | null; truncated?: boolean; total?: number | null }
const ids = (page: Page) => page.items.map(row => row.id);

describe("phase3 bounded administrator record filters", () => {
  it.each(["{}", "[]", "broken", '{"public_model":null,"provider_id":null}', '{"public_model":false,"provider_id":{"legacy":"value"}}'])("keeps list/export review fields compatible with task detail for legacy route %s", async route => {
    const f = await setup(); f.seedTask("legacy",100,"pending","dev-1", route === "broken" ? "{}" : route);
    if (route === "broken") f.d1.sql("UPDATE video_tasks SET route_json=? WHERE id='legacy'", route);
    const detail = await (await f.get("/video-tasks/legacy")).json();
    for (const path of ["/video-tasks?task_id=legacy", "/video-tasks/export?task_id=legacy"]) {
      const response = await f.get(path); expect(response.status).toBe(200);
      const result = await response.json<{items: unknown[]}>(); expect(result.items).toEqual([detail]);
    }
  });

  it("retains task review defaults, stable tied-time pages and insertion-safe cursor boundaries", async () => {
    const f = await setup();
    f.seedTask("a", 100); f.seedTask("b", 100, "submission_unknown"); f.seedTask("c", 101);
    f.seedTask("done", 90, "succeeded"); f.seedTask("submitting", 80, "submitting");
    const firstResponse = await f.get("/video-tasks?limit=1");
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    const first = await firstResponse.json<Page>(); expect(ids(first)).toEqual(["a"]); expect(first.has_more).toBe(true);
    f.seedTask("new-before", 99);
    const second = await (await f.get("/video-tasks?limit=1&cursor=" + encodeURIComponent(first.next_cursor!))).json<Page>();
    expect(ids(second)).toEqual(["b"]);
    const third = await (await f.get("/video-tasks?limit=1&cursor=" + encodeURIComponent(second.next_cursor!))).json<Page>();
    expect(ids(third)).toEqual(["c"]); expect(third.next_cursor).toBeNull(); expect(third.has_more).toBe(false);
    expect(ids(await (await f.get("/video-tasks?status=all&task_id=done")).json<Page>())).toEqual(["done"]);
  });
  it("applies exact task/status/account/time filters before LIMIT and shares them with bounded export", async () => {
    const f = await setup();
    f.seedTask("wrong-device", 99, "pending", "other"); f.seedTask("wrong-status", 100, "failed");
    f.seedTask("a", 100); f.seedTask("b", 101); f.seedTask("old", 98); f.seedTask("new", 102);
    const conditions = "status=pending&device_id=dev-1&from=100&to=101&limit=1";
    const list = await (await f.get("/video-tasks?" + conditions)).json<Page>();
    const response = await f.get("/video-tasks/export?" + conditions);
    const exported = await response.json<Page>();
    expect(ids(list)).toEqual(["a"]); expect(ids(exported)).toEqual(ids(list));
    expect(exported.truncated).toBe(true); expect(response.headers.get("x-export-truncated")).toBe("true");
    const complete = await (await f.get("/video-tasks/export?" + conditions.replace("limit=1", "limit=2"))).json<Page>();
    expect(ids(complete)).toEqual(["a", "b"]); expect(complete.truncated).toBe(false);
    expect(JSON.stringify(exported)).not.toMatch(/SECRET|private-hash|route_json|pricing_snapshot_json|result_url/);
    f.seedTask("corrupt", 103, "pending", "dev-1", "[]");
    expect((await f.get("/video-tasks?task_id=corrupt")).status).toBe(200);
    expect(ids(await (await f.get("/video-tasks?task_id=" + encodeURIComponent("x'OR'1'='1"))).json<Page>())).toEqual([]);
  });
  it.each(["limit=0", "limit=-1", "limit=201", "limit=NaN", "limit=1.5", "from=2&to=1", "from=0&to=2764800000", "from=100", "to=Infinity", "status=nope", "cursor=bad", "device_id=%00"])("rejects invalid task filters %s", async query => {
    const f = await setup();
    expect((await f.get("/video-tasks?" + query)).status).toBe(400);
  });
  it("rejects cross-filter task cursors and oversized exports", async () => {
    const f = await setup(); f.seedTask("a", 100); f.seedTask("b", 101);
    const first = await (await f.get("/video-tasks?limit=1")).json<Page>();
    expect((await f.get("/video-tasks?status=all&cursor=" + encodeURIComponent(first.next_cursor!))).status).toBe(400);
    expect((await f.get("/video-tasks/export?limit=1001")).status).toBe(400);
  });
  it("requires parent authentication for list and export; bearer devices do not become admins", async () => {
    const f = await setup();
    for (const path of ["/video-tasks", "/video-tasks/export", "/audit-logs", "/audit-logs/export"]) {
      expect((await f.get(path, false)).status).toBe(401);
      expect((await adminApp.request("https://gateway.test" + path, { headers: { authorization: "Bearer dev-1" } }, f.env)).status).toBe(401);
    }
  });
  it("retains the admin IP whitelist for record lists and exports", async () => {
    const f = await setup();
    f.d1.sql("INSERT INTO settings (key, value_json, updated_at) VALUES ('ip_whitelist_config', ?, 1)",
      JSON.stringify({ enabled: true, allowed_ips: ["203.0.113.9"] }));
    for (const path of ["/video-tasks", "/video-tasks/export", "/audit-logs", "/audit-logs/export"])
      expect((await f.get(path)).status).toBe(403);
  });
  it("uses one projected bounded task SELECT with no count, wildcard, offset or gateway fanout", async () => {
    const f = await setup(); f.seedTask("a", 100);
    const spy = vi.spyOn(f.env.DB, "prepare");
    expect((await f.get("/video-tasks?device_id=dev-1&status=pending&limit=20")).status).toBe(200);
    const queries = spy.mock.calls.map(call => String(call[0])).filter(sql => /FROM video_tasks/i.test(sql));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("device_id = ?"); expect(queries[0]).toContain("status = ?");
    expect(queries[0]).toContain("ORDER BY created_at ASC, id ASC LIMIT ?");
    expect(queries[0]).not.toMatch(/SELECT \*|COUNT\(|OFFSET|LIKE/i);
    const plan = f.d1.rows<{ detail: string }>("EXPLAIN QUERY PLAN " + queries[0], 0, 8640000000000000, "pending", "dev-1", 21);
    expect(plan.map(row => row.detail).join(" ")).toMatch(/SEARCH video_tasks USING INDEX idx_video_tasks_device_created_id/);
    const source = readFileSync(new URL("../src/admin/video-tasks.ts", import.meta.url), "utf8");
    expect(source).not.toContain("fetch("); expect(source).not.toContain("setInterval");
  });
});
