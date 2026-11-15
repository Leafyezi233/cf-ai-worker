import { afterEach, describe, expect, it } from "vitest";
import { gatewayApp } from "../src/gateway/index";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import {
  TOKEN,
  makeEnv,
  seedDevice,
  seedGroup,
  seedGroupMembers,
  seedModel,
  seedProvider,
} from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


function seedBase(d1: RealD1): void {
  seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai" });
  seedProvider(d1, { id: "prov_b", name: "Provider B", type: "openai" });
  seedModel(d1, { id: "model_a", model_name: "gw-primary", provider_id: "prov_a" });
  seedModel(d1, { id: "model_b", model_name: "gw-backup", provider_id: "prov_b" });
}

async function listModels(env: Env): Promise<any[]> {
  const res = await gatewayApp.request(
    "http://gw.test/models",
    { headers: { Authorization: "Bearer " + TOKEN } },
    env
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return body.data;
}

async function getModel(env: Env, id: string): Promise<any> {
  const res = await gatewayApp.request(
    "http://gw.test/models/" + encodeURIComponent(id),
    { headers: { Authorization: "Bearer " + TOKEN } },
    env
  );
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("the reasoning ladder is discoverable on /v1/models", () => {
  it("publishes the default five-rung ladder for a group with no config", async () => {
    const d1 = createRealD1();
    seedBase(d1);
    seedGroup(d1, { id: "grp_a", name: "gw-group" });
    seedGroupMembers(d1, "grp_a", ["model_a", "model_b"]);
    await seedDevice(d1);
    const env = makeEnv(d1);

    const items = await listModels(env);
    const group = items.find((m: any) => m.id === "gw-group");
    expect(group).toBeTruthy();
    expect(group.supports_reasoning).toBe(true);
    expect(group.default_reasoning_level).toBe("medium");
    expect(group.supported_reasoning_levels.map((l: any) => l.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    const one = await getModel(env, "gw-group");
    expect(one.supports_reasoning).toBe(true);
    expect(one.default_reasoning_level).toBe("medium");
    expect(one.supported_reasoning_levels.map((l: any) => l.effort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    d1.close();
  });

  it("publishes a group's own configured ladder and default", async () => {
    const d1 = createRealD1();
    seedBase(d1);
    seedGroup(d1, {
      id: "grp_a",
      name: "gw-group",
      config_json: JSON.stringify({
        supported_reasoning_levels: ["low", "high"],
        default_reasoning_level: "high",
      }),
    });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1);
    const env = makeEnv(d1);

    const group = (await listModels(env)).find((m: any) => m.id === "gw-group");
    expect(group.supports_reasoning).toBe(true);
    expect(group.default_reasoning_level).toBe("high");
    expect(group.supported_reasoning_levels.map((l: any) => l.effort)).toEqual(["low", "high"]);
    d1.close();
  });

  it("keeps a group's supports_reasoning:false veto visible to callers", async () => {
    const d1 = createRealD1();
    seedBase(d1);
    seedGroup(d1, {
      id: "grp_a",
      name: "gw-group",
      config_json: JSON.stringify({ supports_reasoning: false }),
    });
    seedGroupMembers(d1, "grp_a", ["model_a"]);
    await seedDevice(d1);
    const env = makeEnv(d1);

    const group = (await listModels(env)).find((m: any) => m.id === "gw-group");
    expect(group.supports_reasoning).toBe(false);
    expect(group.supported_reasoning_levels).toEqual([]);
    expect(group.default_reasoning_level).toBeNull();

    const one = await getModel(env, "gw-group");
    expect(one.supports_reasoning).toBe(false);
    expect(one.supported_reasoning_levels).toEqual([]);
    expect(one.default_reasoning_level).toBeNull();
    d1.close();
  });

  it("answers a plain model from its own config, not the group ladder", async () => {
    const d1 = createRealD1();
    seedProvider(d1, { id: "prov_a", name: "Provider A", type: "openai" });
    seedProvider(d1, { id: "prov_c", name: "Provider C", type: "anthropic", endpoint: "https://c.example/v1" });
    seedModel(d1, { id: "model_a", model_name: "gw-plain", provider_id: "prov_a" });
    seedModel(d1, {
      id: "model_c",
      model_name: "gw-thinker",
      provider_id: "prov_c",
      config_json: JSON.stringify({ supported_reasoning_levels: ["low", "medium"] }),
    });
    await seedDevice(d1);
    const env = makeEnv(d1);

    const items = await listModels(env);
    const plain = items.find((m: any) => m.id === "gw-plain");
    expect(plain.supports_reasoning).toBe(false);
    expect(plain.supported_reasoning_levels).toEqual([]);
    expect(plain.default_reasoning_level).toBeNull();

    const thinker = items.find((m: any) => m.id === "gw-thinker");
    expect(thinker.supports_reasoning).toBe(true);
    expect(thinker.supported_reasoning_levels.map((l: any) => l.effort)).toEqual(["low", "medium"]);

    const one = await getModel(env, "gw-thinker");
    expect(one.supports_reasoning).toBe(true);
    expect(one.supported_reasoning_levels.map((l: any) => l.effort)).toEqual(["low", "medium"]);
    d1.close();
  });
});
