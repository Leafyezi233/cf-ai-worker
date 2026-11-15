import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { consoleApp } from "../src/console";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
import { createRealD1, makeEnv, seedDevice, seedProvider, seedModel, TOKEN, DEVICE_ID, type RealD1 } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";
let db: RealD1, env: Env;
const config = { model_type: "video", video: { adapter: "secure_skill", upstream_model: "catalog-video-v1", default_ratio: "16:9", default_duration: 4, ratios: ["16:9"], resolutions: ["720p"], default_resolution: "720p", seconds_min: 4, seconds_max: 15, max_images: 3, support_first_last: false, quotes: [{ resolution: "720p", has_reference_video: false, unit: "second", price: 0.18 }] } };
beforeEach(async () => { db = createRealD1(); env = makeEnv(db); await seedDevice(db); seedProvider(db); seedModel(db, { id: "video-model", model_name: "public-video", billing_unit: "call", price_per_call: 0, input_price_per_m: 0, output_price_per_m: 0, config_json: JSON.stringify(config) }); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });
it.each([false, true])("selected-group /models scales ratecards and refuses scalar overrides (%s)", async scalarOverride => {
  const group = await createServiceGroup(env, { name: "video-group", public_selectable: 1, multiplier: 2 });
  await upsertServiceGroupModel(env, group.id, { model_key: "public-video", target_type: "model", target_id: "video-model", ...(scalarOverride ? { pricing_json: JSON.stringify({ price_per_call: 1 }) } : {}) });
  db.sql("UPDATE devices SET service_group_id = ? WHERE id = ?", group.id, DEVICE_ID);
  const r = await consoleApp.request("https://gw.test/models", { headers: { authorization: "Bearer " + TOKEN } }, env);
  expect(r.status).toBe(200);
  const body = await r.json() as any;
  const model = body.items.find((m: any) => m.model_name === "public-video");
  expect(model.chat_endpoint).toBe("/v1/videos");
  expect(model.video_pricing.quotes).toEqual(scalarOverride ? [] : [{ resolution: "720p", has_reference_video: false, unit: "second", price: 0.36 }]);
  expect(JSON.stringify(model)).not.toMatch(/secure_skill|provider_endpoint|api_key|config_json/);
});
it("loads video service pricing contexts in one additional query for multiple authorized groups", async () => {
  for (const multiplier of [1, 2, 3]) {
    const group = await createServiceGroup(env, { name: "video-" + multiplier, public_selectable: 1, multiplier });
    await upsertServiceGroupModel(env, group.id, { model_key: "public-video", target_type: "model", target_id: "video-model" });
  }
  const spy = vi.spyOn(env.DB, "prepare");
  const r = await consoleApp.request("https://gw.test/model-marketplace", { headers: { authorization: "Bearer " + TOKEN } }, env);
  expect(r.status).toBe(200);
  const body = await r.json() as any;
  expect(body.items.filter((m: any) => m.service_group_id).map((m: any) => m.video_pricing.quotes[0].price).sort()).toEqual([0.18, 0.36, 0.54]);
  expect(spy.mock.calls.filter(([sql]) => sql.startsWith("SELECT service_group_id, model_key, pricing_json FROM service_group_models"))).toHaveLength(1);
});
