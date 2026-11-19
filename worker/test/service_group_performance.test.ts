import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, makeEnv, seedDevice, seedModel, seedProvider, seedGroup, seedGroupMembers } from "./helpers/realGatewayEnv";
import { ensureSchema } from "../src/db/schema";
import { getServiceGroupModel } from "../src/db/service_groups";
import { projectServiceModels, resolveServiceRoute } from "../src/gateway/service_groups";
import { listModelProjectionsForDevice } from "../src/db/repo";
import type { DeviceRow, Env } from "../src/types";
let d: RealD1, env: Env;
function device(): DeviceRow { return d.row<DeviceRow>("SELECT * FROM devices WHERE id = ?", DEVICE_ID)!; }
beforeEach(async () => {
  d = createRealD1(); env = makeEnv(d); await seedDevice(d); seedProvider(d); seedModel(d);
  d.sql("INSERT INTO service_groups(id,name,enabled,selectable,public_selectable,multiplier,revision) VALUES('sg','group',1,1,1,1,1)");
  d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id) VALUES('mapping','sg','shared','model','model_a')");
  d.sql("UPDATE devices SET service_group_id='sg' WHERE id=?", DEVICE_ID);
  await ensureSchema(env);
});
afterEach(() => { vi.restoreAllMocks(); d.close(); });
it("point lookup uses both indexed keys and excludes unrelated mappings", async () => {
  for (let i=0; i<1000; i++) d.sql("INSERT INTO service_group_models(id,service_group_id,model_key,target_type,target_id) VALUES(?,'sg',?,'model','model_a')", "other"+i, "other"+i);
  const prepare = vi.spyOn(env.DB, "prepare");
  expect(await getServiceGroupModel(env, "sg", "shared")).toMatchObject({ id: "mapping" });
  expect(await getServiceGroupModel(env, "sg", "missing")).toBeNull();
  expect(await getServiceGroupModel(env, "other-group", "shared")).toBeNull();
  const lookupSql = prepare.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.includes("service_group_models"));
  expect(lookupSql.every(sql => /service_group_id\s*=\s*\?/.test(sql) || /service_group_id\s+IN\s*\(/.test(sql))).toBe(true);
  expect(lookupSql.every(sql => /model_key\s*=\s*\?/.test(sql) || /\bid\s*=\s*\?/.test(sql))).toBe(true);
  expect((await resolveServiceRoute(env, device(), "shared"))?.members).toHaveLength(1);
});
it("selected catalog never invokes legacy loading", async () => {
  const legacy = vi.fn(async () => { throw new Error("legacy must not load"); });
  expect(await projectServiceModels(env, device(), legacy)).toHaveLength(1);
  expect(legacy).not.toHaveBeenCalled();
});
it("repo selected catalog avoids unrestricted legacy model reads", async () => {
  const prepare = vi.spyOn(env.DB, "prepare");
  expect(await listModelProjectionsForDevice(env, device())).toHaveLength(1);
  const modelReads = prepare.mock.calls.map(([sql]) => String(sql)).filter(sql => /FROM models m JOIN providers p/.test(sql));
  expect(modelReads.length).toBeGreaterThan(0);
  expect(modelReads.every(sql => /m.id IN/.test(sql))).toBe(true);
});
it("no selection and no available offers invokes legacy loader once and preserves its result", async () => {
  d.sql("UPDATE devices SET service_group_id=NULL WHERE id=?", DEVICE_ID);
  d.sql("UPDATE service_groups SET selectable=0");
  const rows = [{ id: "legacy" }] as never[];
  const legacy = vi.fn(async () => rows);
  expect(await projectServiceModels(env, device(), legacy)).toBe(rows);
  expect(legacy).toHaveBeenCalledTimes(1);
});
it("anonymous legacy array remains supported", async () => {
  const rows = [{ id: "legacy" }] as never[];
  expect(await projectServiceModels(env, null, rows)).toBe(rows);
});
it.each(["disabled", "revoked", "missing"])("%s group fails closed without legacy loading", async kind => {
  if (kind === "disabled") d.sql("UPDATE service_groups SET enabled=0");
  if (kind === "revoked") d.sql("UPDATE service_groups SET public_selectable=0");
  if (kind === "missing") d.sql("UPDATE devices SET service_group_id='gone' WHERE id=?", DEVICE_ID);
  const legacy = vi.fn(async () => []);
  await expect(projectServiceModels(env, device(), legacy)).rejects.toMatchObject({ status: kind === "revoked" ? 403 : 503 });
  expect(legacy).not.toHaveBeenCalled();
});

function groupedRoute(config: string) {
  seedModel(d, { id: "model_b", model_name: "upstream-b", config_json: '{"model_rewrite":"member-b","retained":true}' });
  seedGroup(d, { config_json: config });
  seedGroupMembers(d, "grp_a", ["model_a", "model_b"]);
  d.sql("UPDATE service_group_models SET target_type='group',target_id='grp_a'");
}
it("keeps group parsing independent of member count and preserves member configuration and database rows", async () => {
  const config = '{"model_rewrite":"group-wins","sentinel":"cpu3-group"}';
  groupedRoute(config);
  const before = d.rows("SELECT id,config_json FROM models ORDER BY id");
  const realParse = JSON.parse;
  let rewriteParses = 0;
  vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    const caller = new Error().stack?.split("\n").find(line => /[\\/]src[\\/]/.test(line));
    if (text === config && caller?.includes("buildRoute")) rewriteParses++;
    return realParse(text, reviver);
  });
  const route = await resolveServiceRoute(env, device(), "shared");
  expect(rewriteParses).toBe(1);
  expect(route?.members).toHaveLength(2);
  expect(route?.members.map(m => JSON.parse(m.config_json!))).toEqual([
    { model_rewrite: "group-wins" }, { model_rewrite: "group-wins", retained: true }
  ]);
  expect(d.rows("SELECT id,config_json FROM models ORDER BY id")).toEqual(before);
  const ids = ["model_a", "model_b"];
  for (let i = 0; i < 18; i++) ids.push(seedModel(d, { id: "extra-" + i }));
  seedGroupMembers(d, "grp_a", ids);
  rewriteParses = 0;
  expect((await resolveServiceRoute(env, device(), "shared"))?.members).toHaveLength(20);
  expect(rewriteParses).toBe(1);
  seedGroupMembers(d, "grp_a", ["model_a", "model_b"]);
  d.sql("UPDATE model_groups SET config_json=? WHERE id='grp_a'", '{"model_rewrite":"changed"}');
  const changed = await resolveServiceRoute(env, device(), "shared");
  expect(changed?.members.map(m => JSON.parse(m.config_json!).model_rewrite)).toEqual(["changed", "changed"]);
});
it.each(['{}', '{"model_rewrite":" "}', '{"model_rewrite":7}'])("preserves member then upstream fallback for %s", async config => {
  groupedRoute(config);
  const route = await resolveServiceRoute(env, device(), "shared");
  expect(route?.members.map(m => JSON.parse(m.config_json!).model_rewrite)).toEqual(["gw-primary", "member-b"]);
});
it.each(['{bad', 'null'])("invalid group configuration fails closed: %s", async config => {
  groupedRoute(config);
  await expect(resolveServiceRoute(env, device(), "shared")).rejects.toMatchObject({ status: 503 });
});
it("invalid member configuration still fails closed", async () => {
  groupedRoute('{"model_rewrite":"group-wins"}');
  d.sql("UPDATE models SET config_json='{bad' WHERE id='model_b'");
  await expect(resolveServiceRoute(env, device(), "shared")).rejects.toMatchObject({ status: 503 });
});
