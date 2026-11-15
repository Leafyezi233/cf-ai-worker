export type VideoDraft = Record<string, unknown>;

export const videoObject = (v: unknown): VideoDraft => v && typeof v === "object" && !Array.isArray(v) ? v as VideoDraft : {};
export const videoStrings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export function videoSettingsDiagnostics(v: VideoDraft): string[] {
  const issues: string[] = [], resolutions = videoStrings(v.resolutions), ratios = videoStrings(v.ratios);
  const doubao = v.adapter === "doubao", max = doubao ? 30 : 15;
  if (!resolutions.length || !ratios.length) issues.push("规格未完成：请明确填写允许比例和分辨率，空列表不是免费或无限制。");
  if (!resolutions.includes(String(v.default_resolution ?? ""))) issues.push("默认分辨率未填写或不在允许列表；现有值保留，请人工核对。");
  if (!ratios.includes(String(v.default_ratio ?? ""))) issues.push("默认比例不在允许列表；现有值保留。");
  if (typeof v.upstream_model!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v.upstream_model)) issues.push("上游模型未填写或标识格式无效；不会推断或自动替换。");
  const min = v.seconds_min, upper = v.seconds_max;
  if (typeof min !== "number" || typeof upper !== "number" || !Number.isInteger(min) || !Number.isInteger(upper) || min < 4 || upper > max || min > upper) issues.push(`时长边界无效：须为 4–${max} 秒整数，且最短 ≤ 最长。`);
  const duration = v.default_duration;
  if ((typeof duration !== "number" || !Number.isInteger(duration) || typeof min !== "number" || typeof upper !== "number" || duration < min || duration > upper)) issues.push("默认秒数不在生成时长范围内。");
  if (Number(v.min_images ?? 0) > Number(v.max_images)) issues.push("素材矛盾：最少图片不能大于最多图片。");
  if (v.support_audio_only === true && (v.support_audio_urls !== true || !(Number(v.max_audio_only) > 0)) || v.support_audio_only !== true && Number(v.max_audio_only ?? 0) !== 0) issues.push("素材矛盾：纯音频开关、HTTPS 音频与纯音频数量不匹配。");
  if (!Array.isArray(v.quotes) || !v.quotes.length) issues.push("价格未完成：尚无报价；空价格不代表免费，只有显式 0 才是零基础售价。");
  const seen = new Set<string>();
  if (Array.isArray(v.quotes)) v.quotes.forEach((item, i) => {
    const q = videoObject(item), label = `报价 ${i + 1}：`, key = JSON.stringify([q.resolution, q.has_reference_video]);
    if (seen.has(key)) issues.push(label + "重复 resolution + has_reference_video 报价（即使单位不同也不能重复）。");
    seen.add(key);
    if (!resolutions.includes(String(q.resolution ?? ""))) issues.push(label + "分辨率未填写或不在允许列表。");
    if (typeof q.has_reference_video !== "boolean") issues.push(label + "是否含参考视频必须明确。");
    if (q.unit !== "call" && q.unit !== "second") issues.push(label + "单位未填写或无效。");
    if (typeof q.price !== "number" || !Number.isFinite(q.price) || q.price < 0 || q.price > 10000) issues.push(label + "价格未填或不是 0–10000 的有限数字；不会按免费处理。");
  });
  return issues;
}
export function videoBasePrice(quote: VideoDraft, seconds: number): number | null {
  if (typeof quote.price !== "number" || !Number.isFinite(quote.price) || quote.price < 0 || quote.price > 10000 || !Number.isInteger(seconds) || seconds < 1) return null;
  return quote.unit === "call" ? quote.price : quote.unit === "second" ? quote.price * seconds : null;
}
