import { z } from "zod";
import { readVideoConfig, videoModelError } from "../gateway/video_config";
import { zValidator as zv } from "@hono/zod-validator";
import type { ZodSchema } from "zod";
import type { ValidationTargets } from "hono";
import { secretNamePolicyError } from "../utils/env-secret";
import { protocolConnectionsError } from "../gateway/protocol_connections";

export const zValidator = <Target extends keyof ValidationTargets, T extends ZodSchema>(
  target: Target,
  schema: T
) =>
  zv(target, schema, (result, c) => {
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const fieldPath = firstIssue?.path.join(".");
      const fieldPrefix = fieldPath ? `${fieldPath}: ` : "";
      return c.json(
        {
          error: "validation_error",
          message: `${fieldPrefix}${firstIssue?.message || "Invalid request"}`,
          issues: result.error.issues,
        },
        400
      );
    }
  });

export const LoginSchema = z.object({
  password: z.string().min(1, "密码不能为空"),
});


export const EndpointSchema = z
  .string()
  .url("endpoint 必须是合法的 URL")
  .refine((v) => /^https?:\/\//i.test(v), { message: "endpoint 必须以 http:// 或 https:// 开头" });

const SecretNameSchema = z
  .string()
  .max(100)
  .nullable()
  .optional()
  .refine((v) => secretNamePolicyError(v) === null, {
    message: "环境变量名只能包含字母、数字和下划线，且不能使用网关自身的变量",
  });

const ProviderConfigJsonSchema = z.string().nullable().optional().superRefine((raw, ctx) => {
  if (!raw) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "config_json must be valid JSON" });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  if (Object.prototype.hasOwnProperty.call(parsed, "protocol_connections")) {
    const error = protocolConnectionsError((parsed as Record<string, unknown>).protocol_connections);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }
});

export const CreateProviderSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(100),
  type: z.enum(["anthropic", "openai", "gemini"], {
    errorMap: () => ({ message: "type 必须是 anthropic, openai 或 gemini" }),
  }),
  endpoint: EndpointSchema.nullable().optional(),
  api_key: z.string().nullable().optional(),
  secret_name: SecretNameSchema,
  enabled: z.boolean().optional().default(true),
  config_json: ProviderConfigJsonSchema,
});

export const UpdateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(["anthropic", "openai", "gemini"]).optional(),
  endpoint: EndpointSchema.nullable().optional(),
  api_key: z.string().nullable().optional(),
  secret_name: SecretNameSchema,
  enabled: z.boolean().optional(),
  config_json: ProviderConfigJsonSchema,
});

export const BatchUpdateProvidersSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "ids 列表不能为空"),
  enabled: z.boolean().optional(),
});

export const BatchDeleteProvidersSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "ids 列表不能为空"),
});

const KNOWN_CAPABILITIES = ["vision", "tool_call", "reasoning", "long_context", "audio", "code"];

const EmbeddingProfileSchema = z.object({
  compatibility_key: z.string().min(1).max(128).refine(value => value.trim().length > 0, "compatibility_key must be nonempty"),
  dimensions: z.number().int().min(1).max(4096).optional(),
}).strict();

const ProtocolCapabilitiesSchema = z.object({
  chat_completions: z.boolean().optional(), responses: z.boolean().optional(), messages: z.boolean().optional(),
  chat_route: z.enum(["auto", "native", "responses"]).optional(),
  responses_route: z.enum(["auto", "native", "chat"]).optional(),
  loss_policy: z.enum(["allow", "safe", "strict"]).optional(),
}).strict();
const ProtocolModelsSchema = z.object({
  chat_completions: z.string().min(1).max(150).refine(value => value.trim().length > 0).optional(),
  responses: z.string().min(1).max(150).refine(value => value.trim().length > 0).optional(),
  messages: z.string().min(1).max(150).refine(value => value.trim().length > 0).optional(),
}).strict();

