import { afterEach, describe, expect, it } from "vitest";
import { listModelProjectionsForDevice, updateModel, updateModelGroup } from "../src/db/repo";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedProvider, seedModel, seedGroup, seedGroupMembers } from "./helpers/realGatewayEnv";
import type { Env } from "../src/types";

const databases: RealD1[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function fixture() {
  const db = createRealD1(); databases.push(db);
  seedProvider(db); seedModel(db); seedGroup(db); seedGroupMembers(db, "grp_a", ["model_a"]);
  return { db, env: makeEnv(db) as unknown as Env };
}
const names = async (env: Env, includeHidden = false) =>
  (await listModelProjectionsForDevice(env, null, { includeHidden })).map(row => row.model_name);

describe("display-only catalogue cache isolation", () => {
  it.each(["model", "group"] as const)("invalidates anonymous cached %s visibility only after a saved update", async kind => {
    const { db, env } = fixture();
    const name = kind === "model" ? "gw-primary" : "gw-group";
    const update = (config_json: string | null) => kind === "model"
      ? updateModel(env, "model_a", { config_json }) : updateModelGroup(env, "grp_a", { config_json });
    expect(await names(env)).toContain(name);
    await update(JSON.stringify({ catalog_visible: false, description: "preserved", member_retries: 2 }));
    expect(await names(env)).not.toContain(name);
    expect(await names(env, true)).toContain(name);
    expect(await names(env)).not.toContain(name);
    const row = db.row<any>("SELECT enabled,model_public,config_json FROM " + (kind === "model" ? "models" : "model_groups") + " WHERE id=?", kind === "model" ? "model_a" : "grp_a")!;
    expect(row.enabled).toBe(1); expect(row.model_public).toBe(1);
    expect(JSON.parse(row.config_json).description).toBe("preserved");
    await update(JSON.stringify({ description: "preserved", member_retries: 2 }));
    expect(await names(env)).toContain(name);
  });

  it("never promotes an unpublished model through includeHidden or another cache variant", async () => {
    const { db, env } = fixture();
    await names(env);
    await updateModel(env, "model_a", { config_json: '{"catalog_visible":false}', model_public: false });
    expect(await names(env, true)).not.toContain("gw-primary");
    expect(await names(env)).not.toContain("gw-primary");
    expect(db.row<any>("SELECT model_public FROM models WHERE id=?", "model_a")!.model_public).toBe(0);
  });

  it.each(["model", "group"] as const)("does not invalidate or change cached %s rows on rejected persistence", async kind => {
    const { db, env } = fixture();
    const old = await listModelProjectionsForDevice(env, null);
    const table = kind === "model" ? "models" : "model_groups";
    db.sql("CREATE TRIGGER reject_visibility BEFORE UPDATE ON " + table + " BEGIN SELECT RAISE(ABORT, 'visibility write rejected'); END");
    const action = kind === "model" ? updateModel(env, "model_a", { config_json: '{"catalog_visible":false}' })
      : updateModelGroup(env, "grp_a", { config_json: '{"catalog_visible":false}' });
    await expect(action).rejects.toThrow("visibility write rejected");
    const current = await listModelProjectionsForDevice(env, null);
    expect(current.map(row => row.model_name)).toEqual(old.map(row => row.model_name));
    current.forEach((row, i) => expect(row).toBe(old[i]));
    expect(db.row<any>("SELECT config_json FROM " + table + " WHERE id=?", kind === "model" ? "model_a" : "grp_a")!.config_json).toBeNull();
  });
});
