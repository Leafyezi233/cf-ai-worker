import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { adminApp } from "../src/admin";
import { exportPrices, serializePrice, serializePriceItem, type PriceExportItem } from "../src/admin/price-export";
import { ensureSchema } from "../src/db/schema";
import type { Env, ModelWithProvider } from "../src/types";
import { buildSessionCookie, signSession } from "../src/utils/crypto";
import { createRealD1 } from "./helpers/realD1";

const databases: ReturnType<typeof createRealD1>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });
const instant = Date.parse("2026-11-06T02:00:00.000Z");
const secret = "price-export-test-session";
async function setup() {
  const db = createRealD1();
  databases.push(db);
  const env = { DB: db.DB, ADMIN_SECRET: secret, SESSION_SECRET: secret, ENCRYPTION_KEY: "not-a-real-key" } as Env;
  await ensureSchema(env);
  db.sql("INSERT INTO providers (id,name,type,api_key,endpoint,enabled) VALUES ('p','provider-secret','openai','enc:sealed-invalid-key','https://endpoint-secret.invalid',1),('off','off','openai',NULL,NULL,0)");
  const model = (id: string, extra: Record<string, unknown> = {}) => {
    db.sql("INSERT INTO models (id,provider_id,model_name,alias,enabled,model_public,pricing_mode,billing_unit,input_price_per_m,output_price_per_m,cache_read_price_per_m,cache_write_price_per_m,price_per_call,search_price_per_call,peak_pricing_enabled,config_json) VALUES (?, 'p', ?, 'same-name',1,0,'priced','token',2,4,0,0,5,0.25,1,?)", id, "upstream-" + id, JSON.stringify({ system_prompt: "config-secret", api_key: "config-key-secret" }));
    for (const [key,value] of Object.entries(extra)) db.sql("UPDATE models SET " + key + " = ? WHERE id = ?", value, id);
  };
  const window = (id: string, multiplier = 3) => db.sql("INSERT INTO price_windows (id,model_id,day_type,start_minute,end_minute,multiplier,enabled,created_at,updated_at) VALUES (?,?,'weekday',0,1440,?,1,1,1)", "w-" + id, id, multiplier);
  const service = (id: string, enabled = 1, multiplier = 2) => db.sql("INSERT INTO service_groups (id,name,public_selectable,selectable,enabled,multiplier,revision) VALUES (?,?,0,0,?,?,1)", id, "service-" + id, enabled, multiplier);
  const mapping = (id: string, serviceId: string, target: string, prices: string | null = null, kind = "model", key = "same-name") => db.sql("INSERT INTO service_group_models (id,service_group_id,model_key,target_type,target_id,pricing_json,member_ids_json) VALUES (?,?,?,?,?,?,NULL)", id,serviceId,key,kind,target,prices);
  const sqls: string[] = [];
  const prepare = db.DB.prepare.bind(db.DB);
  db.DB.prepare = (sql: string) => { sqls.push(sql); return prepare(sql); };
  return { db, env, model, window, service, mapping, sqls };
}
function item(items: PriceExportItem[], kind: string, id: string, service: string | null = null, name = "same-name") {
  const found = items.find((row) => row.source_key === JSON.stringify([kind,id,service,name]));
  expect(found).toBeDefined();
  return found!;
}
async function request(env: Env, authenticated = true) {
  const headers: Record<string, string> = authenticated ? { cookie: buildSessionCookie(await signSession(secret,0)).split(";")[0] } : {};
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api", adminApp);
  return app.fetch(new Request("https://test.invalid/api/models/prices/export", { headers }),env);
}

