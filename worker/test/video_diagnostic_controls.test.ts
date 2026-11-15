import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const apiPath = "../../web/src/api/videoDiagnostics";
const { controlVideoDiagnostics } = await import(apiPath);
const componentPath = "../../web/src/components/VideoDiagnosticControls.tsx";
const { VideoDiagnosticControls } = await import(componentPath);
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const result = (armed = true) => ({ ok: true, device_id: "dev_account", armed, enabled_until: armed ? Date.now() + 86400000 : null, retention_days: 7 });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("administrator video diagnostic controls", () => {
  it.each(["arm", "disarm"] as const)("only sends the explicit %s action for the selected account", async (operation: "arm" | "disarm") => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result(operation === "arm")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await controlVideoDiagnostics("dev_account", operation);
    expect(response.armed).toBe(operation === "arm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; credentials: string; body: string }];
    expect(path).toBe("/api/video-tasks/diagnostics/" + operation);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({ device_id: "dev_account" });
  });
  it.each([401, 403, 503])("does not report success or retry after HTTP %s", async (status) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "diagnostic_unavailable" }), { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(controlVideoDiagnostics("dev_account", "arm")).rejects.toThrow("diagnostic_unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not retry an ambiguous network failure", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("network unavailable"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(controlVideoDiagnostics("dev_account", "arm")).rejects.toThrow("network unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    null, {}, { ...result(), ok: false }, { ...result(), device_id: "other" },
    { ...result(), armed: false }, { ...result(), enabled_until: null }, { ...result(), enabled_until: "tomorrow" },
  ])("rejects a malformed or mismatched success response", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(controlVideoDiagnostics("dev_account", "arm")).rejects.toThrow("无法确认");
  });
  it("also verifies cancellation acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(result(true)), { status: 200 })));
    await expect(controlVideoDiagnostics("dev_account", "disarm")).rejects.toThrow("无法确认");
  });
  it("renders scope, privacy, cancellation limitations and no paid submission", () => {
    const html = renderToStaticMarkup(createElement(VideoDiagnosticControls, { deviceId: "dev_account", deviceName: "<Account>" }));
    expect(html).toContain("采样下一笔视频");
    expect(html).toContain("取消待采样");
    expect(html).toContain("主 Token 和子 Token 共用一次名额");
    expect(html).toContain("24 小时");
    expect(html).toContain("7 天");
    expect(html).toContain("不会生成视频或触发付费请求");
    expect(html).toContain("不会停止已绑定任务的采样");
    expect(html).not.toContain("启用成功：请在");
    expect(html).toContain("&lt;Account&gt;");
  });
  it("wires account identity and guards duplicate clicks without effect-driven mutation", () => {
    const component = readFileSync(new URL(componentPath, import.meta.url), "utf8");
    const page = readFileSync(new URL("../../web/src/pages/DevicesPage.tsx", import.meta.url), "utf8");
    expect(component).toContain("if (inFlight.current) return;");
    expect(component).toContain("disabled={busy !== null}");
    expect(component).not.toContain("useEffect");
    expect(component).not.toContain("/video/generations");
    expect(page).toContain("setDiagnosticDevice(d)");
    expect(page).toContain("if (!diagnosticBusy) setDiagnosticDevice(null)");
    expect(component).toContain("onBusyChange?.(true)");
    expect(page).toContain("key={diagnosticDevice.id} deviceId={diagnosticDevice.id}");
  });
});
