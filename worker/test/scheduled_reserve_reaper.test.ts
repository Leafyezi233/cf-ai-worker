import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  CollectingExecutionContext,
  createRealD1,
  holdRows,
  makeEnv,
  makeKv,
  seedDevice,
  seedProvider,
  wallet,
} from "./helpers/realGatewayEnv";


const STALE_MS = 90 * 60 * 1000;

function holdAt(d1: ReturnType<typeof createRealD1>, requestId: string, amount: number, ageMs: number) {
  d1.sql(
    "INSERT INTO reserve_holds (request_id, device_id, amount_usd, created_at) VALUES (?, ?, ?, ?)",
    requestId,
    "dev_1",
    amount,
    Date.now() - ageMs
  );
  d1.sql("UPDATE device_wallets SET reserved_usd = reserved_usd + ? WHERE device_id = ?", amount, "dev_1");
}

async function runScheduled(env: ReturnType<typeof makeEnv>) {
  const exec = new CollectingExecutionContext();
  await (worker as any).scheduled({} as any, env, exec as any);
  await Promise.all(exec.pending);
  return exec;
}

let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the scheduled handler sweeps stale balance reservations", () => {

  it("releases a hold that outlived the one-hour window", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });
    holdAt(d1, "req-stale", 0.25, STALE_MS);
    expect(wallet(d1)!.reserved_usd).toBeCloseTo(0.25, 10);

    const env = makeEnv(d1, makeKv());
    await runScheduled(env);

    expect(holdRows(d1)).toHaveLength(0);
    expect(wallet(d1)!.reserved_usd).toBe(0);
    expect(wallet(d1)!.balance_usd).toBe(1);
  });

  it("leaves a hold that is still inside the window alone", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    await seedDevice(d1, { balance_usd: 1 });
    holdAt(d1, "req-fresh", 0.25, 0);

    const env = makeEnv(d1, makeKv());
    await runScheduled(env);

    expect(holdRows(d1)).toHaveLength(1);
    expect(wallet(d1)!.reserved_usd).toBeCloseTo(0.25, 10);
  });
});
