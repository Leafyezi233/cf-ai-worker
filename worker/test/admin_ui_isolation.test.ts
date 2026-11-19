import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const boundaryPath = "../../web/src/components/AdminLoadBoundary.tsx";
const pathHelper = "../../web/src/api/adminPath.ts";
const clientPath = "../../web/src/api/client.ts";
const { AdminLoadBoundary } = await import(boundaryPath);
const { adminApiPath } = await import(pathHelper);
const { adminFetch } = await import(clientPath);
afterEach(() => vi.unstubAllGlobals());
describe("isolated management UI helpers (not browser E2E)", () => {
  it("derives a changed prefix from the private page without public configuration", () => {
    vi.stubGlobal("window", { location: { pathname: "/custom987/settings" } });
    expect(adminApiPath("/api/settings")).toBe("/custom987/api/settings");
    expect(() => adminApiPath("https://outside.example/api/settings")).toThrow();
  });
  it("keeps CSRF headers and credentials when streaming callers supply their own headers", async () => {
    vi.stubGlobal("window", { location: { pathname: "/admin-prefix-example/playground" } });
    const fetch = vi.fn(async () => new Response("stream")); vi.stubGlobal("fetch", fetch);
    const response = await adminFetch("/api/playground/chat", { method: "POST", body: "{}", headers: { Accept: "text/event-stream" } });
    expect(await response.text()).toBe("stream");
    expect(fetch).toHaveBeenCalledWith("/admin-prefix-example/api/playground/chat", expect.objectContaining({ credentials: "include", headers: expect.objectContaining({ "X-Admin-Request": "1", Accept: "text/event-stream" }) }));
  });
  it("renders children normally and offers full-document login recovery after a module failure", () => {
    vi.stubGlobal("window", { location: { pathname: "/admin-prefix-example/models" } });
    expect(renderToStaticMarkup(createElement(AdminLoadBoundary, null, "CONTENT"))).toBe("CONTENT");
    const boundary = new AdminLoadBoundary({ children: "CONTENT" });
    boundary.state = AdminLoadBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain("管理页面未能加载");
    expect(html).toContain('href="/admin-prefix-example/login"');
    expect(html).not.toContain("CONTENT");
  });
});