const ModelConfigJsonSchema = z
  .string()
  .nullable()
  .optional()
  .superRefine((raw, ctx) => {
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "config_json must be valid JSON" });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const config = parsed as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(config, "catalog_visible") && typeof config.catalog_visible !== "boolean") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "catalog_visible must be a boolean" });
    }
    if (Object.prototype.hasOwnProperty.call(config, "protocol_capabilities") && !ProtocolCapabilitiesSchema.safeParse(config.protocol_capabilities).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "protocol_capabilities requires known protocol booleans, routes and loss_policy only" });
    }
    if (Object.prototype.hasOwnProperty.call(config, "protocol_models") && !ProtocolModelsSchema.safeParse(config.protocol_models).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "protocol_models must contain only chat_completions, responses and messages with nonempty model IDs (<=150)" });
    }
    const modelType = (parsed as Record<string, unknown>).model_type;
    if (modelType !== undefined && modelType !== "text" && modelType !== "image" && modelType !== "embedding" && modelType !== "video") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "model_type must be text, image, embedding or video" });
    }
    if ((modelType === "video" || Object.prototype.hasOwnProperty.call(parsed, "video")) &&
      !readVideoConfig({ config_json: JSON.stringify({ ...parsed, model_type: "video" }) })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "video requires an explicit valid adapter: moyuu with safe task_id_path and sizes, or secure_skill / doubao with declared capabilities and an exact ratecard" });
    }
    const profile = (parsed as Record<string, unknown>).embedding_profile;
    if (profile !== undefined && !EmbeddingProfileSchema.safeParse(profile).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "embedding_profile requires a nonempty compatibility_key (<=128), optional integer dimensions (1..4096), and no other fields" });
    }
    const responsesMode = (parsed as Record<string, unknown>).responses_mode;
    if (responsesMode !== undefined && (typeof responsesMode !== "string" || !["native", "chat_adapter", "disabled"].includes(responsesMode))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "responses_mode must be native, chat_adapter or disabled" });
    }
    const declared = (parsed as Record<string, unknown>).capabilities;
    if (!Array.isArray(declared)) return;
    const unknownWords = declared.filter((word) => {
      if (typeof word !== "string") return true;
      return !KNOWN_CAPABILITIES.includes(word);
    });
    if (unknownWords.length === 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `未知的能力 ${JSON.stringify(unknownWords)}，可用值：${KNOWN_CAPABILITIES.join(" / ")}`,
    });
  });

export const CreateModelSchema = z.object({
  provider_id: z.string().min(1, "provider_id 不能为空"),
  model_name: z.string().min(1, "model_name 不能为空").max(150),
  display_name: z.string().nullable().optional(),
  alias: z.string().nullable().optional(),
  fallback_model_id: z.string().nullable().optional(),
  input_price_per_m: z.number().min(0).optional().default(0),
  output_price_per_m: z.number().min(0).optional().default(0),
  cache_read_price_per_m: z.number().min(0).optional().default(0),
  cache_write_price_per_m: z.number().min(0).optional().default(0),
  pricing_mode: z.enum(["unset", "free", "priced"]).optional(),
  peak_pricing_enabled: z.boolean().optional(),
  billing_unit: z.enum(["token", "call"]).optional().default("token"),
  price_per_call: z.number().min(0).optional().default(0),
  search_price_per_call: z.number().min(0).optional().default(0),
  cache_enabled: z.boolean().optional().default(false),
  cache_ttl: z.number().min(60).optional().default(3600),
  enabled: z.boolean().optional().default(true),
  model_public: z.boolean().optional().default(false),
  config_json: ModelConfigJsonSchema,
}).superRefine((row, ctx) => {
  const videoError = videoModelError(row);
  if (videoError) ctx.addIssue({ code: z.ZodIssueCode.custom, message: videoError });
  let cfg: any; try { cfg = JSON.parse(row.config_json || "{}"); } catch { return; }
  if (cfg?.model_type === "embedding" && row.billing_unit !== "token") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["billing_unit"], message: "embedding models require token billing" });
  }
});

export const UpdateModelSchema = z.object({
  provider_id: z.string().min(1).optional(),
  model_name: z.string().min(1).max(150).optional(),
  display_name: z.string().nullable().optional(),
  alias: z.string().nullable().optional(),
  fallback_model_id: z.string().nullable().optional(),
  input_price_per_m: z.number().min(0).optional(),
  output_price_per_m: z.number().min(0).optional(),
  cache_read_price_per_m: z.number().min(0).optional(),
  cache_write_price_per_m: z.number().min(0).optional(),
  pricing_mode: z.enum(["unset", "free", "priced"]).optional(),
  peak_pricing_enabled: z.boolean().optional(),
  billing_unit: z.enum(["token", "call"]).optional(),
  price_per_call: z.number().min(0).optional(),
  search_price_per_call: z.number().min(0).optional(),
  cache_enabled: z.boolean().optional(),
  cache_ttl: z.number().min(60).optional(),
  enabled: z.boolean().optional(),
  model_public: z.boolean().optional(),
  config_json: ModelConfigJsonSchema,
});

