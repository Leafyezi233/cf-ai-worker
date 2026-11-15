import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const componentPath = "../../web/src/components/ServiceModelNamesPanel.tsx";
const { ServiceModelNamesPanel } = await import(componentPath);
function render() {
  return renderToStaticMarkup(createElement(ServiceModelNamesPanel, { serviceGroupId: "g1", models: [{ id: "map-1", model_key: "stable-model" }], onChanged: async () => {} })).replace(/<[^>]*>/g, "");
}
describe("ServiceModelNamesPanel SSR clarity", () => {
  it("defaults rename to retain old aliases", () => { const text = render(); expect(text).toContain("价格、授权不会合并"); expect(text).toContain("确认全局改名"); });
  it("explains disabled aliases stay recorded", () => { const text = render(); expect(text).toContain("记录会保留"); expect(text).toContain("已停用（记录保留）"); });
  it("does not expose supplier secrets or invoke models", () => { const text = render(); expect(text).not.toMatch(/api[_ -]?key|secret|password|供应商密钥/i); expect(text).toContain("不会自动改名、探测名称或调用模型"); });
  it("makes global rename risk explicit", () => { const text = render(); expect(text).toContain("跨服务组同一公开身份的全局改名"); expect(text).toContain("价格、授权不会合并"); });
});
