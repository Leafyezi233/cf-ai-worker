import { afterEach, describe, expect, it } from "vitest";
import { modelsApp } from "../src/admin/models";
import { devicesApp } from "../src/admin/devices";
import { createRealD1, type RealD1 } from "./helpers/realD1";
import { makeEnv, seedModel, seedProvider } from "./helpers/realGatewayEnv";
const databases: RealD1[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe("narrow admin list payloads", () => {
  it("model list omits provider credentials and repeated provider connection configuration", async () => {
    const db=createRealD1(); databases.push(db); seedProvider(db); seedModel(db);
    const r=await modelsApp.request("http://admin.test/", {}, makeEnv(db)); expect(r.status).toBe(200);
    const data=await r.json() as any; expect(data.items).toHaveLength(1);
    expect(data.items[0]).toHaveProperty("provider_name"); expect(data.items[0]).toHaveProperty("model_name");
    for (const name of ["provider_api_key","provider_secret_name","provider_config_json","provider_endpoint"]) expect(data.items[0]).not.toHaveProperty(name);
  });
  it("account choices return only id/name/enabled and exclude revoked rows", async () => {
    const db=createRealD1(); databases.push(db);
    db.sql("INSERT INTO devices (id,name,token_hash,enabled,rate_limit_rpm,created_at) VALUES ('a','Account','token-a',1,0,100),('b','Revoked','token-b',0,0,200)");
    db.sql("UPDATE devices SET revoked_at = 300 WHERE id = 'b'");
    const r=await devicesApp.request("http://admin.test/choices", {}, makeEnv(db)); expect(r.status).toBe(200);
    expect(await r.json()).toEqual({items:[{id:"a",name:"Account",enabled:1}]});
  });
});
