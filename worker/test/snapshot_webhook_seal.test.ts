import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createConfigSnapshot, getSetting, restoreConfigSnapshot, setSetting } from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";
const ENC_KEY = "encryption-key";

function makeEnv(d1: RealD1, extras: Record<string, unknown> = {}): Env {
  return {
    DB: d1.DB,
    ASSETS: { fetch: async () => new Response("assets") } as any,
    ADMIN_SECRET: "admin-password",
    SESSION_SECRET: SECRET,
    ENCRYPTION_KEY: ENC_KEY,
    ...extras,
  } as unknown as Env;
}

async function getSnapshotRoute(env: Env, id: string) {
  const token = await signSession(SECRET, 0);
  const url = "http://localhost/settings/snapshots/" + id;
  const res = await adminApp.fetch(
    new Request(url, {
      headers: {
        cookie: buildSessionCookie(token).split(";")[0],
        "cf-connecting-ip": "203.0.113.9",
      },
    }),
    env
  );
  return { status: res.status, body: (await res.json()) as any };
}

function webhookSetting(d1: RealD1) {
  const row = d1.row<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", "webhook_config");
  return row ? JSON.parse(row.value_json) : null;
}
const PLAINTEXT = "whsec_test_signing_key_123";

describe("a config snapshot seals the webhook signing key", () => {
  it("stores ciphertext, never the secret, in snapshot_json", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "webhook_config", { url: "https://hook.example/x", secret: PLAINTEXT, enabled: true });

    const snap = await createConfigSnapshot(env, "before change");

    const stored = d1.row<{ snapshot_json: string }>("SELECT snapshot_json FROM config_snapshots WHERE id = ?", snap.id)!;
    expect(stored.snapshot_json).not.toContain(PLAINTEXT);
    const parsed = JSON.parse(stored.snapshot_json);
    expect(parsed.settings.webhook_config.secret.startsWith("enc:v1:")).toBe(true);
    expect(parsed.settings.webhook_config.secret).not.toBe(PLAINTEXT);
    expect(parsed.settings.webhook_config.url).toBe("https://hook.example/x");
    expect(parsed.settings.webhook_config.enabled).toBe(true);
  });

  it("masks the secret on the admin read path", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "webhook_config", { url: "https://hook.example/x", secret: PLAINTEXT, enabled: true });
    const snap = await createConfigSnapshot(env, "masked");

    const { status, body } = await getSnapshotRoute(env, snap.id);
    expect(status).toBe(200);
    expect(body.snapshot_json.settings.webhook_config.secret).toBe("***");
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(body)).not.toContain("enc:v1:");
    expect(body.snapshot_json.settings.webhook_config.url).toBe("https://hook.example/x");
    expect(body.secrets_masked).toBe(true);
  });

  it("opens the secret again on rollback, because the sender needs plaintext", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "webhook_config", { url: "https://hook.example/x", secret: PLAINTEXT, enabled: true });
    const snap = await createConfigSnapshot(env, "rollback target");

    await setSetting(env, "webhook_config", { url: "https://hook.example/y", secret: "other-key", enabled: false });
    const res = await restoreConfigSnapshot(env, snap.id);
    expect(res.success).toBe(true);

    const restored = webhookSetting(d1);
    expect(restored.url).toBe("https://hook.example/x");
    expect(restored.enabled).toBe(true);
    expect(restored.secret).toBe(PLAINTEXT);
    expect(restored.secret.startsWith("enc:v1:")).toBe(false);
    const viaGetter = await getSetting<{ secret: string }>(env, "webhook_config");
    expect(viaGetter!.secret).toBe(PLAINTEXT);
  });

  it("still snapshots a secret-less webhook on a Worker with no ENCRYPTION_KEY", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1, { ENCRYPTION_KEY: undefined });
    await setSetting(env, "webhook_config", { url: "https://hook.example/x", enabled: true });

    const snap = await createConfigSnapshot(env, "keyless");
    const stored = d1.row<{ snapshot_json: string }>("SELECT snapshot_json FROM config_snapshots WHERE id = ?", snap.id)!;
    const parsed = JSON.parse(stored.snapshot_json);
    expect(parsed.settings.webhook_config.url).toBe("https://hook.example/x");
    expect(parsed.settings.webhook_config.secret ?? null).toBeNull();
  });

  it("refuses to snapshot a real secret when there is no key to seal it with", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1, { ENCRYPTION_KEY: undefined });
    await setSetting(env, "webhook_config", { url: "https://hook.example/x", secret: PLAINTEXT, enabled: true });

    await expect(createConfigSnapshot(env, "must fail")).rejects.toThrow(/ENCRYPTION_KEY is not configured/);
    expect(d1.rows("SELECT id FROM config_snapshots")).toHaveLength(0);
  });
});

async function postSnapshotRoute(env: Env, name = "created") {
  const token = await signSession(SECRET, 0);
  const res = await adminApp.fetch(
    new Request("http://localhost/settings/snapshots", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: buildSessionCookie(token).split(";")[0],
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify({ name }),
    }),
    env
  );
  return { status: res.status, body: (await res.json()) as any };
}

describe("creating a snapshot masks the response the same way reading it does", () => {
  it("never returns the signing key or the ciphertext to the browser", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "webhook_config", { url: "https://hook.example/x", secret: PLAINTEXT, enabled: true });

    const { status, body } = await postSnapshotRoute(env);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.snapshot.snapshot_json.settings.webhook_config.secret).toBe("***");
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(body)).not.toContain("enc:v1:");
    expect(body.snapshot.snapshot_json.settings.webhook_config.url).toBe("https://hook.example/x");
    expect(body.snapshot.name).toBe("created");
  });

  it("still stores the sealed value, so a later rollback works", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await setSetting(env, "webhook_config", { url: "https://hook.example/x", secret: PLAINTEXT, enabled: true });

    const { body } = await postSnapshotRoute(env, "for rollback");
    const stored = d1.row<{ snapshot_json: string }>("SELECT snapshot_json FROM config_snapshots WHERE id = ?", body.snapshot.id)!;
    expect(stored.snapshot_json).toContain("enc:v1:");
    expect(stored.snapshot_json).not.toContain(PLAINTEXT);
  });
});
