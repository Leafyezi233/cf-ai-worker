import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  makeKv,
  seedProvider,
} from "./helpers/realGatewayEnv";


let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

async function runScheduled(env: ReturnType<typeof makeEnv>) {
  const exec = new CollectingExecutionContext();
  await (worker as any).scheduled({} as any, env, exec as any);
  await Promise.all(exec.pending);
  return exec;
}

function healthMap(d1: ReturnType<typeof createRealD1>): Record<string, any> {
  const rows = d1.rows<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM settings WHERE key LIKE 'provider_health%'"
  );
  const out: Record<string, any> = {};
  for (const row of rows) {
    const id = row.key.replace(/^provider_health:/, "");
    if (id === "provider_health_map") continue;
    out[id] = JSON.parse(row.value_json);
  }
  return out;
}

describe("the scheduled handler pings every enabled provider", () => {
  it("records a health entry for each provider, not just the last one to answer", async () => {
    const d1 = createRealD1();
    for (const id of ["prov_a", "prov_b", "prov_c"]) {
      seedProvider(d1, { id, name: id, endpoint: `https://${id}.example/v1` });
    }
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    await runScheduled(makeEnv(d1, makeKv()));

    const map = healthMap(d1);
    expect(Object.keys(map).sort()).toEqual(["prov_a", "prov_b", "prov_c"]);
    for (const id of ["prov_a", "prov_b", "prov_c"]) {
      expect(map[id].status).toBe("healthy");
      expect(map[id].status_code).toBe(200);
    }
    expect(calls).toHaveLength(3);
    expect(calls.some((u) => u.startsWith("https://prov_a.example/v1/models"))).toBe(true);
    expect(calls.some((u) => u.startsWith("https://prov_b.example/v1/models"))).toBe(true);
    expect(calls.some((u) => u.startsWith("https://prov_c.example/v1/models"))).toBe(true);
  });

  it("does not ping a disabled provider", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_on", name: "on", endpoint: "https://on.example/v1" });
    seedProvider(d1, { id: "prov_off", name: "off", endpoint: "https://off.example/v1" });
    d1.sql("UPDATE providers SET enabled = 0 WHERE id = ?", "prov_off");
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    await runScheduled(makeEnv(d1, makeKv()));

    expect(calls).toHaveLength(1);
    expect(Object.keys(healthMap(d1))).toEqual(["prov_on"]);
  });

  it("records an unhealthy provider when its upstream answers with an error", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "A", endpoint: "https://a.example/v1" });
    stubFetch(() => new Response("nope", { status: 503 }));

    await runScheduled(makeEnv(d1, makeKv()));

    const entry = healthMap(d1).prov_a;
    expect(entry.status).toBe("unhealthy");
    expect(entry.status_code).toBe(503);
    expect(String(entry.message)).toContain("503");
  });

  it("records an unhealthy provider when the network call throws", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "A", endpoint: "https://a.example/v1" });
    globalThis.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND a.example");
    }) as unknown as typeof globalThis.fetch;

    await runScheduled(makeEnv(d1, makeKv()));

    const entry = healthMap(d1).prov_a;
    expect(entry.status).toBe("unhealthy");
    expect(String(entry.message)).toContain("ENOTFOUND");
  });

  it("reports a provider with no API key without touching the network", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "A", api_key: null });
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    await runScheduled(makeEnv(d1, makeKv()));

    expect(calls).toHaveLength(0);
    const entry = healthMap(d1).prov_a;
    expect(entry.status).toBe("unhealthy");
    expect(String(entry.message)).toContain("API Key");
  });
});
