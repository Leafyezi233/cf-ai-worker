import { afterEach, expect, it, vi } from "vitest";
import { makeWalletFixture } from "./helpers/walletFixture";
import { videoTasksApp } from "../src/admin/video-tasks";

afterEach(() => vi.restoreAllMocks());

it("uses strict bounded attention filters while normal list/export keep the 31-day cap", async () => {
  const { d1, env } = await makeWalletFixture();
  const now = Date.UTC(2026, 10, 19, 12);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const seed = (id: string, status: string, created: number) => d1.sql(
    "INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) VALUES(?,'dev-1',?,'hash',?,'{}',0,'{}',?,?)",
    id, id, status, created, created);
  seed("old-40d", "pending", now - 40 * 86400000);
  seed("new-5m", "pending", now - 5 * 60000);
  seed("old-failed", "failed", now - 40 * 86400000);
  const cutoff = now - 30 * 60000;
  seed("exact-cutoff", "pending", cutoff);
  const request = (path: string) => videoTasksApp.request("https://local.test" + path, {}, env);
  const attention = await request("/?list_task_attention_before=" + cutoff + "&limit=1");
  expect(attention.status).toBe(200);
  const page = await attention.json<{ items: { id: string }[]; has_more: boolean; next_cursor: string }>();
  expect(page.items.map(x => x.id)).toEqual(["old-40d"]);
  expect(page.has_more).toBe(false);
  expect(JSON.stringify(page)).not.toContain("new-5m");
  const alias = await request("/?attention_before=" + cutoff);
  expect((await alias.json<{items:{id:string}[]}>()).items.map(x=>x.id)).toEqual(["old-40d"]);
  for (const path of ["/?list_task_attention_before="+cutoff+"&from=0", "/?list_task_attention_before="+cutoff+"&status=pending", "/?list_task_attention_before="+cutoff+"&attention_before=1", "/?list_task_attention_before=1.5", "/?list_task_attention_before="+(now-1000)])
    expect((await request(path)).status).toBe(400);
  const ordinary = await request("/?from=0&to=" + (32 * 86400000));
  expect(ordinary.status).toBe(400);
  expect((await request("/export?from=0&to=" + (32 * 86400000))).status).toBe(400);
});

it("binds attention cursor to the complete cutoff and mode", async () => {
  const { d1, env } = await makeWalletFixture();
  const now = Date.UTC(2026, 10, 19, 12), cutoff = now - 30 * 60000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (let i=0;i<3;i++) d1.sql("INSERT INTO video_tasks(id,device_id,idempotency_key,request_hash,status,route_json,price_usd,pricing_snapshot_json,created_at,updated_at) VALUES(?, 'dev-1', ?, 'hash', 'pending','{}',0,'{}',?,?)", "task-"+i,"task-"+i,now-4000000+i,now-4000000+i);
  const first = await videoTasksApp.request("https://local.test/?attention_before="+cutoff+"&limit=1",{},env);
  const cursor=(await first.json<{next_cursor:string}>()).next_cursor;
  expect(cursor).toBeTruthy();
  expect((await videoTasksApp.request("https://local.test/?attention_before="+(cutoff-1)+"&limit=1&cursor="+encodeURIComponent(cursor),{},env)).status).toBe(400);
  expect((await videoTasksApp.request("https://local.test/?from=0&to="+cutoff+"&limit=1&cursor="+encodeURIComponent(cursor),{},env)).status).toBe(400);
});
