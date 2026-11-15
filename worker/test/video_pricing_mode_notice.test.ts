import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const path = "../../web/src/components/VideoPricingModeNotice";
const { videoPricingModeNotice, VideoPricingModeNotice } = await import(path);
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const raw = (adapter = "doubao", price: unknown = 0.18) => JSON.stringify({model_type:"video",custom:{keep:true},video:{adapter,quotes:[{resolution:"720p",has_reference_video:false,unit:"second",price}]}});
const render = (configJson: string, pricingMode: "auto"|"free"|"priced", onChoosePriced = vi.fn()) => renderToStaticMarkup(createElement(VideoPricingModeNotice, {configJson,pricingMode,onChoosePriced}));

describe("video pricing-mode guidance does not change pricing", () => {
  it.each(["doubao","secure_skill"])("warns %s auto mode without claiming quotes enable it", adapter => {
    const notice = videoPricingModeNotice(raw(adapter), "auto");
    expect(notice?.confirmation).toContain("确认保留自动模式并保存");
    expect(notice?.detail).toContain("已有模型还可能沿用原计费状态");
    expect(render(raw(adapter),"auto")).toContain("已填规格报价 ≠ 已启用按价计费");
  });
  it.each([0,0.18])("does not infer free or priced from quote %s", price => {
    expect(videoPricingModeNotice(raw("doubao",price),"auto")?.confirmation).toBeTruthy();
    expect(videoPricingModeNotice(raw("doubao",price),"priced")?.confirmation).toBeNull();
  });
  it("distinguishes explicit free and free/nonzero conflict without altering numeric price", () => {
    const json = raw();
    expect(render(json,"free")).toContain("免费模式与非零规格报价冲突");
    expect(JSON.parse(json).video.quotes[0].price).toBe(0.18);
    expect(render(raw("doubao",0),"free")).toContain("已明确选择免费模式");
    expect(render(raw("doubao",null),"free")).toContain("空报价不代表免费");
  });
  it("switches only after explicit click, never on render and never changes the draft", () => {
    const onChoosePriced=vi.fn(), configJson=raw();
    render(configJson,"auto",onChoosePriced); expect(onChoosePriced).not.toHaveBeenCalled();
    const tree=VideoPricingModeNotice({configJson,pricingMode:"auto",onChoosePriced});
    const button=tree!.props.children.find((node: any)=>node && node.props?.onClick);
    expect(button.props.type).toBe("button"); button.props.onClick();
    expect(onChoosePriced).toHaveBeenCalledTimes(1); expect(configJson).toBe(raw());
  });
  it("priced mode clarifies multipliers and shows no mode-changing button", () => {
    const html=render(raw(),"priced");
    expect(html).toContain("服务分组与峰谷倍率");expect(html).not.toContain("<button");
  });
  it.each(["{bad","[]",JSON.stringify({model_type:"text",video:{adapter:"doubao"}}),raw("moyuu")])("leaves invalid/unrelated drafts alone: %s", configJson => {
    expect(videoPricingModeNotice(configJson,"auto")).toBeNull();expect(render(configJson,"auto")).toBe("");
  });
});
