import { parseDoubaoVideoConfig } from "../../../worker/src/gateway/doubao_video_config";
import type { ModelType } from "../types";
import { parseSecureVideoConfig } from "../../../worker/src/gateway/secure_skill_video_config";

export function parseModelTypeConfig(raw: string, validateVideo = true): Record<string, unknown> {
  const config: unknown = JSON.parse(raw.trim() || "{}");
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("高级配置必须是 JSON 对象");
  const obj = config as Record<string, unknown>;
  if (obj.model_type !== undefined && obj.model_type !== "text" && obj.model_type !== "image" && obj.model_type !== "embedding" && obj.model_type !== "video") {
    throw new Error("model_type 必须是 text、image、embedding 或 video");
  }
  if (obj.embedding_profile !== undefined) {
    const profile = obj.embedding_profile;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("embedding_profile 必须是 JSON 对象");
    const { compatibility_key, dimensions } = profile as Record<string, unknown>;
    if (typeof compatibility_key !== "string" || !compatibility_key.trim()) throw new Error("embedding_profile.compatibility_key 必须是非空字符串");
    if (dimensions !== undefined && (typeof dimensions !== "number" || !Number.isSafeInteger(dimensions) || dimensions <= 0)) {
      throw new Error("embedding_profile.dimensions 必须是正整数");
    }
  }
  if (validateVideo && obj.model_type === "video") {
    const video = obj.video;
    if (!video || typeof video !== "object" || Array.isArray(video)) throw new Error("视频模型必须配置 config_json.video 对象");
    const v = video as Record<string, unknown>;
    if (v.adapter === "doubao") {
      if (!parseDoubaoVideoConfig(v)) throw new Error("Doubao 视频分组能力与报价无效；必须显式选择规格、默认值及按次或按秒价格");
      return obj;
    }
    if (v.adapter === "secure_skill") {
      if (!parseSecureVideoConfig(v)) throw new Error("secure_skill 视频能力与报价配置无效；按秒价格必须由管理员明确填写，不会默认套用报价");
      return obj;
    }
    if (Object.keys(v).some(key => !["adapter", "task_id_path", "sizes", "seconds_min", "seconds_max", "failed_statuses", "reference_images"].includes(key))) throw new Error("video 包含未知配置字段");
    if (v.adapter !== "generic") throw new Error("video.adapter 必须为 generic");
    if (typeof v.task_id_path !== "string" || !v.task_id_path.length || v.task_id_path.length > 128 || !v.task_id_path.split(".").every(part => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) && !["__proto__", "prototype", "constructor"].includes(part))) {
      throw new Error("video.task_id_path 必填，必须为安全点分路径；请按上游文档填写，不会猜测任务 ID 字段");
    }
    if (!Array.isArray(v.sizes) || !v.sizes.length || v.sizes.length > 20 || v.sizes.some(size => typeof size !== "string" || !/^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(size) || size.split("x").some(n => Number(n) > 4096)) || new Set(v.sizes).size !== v.sizes.length) {
      throw new Error("video.sizes 必填，显式列出 1–20 个不重复尺寸（宽x高，100–4096）；不会推断尺寸");
    }
    const min = v.seconds_min === undefined ? 3 : v.seconds_min;
    const max = v.seconds_max === undefined ? 15 : v.seconds_max;
    if (typeof min !== "number" || typeof max !== "number" || !Number.isInteger(min) || !Number.isInteger(max) || min < 3 || max > 15 || min > max) throw new Error("video.seconds_min/max 必须为 3–15 范围内的整数且 min ≤ max（默认 3/15）");
    if (v.failed_statuses !== undefined && (!Array.isArray(v.failed_statuses) || v.failed_statuses.length > 20 || v.failed_statuses.some(status => typeof status !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(status) || status === "SUCCESS"))) throw new Error("video.failed_statuses 必须为显式失败状态字符串数组，不能包含 SUCCESS；可省略或留 []，不会猜测失败状态");
    if (v.reference_images !== undefined) {
      const refs = v.reference_images as Record<string, unknown> | null;
      if (!refs || typeof refs !== "object" || Array.isArray(refs) || Object.keys(refs).some(key => !["mapping", "max_images"].includes(key)) || refs.mapping !== "image_images_url" || typeof refs.max_images !== "number" || !Number.isInteger(refs.max_images) || refs.max_images < 1 || refs.max_images > 3) throw new Error("video.reference_images 必须显式配置 {mapping: image_images_url, max_images: 1–3 整数}；省略则禁用，不会猜测映射");
    }
    obj.video = { ...v, seconds_min: min, seconds_max: max };
  }
  return obj;
}

