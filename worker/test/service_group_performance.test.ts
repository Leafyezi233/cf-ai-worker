import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { DEVICE_ID, makeEnv, seedDevice, seedModel, seedProvider } from "./helpers/realGatewayEnv";
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
