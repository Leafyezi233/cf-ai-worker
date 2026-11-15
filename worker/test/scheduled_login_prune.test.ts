import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  makeKv,
  seedDevice,
  seedProvider,
} from "./helpers/realGatewayEnv";
import { recordLoginFailure } from "../src/db/repo";


const DAY_MS = 24 * 60 * 60 * 1000;

let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function runScheduled(env: ReturnType<typeof makeEnv>) {
  const exec = new CollectingExecutionContext();
  await (worker as any).scheduled({} as any, env, exec as any);
  await Promise.all(exec.pending);
}

const attemptIps = (d1: ReturnType<typeof createRealD1>) =>
  d1.rows<{ ip: string }>("SELECT ip FROM login_attempts ORDER BY ip").map((r) => r.ip);

describe("the scheduled handler prunes stale login-attempt rows", () => {
  it("drops rows that have not been touched for a day and keeps the rest", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });

    const env = makeEnv(d1, makeKv());
    await recordLoginFailure(env, "old-ip");
    await recordLoginFailure(env, "fresh-ip");
    d1.sql("UPDATE login_attempts SET updated_at = ? WHERE ip = ?", Date.now() - 2 * DAY_MS, "old-ip");

    await runScheduled(env);

    expect(attemptIps(d1)).toEqual(["fresh-ip"]);
  });

  it("keeps a row that is still inside the retention window", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });

    const env = makeEnv(d1, makeKv());
    await recordLoginFailure(env, "recent-ip");
    d1.sql("UPDATE login_attempts SET updated_at = ? WHERE ip = ?", Date.now() - 60 * 1000, "recent-ip");

    await runScheduled(env);

    expect(attemptIps(d1)).toEqual(["recent-ip"]);
  });
});
