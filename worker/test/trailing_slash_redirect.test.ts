import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

function makeEnv() {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => {},
          all: async () => ({ results: [] }),
          first: async () => null,
        }),
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    },
    ASSETS: {
      fetch: async () => new Response("<!doctype html><html><body>SPA</body></html>", { status: 200 }),
    },
  } as unknown as Env;
}

describe("trailing-slash normalization for API callers", () => {
  it("redirects an API-shaped GET with a trailing slash to the canonical path", async () => {
    const res = await app.fetch(
      new Request("https://gw.example.com/user/balance/", {
        headers: { Accept: "*/*", authorization: "Bearer tok" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://gw.example.com/user/balance");
  });

  it("also normalizes a no-auth request that is not asking for HTML", async () => {
    const res = await app.fetch(
      new Request("https://gw.example.com/v1/models/", { headers: { Accept: "application/json" } }),
      makeEnv(),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://gw.example.com/v1/models");
  });

  it("preserves the query string across the redirect", async () => {
    const res = await app.fetch(
      new Request("https://gw.example.com/v1/dashboard/billing/usage/?start=1&end=2", {
        headers: { authorization: "Bearer tok" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://gw.example.com/v1/dashboard/billing/usage?start=1&end=2");
  });

  it("leaves browser HTML navigations alone (pages own their trailing slash, e.g. /console/)", async () => {
    const res = await app.fetch(
      new Request("https://gw.example.com/console/", {
        headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SPA");
  });

  it("leaves the bare root alone", async () => {
    const res = await app.fetch(
      new Request("https://gw.example.com/", { headers: { authorization: "Bearer tok" } }),
      makeEnv(),
    );
    expect(res.status).not.toBe(308);
  });
});
