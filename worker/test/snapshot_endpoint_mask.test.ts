import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";
const SNAP_ID = "snap_1";

function makeEnv(d1: ReturnType<typeof createRealD1>): Env {
  return {
    DB: d1.DB,
    ASSETS: { fetch: async () => new Response("assets") } as any,
    ADMIN_SECRET: "admin-password",
    SESSION_SECRET: SECRET,
  } as unknown as Env;
}

const PAYLOAD = {
  exported_at: 1,
  providers: [{ id: "prov_1", name: "Alpha", api_key: "enc:v1:iv.cipher" }],
  models: [{ id: "model_1", model_name: "gpt-x", provider_api_key: "enc:v1:iv.cipher" }],
  settings: { budget_config: null, webhook_config: null, ip_whitelist_config: null },
};

async function seed(d1: ReturnType<typeof createRealD1>) {
  d1.sql(
    "INSERT INTO config_snapshots (id, name, description, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)",
    SNAP_ID,
    "snap",
    "desc",
    JSON.stringify(PAYLOAD),
    Date.now()
  );
}

async function getSnapshot(env: Env) {
  const token = await signSession(SECRET, 0);
  const res = await adminApp.fetch(
    new Request(`http://localhost/settings/snapshots/${SNAP_ID}`, {
      method: "GET",
      headers: { cookie: buildSessionCookie(token).split(";")[0], "cf-connecting-ip": "203.0.113.9" },
    }),
    env
  );
  return { status: res.status, body: (await res.json()) as any };
}

describe("GET /settings/snapshots/:id must not return usable credentials", () => {
  it("replaces every stored credential with a marker", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await seed(d1);

    const { status, body } = await getSnapshot(env);
    expect(status).toBe(200);
    expect(body.secrets_masked).toBe(true);
    expect(body.snapshot_json.providers[0].api_key).toBe("***");
    expect(body.snapshot_json.models[0].provider_api_key).toBe("***");
    expect(JSON.stringify(body)).not.toContain("enc:v1:");
    d1.close();
  });

  it("leaves the stored row intact so a rollback still restores working keys", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await seed(d1);

    await getSnapshot(env);

    const stored = d1.row<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM config_snapshots WHERE id = ?",
      SNAP_ID
    );
    expect(stored!.snapshot_json).toContain("enc:v1:iv.cipher");
    d1.close();
  });

  it("keeps the non-secret parts of the snapshot readable", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await seed(d1);

    const { body } = await getSnapshot(env);
    expect(body.snapshot_json.providers[0].name).toBe("Alpha");
    expect(body.snapshot_json.models[0].model_name).toBe("gpt-x");
    expect(body.snapshot_json.exported_at).toBe(1);
    d1.close();
  });

  it("requires a session before it answers at all", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await seed(d1);

    const res = await adminApp.fetch(
      new Request(`http://localhost/settings/snapshots/${SNAP_ID}`, {
        method: "GET",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env
    );
    expect(res.status).toBe(401);
    d1.close();
  });
});
