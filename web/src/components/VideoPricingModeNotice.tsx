import { parseModelTypeConfig } from "../utils/modelType";
import { Button } from "./ui";

export type VideoPricingMode = "auto" | "free" | "priced";

export function videoPricingModeNotice(configJson: string, pricingMode: VideoPricingMode) {
  let config: Record<string, unknown>;
  try { config = parseModelTypeConfig(configJson, false); } catch { return null; }
  if (config.model_type !== "video" || !config.video || typeof config.video !== "object" || Array.isArray(config.video)) return null;
  const video = config.video as Record<string, unknown>;
  if (video.adapter !== "secure_skill" && video.adapter !== "doubao") return null;
  const quotes = Array.isArray(video.quotes) ? video.quotes : [];
  const hasNonzeroQuote = quotes.some(q => q && typeof q === "object" && typeof q.price === "number" && Number.isFinite(q.price) && q.price !== 0);
  if (pricingMode === "auto") return {
    tone: "warning" as const,
    title: "已填规格报价 ≠ 已启用按价计费",
    detail: "自动模式不读取 video.quotes 来启用计费；新建模型可能仍是未配置，并被网关拒绝。已有模型还可能沿用原计费状态。请核对后显式选择「按价计费」，不要把每秒价格填到旧的单次价格字段。",
    confirmation: "当前视频仍选择「自动」：规格报价不会自动启用按价计费，新模型可能继续未定价，已有模型可能沿用原状态。确认保留自动模式并保存？如需按报价收费，请取消并显式选择「按价计费」。",
  };
  if (pricingMode === "free") return {
    tone: hasNonzeroQuote ? "warning" as const : "info" as const,
    title: hasNonzeroQuote ? "免费模式与非零规格报价冲突" : "已明确选择免费模式",
    detail: hasNonzeroQuote
      ? "网关会拒绝免费模式下的非零视频报价，不会静默清零或按此价格收费。若要收费，请选择「按价计费」；若确实免费，请逐项明确改为 0。"
      : "免费视频仍须明确填写每条规格报价为 0，空报价不代表免费；规格、素材能力及服务端校验仍然有效。",
    confirmation: null,
  };
  return {
    tone: "info" as const,
    title: "已明确选择按价计费",
    detail: "使用上方独立规格报价，不使用旧的单次价格字段。模型基础报价还会乘以所选服务分组与峰谷倍率；保存时仍执行严格校验，界面试算不是最终账单。",
    confirmation: null,
  };
}

export function VideoPricingModeNotice({ configJson, pricingMode, onChoosePriced }: {
  configJson: string; pricingMode: VideoPricingMode; onChoosePriced: () => void;
}) {
  const notice = videoPricingModeNotice(configJson, pricingMode);
  if (!notice) return null;
  return <div role="note" className={"mt-3 rounded-xl border p-3 space-y-2 text-xs " + (notice.tone === "warning"
    ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    : "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-200")}>
    <p className="font-semibold">{notice.title}</p>
    <p className="leading-relaxed">{notice.detail}</p>
    {pricingMode !== "priced" ? <Button type="button" size="sm" variant="outline" onClick={onChoosePriced}>明确选择按价计费（不修改报价）</Button> : null}
  </div>;
}
