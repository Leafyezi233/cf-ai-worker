import { afterEach, describe, expect, it } from "vitest";
import { consoleApp } from "../src/console";
import { settingsApp } from "../src/admin/settings";
import { createRealD1, seedDevice, makeEnv, TOKEN, type RealD1 } from "./helpers/realGatewayEnv";
import { ANNOUNCEMENT_SETTING_KEY, normalizeAnnouncement } from "../src/utils/announcement";
import type { Env } from "../src/types";


let d1: RealD1 | null = null;

afterEach(() => {
  d1?.close();
  d1 = null;
});

async function setup(): Promise<{ env: Env; d1: RealD1 }> {
  const db = createRealD1();
  d1 = db;
  await seedDevice(db);
  return { env: makeEnv(db), d1: db };
}

function adminReq(method: string, path: string, body?: unknown) {
  return new Request("http://localhost" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function consoleReq(path: string, token = TOKEN) {
  return new Request("https://gw.test" + path, { headers: { Authorization: "Bearer " + token } });
}

describe("announcement editing (admin)", () => {
  it("starts disabled and empty when nothing was ever saved", async () => {
    const { env } = await setup();
    const res = await settingsApp.fetch(adminReq("GET", "/announcement"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      level: "info",
      title: "",
      message: "",
      updated_at: null,
    });
  });

  it("saves and reads back a published notice", async () => {
    const { env } = await setup();
    const put = await settingsApp.fetch(
      adminReq("PUT", "/announcement", {
        enabled: true,
        level: "warning",
        title: "  周六维护  ",
        message: "  02:00-04:00 暂停服务  ",
      }),
      env
    );
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { config: Record<string, unknown> };
    expect(saved.config.title).toBe("周六维护");
    expect(saved.config.message).toBe("02:00-04:00 暂停服务");
    expect(typeof saved.config.updated_at).toBe("number");

    const get = await settingsApp.fetch(adminReq("GET", "/announcement"), env);
    const read = (await get.json()) as Record<string, unknown>;
    expect(read.enabled).toBe(true);
    expect(read.level).toBe("warning");
    expect(read.message).toBe("02:00-04:00 暂停服务");
  });

  it("refuses to publish an empty notice but allows saving a cleared one while disabled", async () => {
    const { env } = await setup();
    const rejected = await settingsApp.fetch(
      adminReq("PUT", "/announcement", { enabled: true, message: "   " }),
      env
    );
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toBe("message_required");

    const ok = await settingsApp.fetch(adminReq("PUT", "/announcement", { enabled: false, message: "" }), env);
    expect(ok.status).toBe(200);
    const read = (await (await settingsApp.fetch(adminReq("GET", "/announcement"), env)).json()) as Record<string, unknown>;
    expect(read.enabled).toBe(false);
    expect(read.message).toBe("");
  });

  it("rejects a notice over the length caps", async () => {
    const { env } = await setup();
    const longTitle = await settingsApp.fetch(
      adminReq("PUT", "/announcement", { enabled: true, message: "hi", title: "x".repeat(121) }),
      env
    );
    expect(longTitle.status).toBe(400);
    expect(((await longTitle.json()) as { error: string }).error).toBe("title_too_long");

    const longMessage = await settingsApp.fetch(
      adminReq("PUT", "/announcement", { enabled: true, message: "x".repeat(2001) }),
      env
    );
    expect(longMessage.status).toBe(400);
    expect(((await longMessage.json()) as { error: string }).error).toBe("message_too_long");
  });

  it("writes an audit row without copying the notice body into it", async () => {
    const { env, d1 } = await setup();
    await settingsApp.fetch(
      adminReq("PUT", "/announcement", { enabled: true, level: "danger", title: "标题", message: "正文内容" }),
      env
    );
    const rows = d1.rows<{ action: string; summary: string; details_json: string | null }>(
      "SELECT action, summary, details_json FROM audit_logs WHERE action = ?",
      "setting.update_announcement"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain("发布");
    expect(rows[0].details_json).not.toContain("正文内容");
    expect(rows[0].details_json).toContain("message_length");
  });
});

describe("announcement display (device console)", () => {
  it("returns the disabled empty state before anything is saved", async () => {
    const { env } = await setup();
    const res = await consoleApp.fetch(consoleReq("/announcement"), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  it("serves exactly what the admin published", async () => {
    const { env } = await setup();
    await settingsApp.fetch(
      adminReq("PUT", "/announcement", { enabled: true, level: "info", title: "T", message: "M" }),
      env
    );
    const res = await consoleApp.fetch(consoleReq("/announcement"), env);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.level).toBe("info");
    expect(body.title).toBe("T");
    expect(body.message).toBe("M");
  });

  it("keeps the retracted text readable after the operator turns it off", async () => {
    const { env } = await setup();
    await settingsApp.fetch(adminReq("PUT", "/announcement", { enabled: true, message: "旧公告" }), env);
    await settingsApp.fetch(adminReq("PUT", "/announcement", { enabled: false, message: "旧公告" }), env);
    const body = (await (await consoleApp.fetch(consoleReq("/announcement"), env)).json()) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.message).toBe("旧公告");
  });

  it("requires a device token", async () => {
    const { env } = await setup();
    const res = await consoleApp.fetch(new Request("https://gw.test/announcement"), env);
    expect(res.status).toBe(401);
  });

  it("does not serve the notice to a disabled device", async () => {
    const db = createRealD1();
    d1 = db;
    await seedDevice(db, { enabled: 0 });
    const env = makeEnv(db);
    db.sql(
      "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)",
      ANNOUNCEMENT_SETTING_KEY,
      JSON.stringify({ enabled: true, level: "info", title: "", message: "M", updated_at: 1 }),
      1
    );
    const res = await consoleApp.fetch(consoleReq("/announcement"), env);
    expect(res.status).toBe(401);
  });
});

describe("announcement normalization", () => {
  it("falls back to info for an unknown level instead of dropping the notice", () => {
    const got = normalizeAnnouncement({ enabled: true, level: "chaos", title: "t", message: "m" });
    expect(got.level).toBe("info");
    expect(got.message).toBe("m");
  });

  it("treats a non-object row as no notice", () => {
    expect(normalizeAnnouncement(null).enabled).toBe(false);
    expect(normalizeAnnouncement("oops").message).toBe("");
    expect(normalizeAnnouncement([1, 2]).message).toBe("");
  });
});
