import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { initializedSchemaDouble } from "./helpers/initializedSchemaDouble";

describe("SPA Routing & Browser Refresh Protection", () => {
  it("serves static assets when browser refreshes on /models with text/html accept header", async () => {
    let assetsFetched = false;
    const mockAssets = {
      fetch: async (req: Request) => {
        assetsFetched = true;
        return new Response("<!DOCTYPE html><html><body>React App</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    };

    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {},
            all: async () => ({ results: [] }),
            first: async () => null,
          }),
        }),
      } as any,
      ASSETS: mockAssets as any,
    } as Env;

    const req = new Request("https://gateway.example.com/models", {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    mockEnv.DB = initializedSchemaDouble(mockEnv.DB);
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);
    expect(assetsFetched).toBe(true);

    const body = await res.text();
    expect(body).toContain("React App");
  });

  it("returns model list for API clients calling GET /models without bearer token and not requesting HTML", async () => {
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {},
            all: async () => ({ results: [] }),
            first: async () => null,
          }),
          all: async () => ({ results: [] }),
        }),
      } as any,
      ASSETS: {
        fetch: async () => new Response("SPA", { status: 200 }),
      } as any,
    } as Env;

    const req = new Request("https://gateway.example.com/models", {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    mockEnv.DB = initializedSchemaDouble(mockEnv.DB);
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.object).toBe("list");
  });

  it("serves the SPA page for a browser navigation to /console", async () => {
    let assetsFetched = false;
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => {}, all: async () => ({ results: [] }), first: async () => null }),
          all: async () => ({ results: [] }),
        }),
      } as any,
      ASSETS: {
        fetch: async () => {
          assetsFetched = true;
          return new Response("<!DOCTYPE html><html><body>Console</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        },
      } as any,
    } as Env;

    const req = new Request("https://gateway.example.com/console", {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });

    mockEnv.DB = initializedSchemaDouble(mockEnv.DB);
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(200);
    expect(assetsFetched).toBe(true);
    expect(await res.text()).toContain("Console");
  });

  it("still routes /console API calls to consoleApp instead of the asset fallback", async () => {
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => {}, all: async () => ({ results: [] }), first: async () => null }),
          all: async () => ({ results: [] }),
        }),
      } as any,
      ASSETS: { fetch: async () => new Response("SPA", { status: 200 }) } as any,
    } as Env;

    const req = new Request("https://gateway.example.com/console/me", {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    mockEnv.DB = initializedSchemaDouble(mockEnv.DB);
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("sends a bare-domain browser navigation to the personal page, not the console shell", async () => {
    let assetsFetched = false;
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => {}, all: async () => ({ results: [] }), first: async () => null }),
          all: async () => ({ results: [] }),
        }),
      } as any,
      ASSETS: {
        fetch: async () => {
          assetsFetched = true;
          return new Response("SPA", { status: 200 });
        },
      } as any,
    } as Env;

    const req = new Request("https://gateway.example.com/", {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });

    mockEnv.DB = initializedSchemaDouble(mockEnv.DB);
    const res = await app.fetch(req, mockEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/me/");
    expect(assetsFetched).toBe(false);
  });

  it("leaves a non-HTML request for / alone", async () => {
    const mockEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => {}, all: async () => ({ results: [] }), first: async () => null }),
          all: async () => ({ results: [] }),
        }),
      } as any,
      ASSETS: { fetch: async () => new Response("SPA", { status: 200 }) } as any,
    } as Env;

    const res = await app.fetch(
      new Request("https://gateway.example.com/", { method: "GET", headers: { Accept: "application/json" } }),
      mockEnv,
    );
    expect(res.status).toBe(200);
  });
});
