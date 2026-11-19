import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";
import { ensureSchema } from "../src/db/schema";
import { deviceAccessReport } from "../src/admin/device_access";
import { createServiceGroup, upsertServiceGroupModel } from "../src/db/service_groups";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const React = requireWeb("react"), { renderToStaticMarkup } = requireWeb("react-dom/server");
const drawerPath = "../../web/src/components/AccountDetailDrawer";
const { AccountAccessView, priceText } = await import(drawerPath);
const databases: RealD1[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const video = { model_type: "video", video: { adapter: "secure_skill", upstream_model: "market-video-v1", default_ratio: "16:9", default_duration: 4, ratios: ["16:9"], resolutions: ["720p", "1080p"], default_resolution: "720p", seconds_min: 4, seconds_max: 15, max_images: 3, support_first_last: false, quotes: [
  { resolution: "720p", has_reference_video: false, unit: "second", price: 0.125 },
  { resolution: "1080p", has_reference_video: false, unit: "call", price: 2 },
] } };
async function setup() {
  const db = createRealD1(); databases.push(db); const env = makeEnv(db); await ensureSchema(env);
  seedProvider(db); await seedDevice(db, { id: "acct" });
  seedModel(db, { id: "v", model_name: "video", billing_unit: "call", price_per_call: 99, input_price_per_m: 0, output_price_per_m: 0, config_json: JSON.stringify(video), peak_pricing_enabled: 1 });
  return { db, env };
}
describe("PR1 video account quote projection", () => {
  it("renders raw 720p second and 1080p successful-task rates rather than scalar 99", async () => {
    const { env } = await setup();
    const report = (await deviceAccessReport(env, "acct", { models: true }))!;
    const price = report.models[0].price!;
    expect(price.video_pricing!.quotes.map(q => q.price)).toEqual([0.125, 2]);
    const text = priceText(price); expect(text).toContain("720p"); expect(text).toContain("¥0.125/秒"); expect(text).toContain("¥2/成功任务次"); expect(text).not.toContain("¥99");
    const html = renderToStaticMarkup(React.createElement(AccountAccessView, { device: { id: "acct", name: "a" }, report, onlyBlocked: false, onToggleOnlyBlocked: () => {} }));
    expect(html).toContain("¥0.125/秒"); expect(html).not.toContain("¥99");
    expect(JSON.stringify(report)).not.toMatch(/sk-a|config_json|upstream_model|provider_endpoint/);
  });
  it("applies group and peak multipliers exactly once from the untouched ratecard", async () => {
    const { db, env } = await setup();
    const group = await createServiceGroup(env, { name: "Video", multiplier: 2, public_selectable: 1 });
    await upsertServiceGroupModel(env, group.id, { model_key: "video", target_type: "model", target_id: "v" });
    db.sql("UPDATE devices SET service_group_id=? WHERE id='acct'", group.id);
    db.sql("INSERT INTO price_windows(id,model_id,day_type,start_minute,end_minute,multiplier,enabled) VALUES('peak','v','all',0,1440,3,1)");
    // Cover every day representation without relying on the test runner's timezone/day.
    for (const day of ["mon","tue","wed","thu","fri","sat","sun","weekday","weekend"]) db.sql("INSERT INTO price_windows(id,model_id,day_type,start_minute,end_minute,multiplier,enabled) VALUES(?, 'v', ?, 0,1440,3,1)", day, day);
    const before = db.row<any>("SELECT config_json FROM models WHERE id='v'")!.config_json;
    const report = (await deviceAccessReport(env, "acct", { model: "video" }))!;
    expect(report.models[0].price!.multiplier).toBe(3);
    expect(report.models[0].price!.video_pricing!.quotes.map(q => q.price)).toEqual([0.75, 12]);
    expect(db.row<any>("SELECT config_json FROM models WHERE id='v'")!.config_json).toBe(before);
    const second = (await deviceAccessReport(env, "acct", { model: "video" }))!;
    expect(second.models[0].price!.video_pricing!.quotes.map(q => q.price)).toEqual([0.75, 12]);
  });
  it("does not turn missing variants or scalar service overrides into standard-video prices", async () => {
    const { db, env } = await setup();
    const group = await createServiceGroup(env, { name: "Override", public_selectable: 1 });
    await upsertServiceGroupModel(env, group.id, { model_key: "video", target_type: "model", target_id: "v", pricing_json: JSON.stringify({ price_per_call: 1 }) });
    db.sql("UPDATE devices SET service_group_id=? WHERE id='acct'", group.id);
    const price = (await deviceAccessReport(env, "acct", { model: "video" }))!.models[0].price!;
    expect(price.video_pricing!.quotes).toEqual([]); expect(priceText(price)).toContain("未定价"); expect(priceText(price)).not.toContain("¥1");
    expect(priceText({ ...price, video_pricing: undefined })).toContain("未定价");
    db.sql("UPDATE devices SET service_group_id=NULL WHERE id='acct'");
    db.sql("UPDATE models SET config_json=? WHERE id='v'", JSON.stringify({ ...video, video: { ...video.video, quotes: [] } }));
    const missing = (await deviceAccessReport(env, "acct", { model: "video" }))!.models[0];
    expect(missing.price?.video_pricing?.quotes ?? []).toEqual([]);
  });
  it("retains generic video scalar and text formatting; shows unchecked not denied", async () => {
    const { db, env } = await setup();
    db.sql("UPDATE models SET config_json=? WHERE id='v'", JSON.stringify({ model_type: "video", video: { adapter: "generic", task_id_path: "data.id", sizes: ["1280x720"] } }));
    const report = (await deviceAccessReport(env, "acct", { models: true }))!;
    expect(priceText(report.models[0].price)).toBe("¥99 / 次");
    expect(priceText({ pricing_mode: "priced", billing_unit: "token", input_price_per_m: 1, output_price_per_m: 2, price_per_call: 0, multiplier: 1 })).toContain("每百万 Token");
    report.models = [{ name: "unchecked", display_name: null, available: null, status: "unchecked", reason: "预算耗尽", service_group: null, price: null }];
    const html = renderToStaticMarkup(React.createElement(AccountAccessView, { device: { id: "acct", name: "a" }, report, onlyBlocked: false, onToggleOnlyBlocked: () => {} }));
    expect(html).toContain("未检查"); expect(html).not.toContain(">不能<");
  });
});