export const BatchCreateModelItemSchema = z.union([
  z.string().min(1),
  z.object({
    model_name: z.string().min(1, "model_name 不能为空"),
    display_name: z.string().optional(),
    alias: z.string().optional(),
  }),
]);

export const BatchCreateModelsSchema = z.object({
  provider_id: z.string().min(1, "provider_id 不能为空"),
  models: z.array(BatchCreateModelItemSchema).min(1, "models 列表不能为空"),
});

export const BatchUpdateModelsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "ids 列表不能为空"),
  enabled: z.boolean().optional(),
  cache_enabled: z.boolean().optional(),
  cache_ttl: z.number().min(60).optional(),
  model_public: z.boolean().optional(),
  pricing_mode: z.enum(["unset", "free", "priced"]).optional(),
  peak_pricing_enabled: z.boolean().optional(),
});

export const BatchDeleteModelsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "ids 列表不能为空"),
});

const MINUTE_RE = /^\d{2}:\d{2}$/;

function parseMinute(value: string): number {
  if (!MINUTE_RE.test(value)) return -1;
  const [h, m] = value.split(":").map((n) => Number(n));
  if (h > 23 || m > 59) return -1;
  return h * 60 + m;
}

const DAY_TYPE_VALUES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "weekday", "weekend"] as const;

export const PriceWindowsSchema = z.object({
  windows: z
    .array(
      z.object({
        day_type: z.enum(DAY_TYPE_VALUES),
        start: z.string().refine((v) => parseMinute(v) >= 0, "start 必须是 HH:MM"),
        end: z.string().refine((v) => parseMinute(v) >= 0, "end 必须是 HH:MM"),
        multiplier: z.number().min(0, "multiplier 不能为负").max(1000),
        enabled: z.boolean().optional().default(true),
      })
    )
    .max(200, "单个模型的时段过多"),
});

export type PriceWindowInput = z.infer<typeof PriceWindowsSchema>["windows"][number];

export function priceWindowMinutes(w: PriceWindowInput): {
  start_minute: number;
  end_minute: number;
} {
  return { start_minute: parseMinute(w.start), end_minute: parseMinute(w.end) };
}

const GroupPricingFields = {
  display_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  input_price_per_m: z.number().min(0).optional().default(0),
  output_price_per_m: z.number().min(0).optional().default(0),
  cache_read_price_per_m: z.number().min(0).optional().default(0),
  cache_write_price_per_m: z.number().min(0).optional().default(0),
  pricing_mode: z.enum(["unset", "free", "priced"]).optional(),
  peak_pricing_enabled: z.boolean().optional(),
  billing_unit: z.enum(["token", "call"]).optional().default("token"),
  price_per_call: z.number().min(0).optional().default(0),
  search_price_per_call: z.number().min(0).optional().default(0),
  cache_enabled: z.boolean().optional().default(false),
  cache_ttl: z.number().min(60).optional().default(3600),
  enabled: z.boolean().optional().default(true),
  model_public: z.boolean().optional().default(false),
  config_json: ModelConfigJsonSchema,
};

export const CreateModelGroupSchema = z.object({
  name: z.string().min(1, "name 不能为空").max(150),
  ...GroupPricingFields,
}).superRefine((row, ctx) => {
  const error = videoModelError(row);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

export const UpdateModelGroupSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  display_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  input_price_per_m: z.number().min(0).optional(),
  output_price_per_m: z.number().min(0).optional(),
  cache_read_price_per_m: z.number().min(0).optional(),
  cache_write_price_per_m: z.number().min(0).optional(),
  pricing_mode: z.enum(["unset", "free", "priced"]).optional(),
  peak_pricing_enabled: z.boolean().optional(),
  billing_unit: z.enum(["token", "call"]).optional(),
  price_per_call: z.number().min(0).optional(),
  search_price_per_call: z.number().min(0).optional(),
  cache_enabled: z.boolean().optional(),
  cache_ttl: z.number().min(60).optional(),
  enabled: z.boolean().optional(),
  model_public: z.boolean().optional(),
  config_json: ModelConfigJsonSchema,
});

