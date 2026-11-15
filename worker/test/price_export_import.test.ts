import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { exportPrices } from "../src/admin/price-export";
import { ensureSchema } from "../src/db/schema";
import { createRealD1 } from "./helpers/realD1";
import type { Env } from "../src/types";
const require = createRequire(import.meta.url);
const C = require("../../../model-price-assistant/core.js");
const I = require("../../../model-price-assistant/cpg-import.js");

describe("actual CPG export to offline assistant contract", () => {
  it("roundtrips effective token and call quotes without assuming procurement or changing existing records", async () => {
    const db = createRealD1();
    try {
      const env = { DB: db.DB } as Env;
      await ensureSchema(env);
      db.sql("INSERT INTO providers (id,name,type,enabled) VALUES ('p','p','openai',1)");
      db.sql("INSERT INTO models (id,provider_id,model_name,enabled,pricing_mode,billing_unit,input_price_per_m,output_price_per_m,cache_read_price_per_m,cache_write_price_per_m,price_per_call,search_price_per_call) VALUES ('m','p','demo',1,'priced','token',2,10,0,0,0,0.25),('c','p','image',1,'priced','call',0,0,0,0,0.5,0)");
      db.sql("INSERT INTO service_groups (id,name,enabled,multiplier) VALUES ('s','discount',1,0.5)");
      db.sql("INSERT INTO service_group_models (id,service_group_id,model_key,target_type,target_id) VALUES ('sm','s','demo','model','m')");
      const exported = await exportPrices(env, Date.parse("2026-11-07T12:00:00Z"));
      const parsed = I.parse(JSON.stringify(exported));
      expect(parsed).toEqual(exported);
      const selected = parsed.items.map((p: { source_key: string }) => p.source_key);
      const original = C.example();
      const before = JSON.stringify(original);
      const sales = I.append(original, exported, { role: "sale", selected });
      expect(JSON.stringify(original)).toBe(before);
      expect(sales.models).toHaveLength(4);
      expect(sales.models.slice(1).every((m: {input: string}) => m.input === "")).toBe(true);
      expect(sales.channels[1].paid).toBe("");
      const source = parsed.items.find((p: {kind: string}) => p.kind === "service_group");
      expect(source.prices).toEqual({ input: "1", output: "5", read: "1", write: "1", call: null, search: "0.25" });
      const cost = I.append(original, exported, { role: "cost", acknowledgeCost: true, channelId: original.channels[0].id, selected: [source.source_key] });
      const quote = C.quote(cost.channels[0], cost.models[1], cost.settings);
      expect(quote.rows.find((r: {key: string}) => r.key === "input").cost).toBe("0.1");
      expect(quote.rows.find((r: {key: string}) => r.key === "search").cost).toBe("0.025");
      expect(cost.models[1].includesMultiplier).toBe(true);
      expect(cost.models[1].sale.input).toBe("");
      expect(C.validate(JSON.parse(JSON.stringify(sales)))).toEqual(sales);
    } finally { db.close(); }
  });
});