export function videoReferenceConfirmation(raw: string): string | null {
  const config = parseModelTypeConfig(raw);
  const secure = config.video as Record<string, unknown> | undefined;
  if (secure?.adapter === "doubao") return "确认 Doubao 协议的独立分组能力、上游模型、默认规格和每条报价单位已核实？不继承其它协议能力或价格。";
  if (secure?.adapter === "secure_skill") return "确认已按上游分组核对图/视频/音频能力与每秒报价？参考视频上传还需独立配置格式、大小和时长上限；未配置不启用。";
  const refs = (config.video as { reference_images?: { max_images: number } } | undefined)?.reference_images;
  return config.model_type === "video" && refs ? `确认已按上游文档验证参考图映射 image_images_url，允许最多 ${refs.max_images} 张图片？保存将显式启用参考图能力；默认不启用。` : null;
}

export function resolvedModelType(raw: string | null, billingUnit?: "token" | "call"): ModelType {
  try {
    const type = parseModelTypeConfig(raw || "", false).model_type;
    if (type === "text" || type === "image" || type === "embedding" || type === "video") return type;
  } catch {   }
  return billingUnit === "call" ? "image" : "text";
}

export function validateModelBilling(raw: string, billingUnit: "token" | "call"): void {
  parseModelTypeConfig(raw);
  const type = resolvedModelType(raw, billingUnit);
  if (type === "video" && billingUnit !== "call") throw new Error("视频模型仅支持按成功任务次数计费");
  if (type === "image" && billingUnit !== "call") throw new Error("图片模型仅支持按请求次数计费");
  if (type === "embedding" && billingUnit !== "token") throw new Error("向量模型仅支持按输入 Token 计费");
}

export function isEmbeddingModel(model: { model_type?: ModelType; chat_endpoint?: string }): boolean {
  return model.model_type === "embedding" || model.chat_endpoint === "/v1/embeddings";
}

export function isVideoModel(model: { model_type?: ModelType; chat_endpoint?: string }): boolean {
  return model.model_type === "video" || model.chat_endpoint === "/v1/video/generations";
}

export function isTextModel(model: { model_type?: ModelType; chat_endpoint?: string; billing_unit?: string }): boolean {
  return !isEmbeddingModel(model) && !isVideoModel(model) && (model.model_type === "text" || (model.model_type !== "image" && model.billing_unit !== "call"));
}

export const VIDEO_HELP = "Doubao 独立使用 /v1/videos，能力与按次/按秒报价必须显式配置；允许尾帧单独输入与帧+音频，不允许帧混合参考图/视频。首版仅完成生成，下载未配置时不会播放或暴露上游链接。secure_skill 协议使用 /v1/videos：由管理员在 video.quotes 按 resolution + has_reference_video 明确设置 unit=second 和每秒售价，冻结生成秒数×报价后按成功任务结算，不预设价格。上游模型、默认比例与默认秒数必须显式填写，上游地址取供应商的 HTTPS API 基址。参考视频格式/大小/时长必须独立配置，未配置禁用；尾帧必须有首帧，首尾帧不能混用素材。通用视频适配器使用 /v1/video/generations，仅按成功任务次数计费（不是按秒）；Token、缓存和搜索价格保存为 0，响应缓存关闭，未定价不等于免费。必须在高级 JSON 配置 video: {adapter: \"generic\", task_id_path: 实际任务 ID 安全点分路径, sizes: 实际支持尺寸数组, seconds_min?: 3, seconds_max?: 15, failed_statuses?: []}。task_id_path 与 sizes 必填且不会猜测；秒数默认 3/15，失败状态不猜测。参考图默认禁用；仅核实上游后手工声明 reference_images: {mapping: \"image_images_url\", max_images: 1–3}，并在保存时明确确认。不按模型名称推断能力。仅成功任务扣费；submitting / submission_unknown / pending 不是失败，不要换 key 重提。";

export const EMBEDDING_HELP = "向量模型走 /v1/embeddings，仅收输入 Token；输出、缓存与搜索价不适用（保存为 0），响应缓存关闭。不进入在线对话。未声明 embedding_profile 时仅允许单个固定上游，不做跨 member / Auto 路由。可在高级 JSON 声明 embedding_profile: {compatibility_key: 非空字符串, dimensions?: 正整数}；跨成员仍须由后端验证兼容性。";