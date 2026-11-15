import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { bumpSessionEpoch } from "../src/db/repo";
import { createRealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";


const SECRET = "session-signing-secret";

function makeEnv(d1: ReturnType<typeof createRealD1>): Env {
  return {
    DB: d1.DB,
    ASSETS: { fetch: async () => new Response("assets") } as any,
    ADMIN_SECRET: "admin-password",
    SESSION_SECRET: SECRET,
  } as unknown as Env;
}

const get = (env: Env, cookie: string) =>
  adminApp.fetch(
    new Request("http://localhost/settings", {
      method: "GET",
      headers: { cookie, "cf-connecting-ip": "203.0.113.5" },
    }),
    env
  );

describe("admin session revocation", () => {
  it("accepts a cookie signed at the current epoch", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const token = await signSession(SECRET, await Promise.resolve(0));
    const res = await get(env, buildSessionCookie(token).split(";")[0]);
    expect(res.status).toBe(200);
    d1.close();
  });

  it("rejects a still-valid cookie after the epoch is bumped", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const token = await signSession(SECRET, 0);
    const cookie = buildSessionCookie(token).split(";")[0];

    expect((await get(env, cookie)).status).toBe(200);
    await bumpSessionEpoch(env);
    expect((await get(env, cookie)).status).toBe(401);
    d1.close();
  });

  it("accepts a cookie re-signed at the new epoch", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    await bumpSessionEpoch(env);
    const token = await signSession(SECRET, 1);
    const res = await get(env, buildSessionCookie(token).split(";")[0]);
    expect(res.status).toBe(200);
    d1.close();
  });

  it("treats a payload without an epoch as epoch 0", async () => {
    const d1 = createRealD1();
    const env = makeEnv(d1);
    const token = await signSession(SECRET);
    expect((await get(env, buildSessionCookie(token).split(";")[0])).status).toBe(200);
    await bumpSessionEpoch(env);
    expect((await get(env, buildSessionCookie(token).split(";")[0])).status).toBe(401);
    d1.close();
  });
});