describe("read-only price export SQLite integration", () => {
  it("exports all six effective prices, cache fallback, aliases and same-name sources without leaking or calling upstream", async () => {
    const f = await setup();
    f.model("m1"); f.window("m1");
    f.model("m2", { cache_read_price_per_m: 0.5, cache_write_price_per_m: 0.75 });
    f.model("negative-cache", { cache_read_price_per_m: -2, cache_write_price_per_m: -3 });
    f.model("call", { billing_unit: "call" }); f.window("call");
    f.model("disabled", { enabled: 0 }); f.model("off-provider", { provider_id: "off" });
    f.service("private"); f.mapping("mapping1","private","m1");
    f.mapping("mapping-call","private","call",null,"model","per-call");
    f.service("disabled",0); f.mapping("mapping-off","disabled","m1");
    const fetch = vi.fn(() => { throw new Error("no upstream allowed"); });
    vi.stubGlobal("fetch",fetch);
    const before = f.db.rows("SELECT * FROM models ORDER BY id");
    f.sqls.length = 0;
    const result = await exportPrices(f.env,instant);
    expect(result).toMatchObject({ format: "cpg-price-export", version: 1, exported_at: "2026-11-06T02:00:00.000Z", currency: "CNY", price_basis: "gateway_charge" });
    expect(item(result.items,"model","m1").prices).toEqual({input:"6",output:"12",read:"6",write:"6",call:null,search:"0.25"});
    expect(item(result.items,"model","m2").prices).toEqual({input:"2",output:"4",read:"0.5",write:"0.75",call:null,search:"0.25"});
    expect(item(result.items,"model","negative-cache").prices.read).toBe("2");
    expect(item(result.items,"model","negative-cache").prices.write).toBe("2");
    expect(item(result.items,"model","call").prices).toEqual({input:null,output:null,read:null,write:null,call:"15",search:"0.25"});
    expect(item(result.items,"service_group","m1","private").prices).toEqual({input:"12",output:"24",read:"12",write:"12",call:null,search:"0.25"});
    expect(item(result.items,"service_group","call","private","per-call").prices).toEqual({input:null,output:null,read:null,write:null,call:"30",search:"0.25"});
    expect(new Set(result.items.map((r) => r.source_key)).size).toBe(result.items.length);
    expect(result.items).toHaveLength(6);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.db.rows("SELECT * FROM models ORDER BY id")).toEqual(before);
    expect(f.sqls.every((sql) => /^SELECT\b/.test(sql))).toBe(true);
    expect(f.sqls.join(" ")).not.toMatch(/FROM (devices|device_|usage|wallet)|JOIN devices|device_model_groups/i);
    expect(f.sqls.filter((sql) => /FROM price_windows/.test(sql))).toHaveLength(1);
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/provider|endpoint|config|api_key|sealed|members|grants|upstream-|cost|password|token_hash/);
    for (const row of result.items) expect(Object.keys(row).sort()).toEqual(["source_key","kind","model_name","group_name","billing_unit","pricing_mode","prices","warnings"].sort());
  });

  it("uses only servable model groups and includes every enabled private/nonselectable service with override and group peak rules", async () => {
    const f = await setup(); f.model("m1"); f.window("m1",7);
    for (const id of ["g","empty","disabled"]) f.db.sql("INSERT INTO model_groups (id,name,enabled,model_public,pricing_mode,input_price_per_m,output_price_per_m,cache_read_price_per_m,cache_write_price_per_m,price_per_call,search_price_per_call,peak_pricing_enabled) VALUES (?,?,?,0,'priced',10,20,1,2,3,0.5,1)",id,id,id === "disabled" ? 0 : 1);
    f.db.sql("INSERT INTO model_group_members (group_id,model_id,position,enabled) VALUES ('g','m1',0,1)"); f.window("g",3);
    f.service("a",1,2); f.service("b",1,8); f.service("c",1,6);
    f.mapping("a","a","g",null,"group");
    f.mapping("b","b","g",JSON.stringify({ input_price_per_m: 11, output_price_per_m: 12, cache_read_price_per_m: 0, cache_write_price_per_m: 4, price_per_call: 8, search_price_per_call: 0.75 }),"group");
    f.mapping("c","c","g",JSON.stringify({ input_price_per_m: 9 }),"group");
    f.mapping("d","a","m1",null,"model","second-public-key");
    const result = await exportPrices(f.env,instant);
    expect(item(result.items,"model_group","g",null,"g").prices).toEqual({input:"30",output:"60",read:"3",write:"6",call:null,search:"0.5"});
    expect(item(result.items,"service_group","g","a").prices).toEqual({input:"60",output:"120",read:"6",write:"12",call:null,search:"0.5"});
    expect(item(result.items,"service_group","g","b").prices).toEqual({input:"33",output:"36",read:"33",write:"12",call:null,search:"0.75"});
    expect(item(result.items,"service_group","g","c").prices.input).toBe("27");
    expect(item(result.items,"service_group","g","c").prices.output).toBe("60");
    expect(item(result.items,"service_group","m1","a","second-public-key").prices.input).toBe("28");
    expect(result.items.filter((row) => row.kind === "model_group").map((row) => row.model_name)).toEqual(["g"]);
  });

  it("exports free relevant zero prices and unset null prices without guessing costs, including service mappings", async () => {
    const f = await setup();
    f.model("free",{pricing_mode:"free"}); f.model("unset",{pricing_mode:"unset"}); f.model("free-call",{pricing_mode:"free",billing_unit:"call"});
    f.service("s",1,99); f.mapping("free","s","free",null,"model","free"); f.mapping("unset","s","unset",null,"model","unset");
    const result = await exportPrices(f.env,instant);
    expect(item(result.items,"model","free").prices).toEqual({input:"0",output:"0",read:"0",write:"0",call:null,search:"0"});
    expect(item(result.items,"model","free-call").prices).toEqual({input:null,output:null,read:null,write:null,call:"0",search:"0"});
    expect(item(result.items,"service_group","free","s","free").prices.input).toBe("0");
    for (const row of result.items.filter((r) => r.pricing_mode === "unset")) {
      expect(Object.values(row.prices).every((v) => v === null)).toBe(true); expect(row.warnings).toEqual(["price_not_configured"]);
    }
  });

  it("exports scientific-notation SQLite prices as nonzero decimal strings", async () => {
    const f = await setup(); f.model("tiny", { input_price_per_m: 1.25e-20, output_price_per_m: 1e22 });
    const prices = item((await exportPrices(f.env,instant)).items,"model","tiny").prices;
    expect(prices.input).toBe("0.0000000000000000000125");
    expect(prices.read).toBe(prices.input); expect(prices.output).toBe("10000000000000000000000");
  });

  it("resolves zero peak multipliers without scaling search and snapshots current prices without caching", async () => {
    const f = await setup(); f.model("m"); f.window("m",0);
    expect(item((await exportPrices(f.env,instant)).items,"model","m").prices).toEqual({input:"0",output:"0",read:"0",write:"0",call:null,search:"0.25"});
    f.db.sql("UPDATE price_windows SET multiplier = 2"); f.db.sql("UPDATE models SET input_price_per_m = 9");
    expect(item((await exportPrices(f.env,instant)).items,"model","m").prices.input).toBe("18");
  });

  it.each([Infinity, "not-a-number"])("fails closed on nonfinite or nonnumeric stored prices %s", async (price) => {
    const f = await setup(); f.model("bad", { input_price_per_m: price });
    expect((await request(f.env)).status).toBe(503);
  });

  it("fails closed on service multiplier underflow and invalid overrides instead of silently dropping a route", async () => {
    const f = await setup(); f.model("tiny", { input_price_per_m: Number.MIN_VALUE });
    f.service("s",1,0.1); f.mapping("map","s","tiny");
    expect((await request(f.env)).status).toBe(503);
    f.db.sql("UPDATE service_group_models SET pricing_json = ?", JSON.stringify({ input_price_per_m: -1 }));
    expect((await request(f.env)).status).toBe(503);
  });

  it("fails closed on corrupt peak multipliers", async () => {
    const f = await setup(); f.model("bad"); f.window("bad",Infinity);
    expect((await request(f.env)).status).toBe(503);
  });

  it("requires the existing outer admin session and returns no-store attachment", async () => {
    const f = await setup(); f.model("m");
    expect((await request(f.env,false)).status).toBe(401);
    const res = await request(f.env);
    expect(res.status).toBe(200); expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="cpg-prices.json"');
    expect(await res.json()).toMatchObject({ format: "cpg-price-export" });
  });

  it.each(["input_price_per_m", "output_price_per_m", "search_price_per_call", "price_per_call"])("fails closed on anomalous %s without echoing secrets", async (field) => {
    const f = await setup(); f.model("bad",{ [field]: -1 });
    const res = await request(f.env);
    expect(res.status).toBe(503); expect(await res.json()).toEqual({ error: "price_export_unavailable" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("decimal serialization", () => {
  it.each([0, -0, 1e-7, 1.25e-20, 1e21, 1.234e25, Number.MIN_VALUE, Number.MAX_VALUE])("expands %s without exponent or loss to zero", (n) => {
    const text = serializePrice(n); expect(text).toMatch(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/); expect(Number(text)).toBe(n === 0 ? 0 : n);
    if (n > 0) expect(text).not.toBe("0");
  });
  it.each([NaN, Infinity, -Infinity, -1])("rejects %s",(n) => { expect(() => serializePrice(n)).toThrow(); });
  it("rejects underflow and overflow instead of writing a misleading zero/null", () => {
    const row = { id:"x",model_name:"x",pricing_mode:"priced",billing_unit:"token",input_price_per_m: Number.MIN_VALUE,output_price_per_m:1,cache_read_price_per_m:0,cache_write_price_per_m:0,price_per_call:0,search_price_per_call:0 } as ModelWithProvider;
    expect(() => serializePriceItem(row,"model",null,0.1)).toThrow("underflow");
    expect(() => serializePriceItem({...row,input_price_per_m:Number.MAX_VALUE},"model",null,2)).toThrow();
  });
});
