import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { newStandardVideoAttempt, parseStandardVideoTask, standardAttemptFinished } from "../../web/src/utils/standardVideoTask";

const componentPath = "../../web/src/components/ConsoleStandardVideoCard.tsx";
const { ConsoleStandardVideoCard, StandardVideoTaskCard, StandardVideoTicketMedia } = await import(componentPath);
const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const render = (component: unknown, props: unknown) => renderToStaticMarkup(createElement(component, props));
const input = { model: "public-video", prompt: "Sea", duration: 5, ratio: "16:9", resolution: "720p" };
const limits = { resolutions: ["720p"], ratios: ["16:9"], default_resolution: "720p", default_duration: 5, seconds_min: 4, seconds_max: 15 };
const models = { items: [{ id: "public", model_name: input.model, model_type: "video", video: limits }] };
const task = (extra: Record<string, unknown> = {}) => parseStandardVideoTask({ ...input, id: "local_task", status: "queued", ...extra });
const source = readFileSync(new URL(componentPath, import.meta.url), "utf8");
const adminHelp = "生成完成，下载未配置，请联系管理员获取帮助；无需重新生成，请勿重复付费提交。";

describe("console video readability without changing paid-task safety", () => {
  it("separates task status, identifier, specs and settled price", () => {
    const html = render(StandardVideoTaskCard, { task: task({ cost: 1.2 }), token: "" });
    expect(html).toContain("视频任务</h3>");
    expect(html).toContain("排队中</span>");
    expect(html).toContain("任务编号：");
    expect(html).toContain("local_task");
    expect(html).toContain("<dl");
    for (const label of ["模型", "时长", "画面比例", "分辨率", "已结算 ¥1.2000"]) expect(html).toContain(label);
    expect(html).toContain("手动查询任务");
    expect(html).not.toContain("播放 / 下载");
  });

  it("keeps the complete administrator guidance visible, not folded", () => {
    const html = render(StandardVideoTaskCard, { task: task({ status: "completed", content_available: false }), token: "" });
    expect(html).toContain(adminHelp);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("播放 / 下载");
  });

  it("shows unknown/review safety and never offers a new paid task on the task card", () => {
    const unknown = task({ status: "submission_unknown" });
    const html = render(StandardVideoTaskCard, { task: unknown, token: "", disabled: true });
    expect(html).toContain("提交结果未知");
    expect(html).toContain("需要人工复核；禁止重新付费提交。");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("创建视频");
    expect(html).not.toContain("播放 / 下载");
    expect(standardAttemptFinished(newStandardVideoAttempt(input))).toBe(false);
    expect(standardAttemptFinished({ ...newStandardVideoAttempt(input), task: unknown })).toBe(false);
  });

  it("keeps form steps and pricing readable without folding controls", () => {
    const html = render(ConsoleStandardVideoCard, { models, active: true });
    for (const label of ["1. 描述视频", "2. 设置生成规格", "3. 选择参考方式", "4. 提交与查询", "未定价不等于免费", "查询与刷新不会生成新视频"]) expect(html).toContain(label);
    expect(html).toMatch(/<summary[^>]*>查看计费与报价说明<\/summary>/);
    expect(html).toContain("¥/秒：单价乘以生成秒数。");
    expect(html).toContain("¥/次：按一次成功任务计费。");
    const folded = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) || [];
    expect(folded).toHaveLength(1);
    expect(folded[0]).not.toMatch(/<(?:button|input|textarea|select)\b/);
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('value="5"');
  });

  it("does not expose upstream URLs or render untrusted/expired ticket media", () => {
    const html = render(StandardVideoTaskCard, { task: task({ status: "completed", result_url: "https://supplier.invalid/private", url: "https://supplier.invalid/raw" }), token: "" });
    expect(html).toContain(adminHelp);
    expect(html).not.toContain("supplier.invalid");
    expect(html).not.toMatch(/<(?:a|video)\b/);
    const path = "/v1/videos/local_task/content";
    for (const ticket of [
      { url: "https://supplier.invalid/private", expires_at: Date.now() + 60000 },
      { url: path + "?ticket=enc%3Av1%3Aabc.def", expires_at: 1 },
    ]) expect(render(StandardVideoTicketMedia, { ticket, path })).toBe("");
  });

  it("keeps unknown-submit warnings outside technical details and preserves explicit action guards (structure, not browser E2E)", () => {
    const attemptSection = source.slice(source.indexOf('{attempt?<div'), source.indexOf('{error?<p role="alert">{error}</p>:null}', source.indexOf('{attempt?<div')));
    const expanded = attemptSection.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
    expect(expanded).toContain("提交确认未知，请勿创建新提交。");
    expect(expanded).toContain("仅可主动用原 key + 原参数查询式重发；不会自动付费重试。");
    expect(expanded).toContain("需管理员人工复核，不可换 key 重新提交。");
    expect(expanded).toContain('onClick={()=>void submit(true)}');
    expect(expanded).toContain('standardAttemptFinished(attempt)?<Button disabled={unavailable}');
    expect(source).toContain('if(retry){if(!frozen||frozen.task||frozen.conflict)throw Error();}');
    expect(source).toContain('disabled={unavailable||locked||uploadError||!selected} onClick={()=>void submit()}');
    expect(source.indexOf('await saveStandardVideoAttempt(token,frozen!,localStorage)')).toBeLessThan(source.indexOf('await standardVideoApi.create(token,frozen!'));
    const refresh = source.slice(source.indexOf('async function refresh'), source.indexOf('async function newIntent'));
    expect(refresh).not.toContain('standardVideoApi.create');
    expect(refresh).not.toContain('saveStandardVideoAttempt(token,null');
  });
});
