import { beforeEach, describe, expect, it } from "vitest";
import { listModelProjectionsForDevice, resetModelCatalogCache } from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { seedModel, seedProvider, makeEnv, seedDevice } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";


function envOf(d1: RealD1): Env {
  return makeEnv(d1) as unknown as Env;
}
describe("the anonymous model catalog is cached", () => {
  beforeEach(() => {
    resetModelCatalogCache();
  });

  it("serves a second anonymous read without rescanning the table", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary" });
    const env = envOf(d1);

    const first = await listModelProjectionsForDevice(env, null);
    expect(first.map((m) => m.model_name)).toContain("gw-primary");

    d1.sql("DELETE FROM models WHERE id = ?", "model_a");
    const second = await listModelProjectionsForDevice(env, null);
    expect(second.map((m) => m.model_name)).toContain("gw-primary");
  });

  it("never lets an unpublished model into the anonymous view, whichever option is used", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { id: "model_pub", model_name: "public-one", model_public: 1 });
    seedModel(d1, { id: "model_prv", model_name: "private-one", model_public: 0 });
    const env = envOf(d1);

    const pub = await listModelProjectionsForDevice(env, null);
    const all = await listModelProjectionsForDevice(env, null, { includePrivate: true });

    expect(pub.map((m) => m.model_name)).toEqual(["public-one"]);
    expect(all.map((m) => m.model_name)).toEqual(["public-one"]);
  });

  it("hands out a copy, so a caller sorting the result cannot corrupt the cache", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { id: "model_a", model_name: "aaa" });
    seedModel(d1, { id: "model_b", model_name: "bbb" });
    const env = envOf(d1);

    const first = await listModelProjectionsForDevice(env, null);
    first.reverse();
    const second = await listModelProjectionsForDevice(env, null);
    expect(second.map((m) => m.model_name)).toEqual(["aaa", "bbb"]);
  });

  it("never caches an authenticated catalog, so an admin edit shows up immediately", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1, { id: "model_a", model_name: "gw-primary" });
    await seedDevice(d1);
    const env = envOf(d1);
    const device = d1.row<any>("SELECT * FROM devices WHERE id = ?", "dev_1")!;

    const first = await listModelProjectionsForDevice(env, device);
    expect(first.map((m) => m.model_name)).toContain("gw-primary");

    d1.sql("UPDATE models SET enabled = 0 WHERE id = ?", "model_a");
    const second = await listModelProjectionsForDevice(env, device);
    expect(second.map((m) => m.model_name)).not.toContain("gw-primary");
  });

  it("keeps two environments apart", async () => {
    const d1a = createRealD1();
    const d1b = createRealD1();
    seedProvider(d1a, { id: "prov_a" });
    seedProvider(d1b, { id: "prov_b" });
    seedModel(d1a, { id: "model_a", model_name: "only-in-a" });
    seedModel(d1b, { id: "model_b", model_name: "only-in-b", provider_id: "prov_b" });

    const a = await listModelProjectionsForDevice(envOf(d1a), null);
    const b = await listModelProjectionsForDevice(envOf(d1b), null);
    expect(a.map((m) => m.model_name)).toEqual(["only-in-a"]);
    expect(b.map((m) => m.model_name)).toEqual(["only-in-b"]);
  });
});