export const ModelGroupMembersSchema = z.object({
  members: z
    .array(
      z.object({
        model_id: z.string().min(1, "model_id 不能为空"),
        position: z.number().int().min(0).max(100000).optional(),
        enabled: z.boolean().optional().default(true),
      })
    )
    .max(200, "单个组的成员过多")
    .optional()
    .default([]),
});

export const CreateDeviceSchema = z.object({
  name: z.string().min(1, "设备名称不能为空").max(100),
  rate_limit_rpm: z.number().int().min(0).optional().default(0),
  cost_limit_monthly: z.number().min(0).optional().default(0),
  balance_usd: z.number().min(0).optional(),
});

export const UpdateDeviceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  rate_limit_rpm: z.number().int().min(0).optional(),
  cost_limit_monthly: z.number().min(0).optional(),
  calls_enabled: z.boolean().optional(),
});

function boundedRpmRecord() {
  return z
    .record(z.string().min(1).max(100), z.number().int().min(0).max(100000))
    .refine((v) => Object.keys(v).length <= 500, { message: "最多只能为 500 个条目设置每分钟上限" });
}

export const ModelScopeSchema = z.object({
  model_scope: z.enum(["all", "list", "all_and_list"]),
  model_ids: z.array(z.string().min(1)).max(500).optional().default([]),
  model_rpms: boundedRpmRecord().optional().default({}),
  group_ids: z.array(z.string().min(1)).max(500).optional().default([]),
  group_rpms: boundedRpmRecord().optional().default({}),
});

export const CreateDeviceTemplateSchema = z.object({
  name: z.string().min(1, "模板名称不能为空").max(100),
  description: z.string().max(500).nullable().optional(),
  model_scope: z.enum(["all", "list", "all_and_list"]).optional().default("list"),
  model_ids: z.array(z.string().min(1)).max(500).optional().default([]),
  model_rpms: boundedRpmRecord().optional().default({}),
  group_ids: z.array(z.string().min(1)).max(500).optional().default([]),
  group_rpms: boundedRpmRecord().optional().default({}),
});

export const UpdateDeviceTemplateSchema = CreateDeviceTemplateSchema.partial();

export const ApplyDeviceTemplateSchema = z.object({
  device_ids: z.union([z.array(z.string().min(1)).max(2000), z.literal("all")]).optional().default([]),
  mode: z.enum(["replace", "merge"]).optional().default("replace"),
});

export const TopupSchema = z.object({
  mode: z.enum(["delta", "set"]).optional().default("delta"),
  amount_usd: z.number().optional(),
  target_balance_usd: z.number().optional(),
  note: z.string().max(200).nullable().optional(),
  request_id: z.string().min(1).max(100).nullable().optional(),
});

export const AggregateStatsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date 必须为 YYYY-MM-DD 格式").optional(),
});

export const CcSwitchPreviewSchema = z.object({
  raw: z.string().min(1, "配置内容不能为空"),
});

export const CcSwitchImportItemSchema = z.object({
  name: z.string().min(1, "Provider 名称不能为空").max(100),
  type: z.enum(["anthropic", "openai", "gemini"]),
  endpoint: EndpointSchema.nullable().optional(),
  api_key: z.string().nullable().optional(),
  enabled: z.boolean().optional().default(true),
  models: z
    .array(
      z.object({
        model_name: z.string().min(1),
        display_name: z.string().optional(),
        alias: z.string().optional(),
        input_price_per_m: z.number().optional(),
        output_price_per_m: z.number().optional(),
      })
    )
    .optional()
    .default([]),
  config_json: ProviderConfigJsonSchema,
});

export const CcSwitchImportSchema = z.object({
  raw: z.string().optional(),
  items: z.array(CcSwitchImportItemSchema).optional(),
  overwrite: z.boolean().optional().default(false),
  import_models: z.boolean().optional().default(true),
});
