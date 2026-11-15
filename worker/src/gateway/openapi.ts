import type { Env } from "../types";
import { getDeviceGroupIds, getDeviceModelIds, isModelInScope, listGroupsForDevice, listModelProjectionsForDevice, listModels, listProviders } from "../db/repo";
import type { DeviceRow } from "../types";
import { inferModelCapabilities } from "./catalog";
import { resolveModelType } from "./model_type";
import { isRawCatalogVisible } from "./catalog_visibility";

export async function generateOpenApiSpec(
  env: Env,
  baseUrl?: string,
  opts: { includePrivateModels?: boolean; device?: DeviceRow | null } = {}
): Promise<Record<string, unknown>> {
  const selection = opts.device?.service_group_id ?? opts.device?.default_service_group_id;
  const serviceSelected = !!opts.device?.token_routing_policy || (selection != null && selection !== "legacy");
  const [models, providers, groups] = await Promise.all([
    serviceSelected ? Promise.resolve([]) : listModels(env, { includeSecrets: false }),
    listProviders(env, { includeSecrets: false }),
    serviceSelected ? Promise.resolve([]) : listGroupsForDevice(env, opts.device ?? null, { includePrivate: opts.includePrivateModels }),
  ]);

  const scope = opts.device?.model_scope || "all";
  const whitelisted =
    opts.device && !serviceSelected && scope !== "all" ? new Set(await getDeviceModelIds(env, opts.device.id)) : null;
  const deviceGroups =
    opts.device && !serviceSelected && scope !== "all" ? new Set(await getDeviceGroupIds(env, opts.device.id)) : new Set<string>();

  const enabledModels = models.filter(
    (m) =>
      m.enabled === 1 && isRawCatalogVisible(m) &&
      (opts.includePrivateModels || m.model_public) &&
      (!whitelisted || isModelInScope(scope, m.id, whitelisted, Boolean(m.model_public))),
  );
  const enabledProviders = providers.filter((p) => p.enabled === 1);

  const enabledGroups = groups.filter(
    (g) =>
      g.enabled === 1 && isRawCatalogVisible(g) &&
      (opts.includePrivateModels || g.model_public) &&
      (!opts.device || isModelInScope(opts.device.model_scope || "all", g.id, deviceGroups, Boolean(g.model_public))),
  );

  const documentedModels = serviceSelected
    ? await listModelProjectionsForDevice(env, opts.device ?? null)
    : enabledModels;
  const conversationModels = documentedModels.filter(model => !["embedding", "video"].includes(resolveModelType(model)));
  const embeddingModels = documentedModels.filter(model => resolveModelType(model) === "embedding");
  const modelIds = Array.from(
    new Set([
      ...conversationModels.map((m) => m.model_name),
      ...conversationModels.map((m) => m.alias).filter((a): a is string => Boolean(a)),
      ...enabledGroups.filter(group => !["embedding", "video"].includes(resolveModelType(group))).map((g) => g.model_name),
    ])
  );
  const embeddingModelIds = Array.from(new Set([
    ...embeddingModels.map(model => model.model_name),
    ...embeddingModels.map(model => model.alias).filter((alias): alias is string => Boolean(alias)),
    ...enabledGroups.filter(group => resolveModelType(group) === "embedding").map(group => group.model_name),
  ]));

  const videoModels = documentedModels.filter(model => resolveModelType(model) === "video");
  const videoModelIds = Array.from(new Set([
    ...videoModels.map(model => model.model_name),
    ...videoModels.map(model => model.alias).filter((alias): alias is string => Boolean(alias)),
    ...enabledGroups.filter(group => resolveModelType(group) === "video").map(group => group.model_name),
  ]));

  const serverUrl = baseUrl || env.GATEWAY_BASE_URL || "https://gateway.example.com";

  return {
    openapi: "3.0.3",
    info: {
      title: env.APP_NAME ? `${env.APP_NAME} API` : "CPG Personal AI Gateway API",
      version: "1.0.0",
      description:
        "High-performance personal unified AI Gateway deployed on Cloudflare Workers edge network. Seamlessly proxy, multiplex, cache, and rate-limit OpenAI, Anthropic, Gemini, and DeepSeek upstream models.",
      contact: {
        name: "Gateway Administrator",
      },
    },
    servers: [
      {
        url: serverUrl,
        description: "Primary Edge AI Gateway Server",
      },
    ],
    paths: {
      "/v1/chat/completions": {
        post: {
          summary: "OpenAI-compatible Chat Completions",
          description:
            "Create a model response for the given chat conversation. Compatible with OpenAI Python/Node SDK, LangChain, Cursor, and any OpenAI-compatible client.",
          operationId: "createChatCompletion",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ChatCompletionRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response (JSON object or Server-Sent Events stream)",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ChatCompletionResponse",
                  },
                },
                "text/event-stream": {
                  schema: {
                    type: "string",
                    description: "SSE stream with data: [DONE] chunks",
                  },
                },
              },
            },
            "401": {
              $ref: "#/components/responses/UnauthorizedError",
            },
            "429": {
              $ref: "#/components/responses/RateLimitError",
            },
            "500": {
              $ref: "#/components/responses/InternalServerError",
            },
          },
        },
      },
      "/v1/embeddings": {
        post: {
          summary: "OpenAI-compatible Embeddings",
          description: "Create embeddings for 1 to 64 non-empty text strings. The request body is limited to 256 KiB; this endpoint does not support streaming, token arrays, caching, or token output billing. Usage reports input tokens only.",
          operationId: "createEmbedding",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/EmbeddingRequest" } } } },
          responses: {
            "200": { description: "Embedding vectors and input-token usage", content: { "application/json": { schema: { $ref: "#/components/schemas/EmbeddingResponse" } } } },
            "400": { description: "Invalid embedding request, unsupported option, or body over 256 KiB" },
            "401": { $ref: "#/components/responses/UnauthorizedError" },
            "429": { $ref: "#/components/responses/RateLimitError" },
            "500": { $ref: "#/components/responses/InternalServerError" },
          },
        },
      },
      "/v1/messages": {
        post: {
          summary: "Anthropic-compatible Messages API",
          description:
            "Send a structured list of input messages and get a Claude model response. Compatible with Anthropic SDK. " +
            "Server-side tools the caller declares (for example web_search) run upstream and are billed per " +
            "search on top of the token charge: the gateway adds search_calls x the model's search_price_per_call, " +
            "and that surcharge is never multiplied by the peak multiplier. A model whose search_price_per_call " +
            "is 0 (the default) charges nothing for searches.",
          operationId: "createAnthropicMessage",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AnthropicMessageRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response from Anthropic Claude model",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                  },
                },
              },
            },
            "401": {
              $ref: "#/components/responses/UnauthorizedError",
            },
            "429": {
              $ref: "#/components/responses/RateLimitError",
            },
          },
        },
      },
      "/v1/video/generations": {
        post: {
          summary: "Submit a video task",
          description: "Video generation with optional private reference image IDs, only when the model explicitly declares image/images URL mapping. Requires an explicit video model using call billing. One successful task is charged exactly once at price_per_call; submitting, listing and polling do not create additional charges. Failed tasks are not billed. Reuse the same Idempotency-Key for retries of the same request.",
          operationId: "createVideoGeneration",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]{8,128}$" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/VideoGenerationRequest" } } } },
          responses: {
            "200": { description: "Idempotent replay of the same task", content: { "application/json": { schema: { $ref: "#/components/schemas/VideoTask" } } } },
            "202": { description: "New task accepted; submission may remain unconfirmed", content: { "application/json": { schema: { $ref: "#/components/schemas/VideoTask" } } } },
            "400": { description: "Invalid request, reference IDs, video configuration, size, duration or missing idempotency key" },
            "409": { description: "Idempotency key conflicts with an existing request" },
            "402": { description: "Insufficient balance for the task hold" },
            "413": { description: "Request exceeds the 32 KiB limit" },
            "401": { $ref: "#/components/responses/UnauthorizedError" },
            "429": { $ref: "#/components/responses/RateLimitError" },
          },
        },
        get: {
          summary: "List this device's video tasks", operationId: "listVideoGenerations",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          responses: { "200": { description: "Up to 30 most recent device-owned tasks, without upstream polling", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "array", maxItems: 30, items: { $ref: "#/components/schemas/VideoTask" } } } } } } }, "401": { $ref: "#/components/responses/UnauthorizedError" } },
        },
      },
      "/v1/video/generations/{task_id}": {
        get: {
          summary: "Retrieve this device's video task", operationId: "retrieveVideoGeneration",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" }, description: "Opaque gateway task identifier, not an upstream identifier" }],
          responses: {
            "200": { description: "Current video task state", content: { "application/json": { schema: { $ref: "#/components/schemas/VideoTask" } } } },
            "404": { description: "Task not found or not owned by this device" },
            "401": { $ref: "#/components/responses/UnauthorizedError" },
          },
        },
      },
      "/v1/video/generations/{task_id}/content-ticket": {
        post: { summary: "Mint a five-minute private video content ticket", security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Owned succeeded task only. Returns {url,expires_at}; relative same-origin ticket URL, expiry in Unix milliseconds. Does not generate or charge for a video." }, "404": { description: "Task is unavailable or not owned" } } },
      },
      "/v1/video/generations/{task_id}/content": {
        get: { summary: "Stream private video without exposing the upstream URL", description: "Bearer/API key or short-lived task ticket required. Revocation checked on every request. No redirect or upstream error body is forwarded. MP4 only, max 256 MiB, bounded stream. A Range request returns 206 only when upstream returned a matching validated range; upstream ignoring Range returns 200.",
          parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }, { name: "ticket", in: "query", required: false, schema: { type: "string" } }, { name: "Range", in: "header", required: false, schema: { type: "string" } }],
          responses: { "200": { description: "Private no-store MP4 stream" }, "206": { description: "Validated byte range" }, "404": { description: "Unavailable or unauthorized" }, "429": { description: "Download quota or concurrency exceeded" }, "502": { description: "Upstream content unavailable; sanitized response" } } },
      },
      "/v1/video/reference-images": {
        post: { summary: "Upload a private video reference image", security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          description: "Optional VIDEO_REFERENCES private R2 binding required; absent binding fails closed. Raw JPEG/PNG/WebP binary, actual byte and header validation, max 5 MiB each; 100 MiB live bytes and 20 uploads/hour per owner, at most two concurrent uploads. Global CPG hard limits: 1,000,000,000 reserved bytes, 10,000 PUT attempts and 100,000 GET attempts per UTC month; operations reserve atomically in D1 and never refund failed attempts. Exhausted or unavailable operation budget returns 503 before R2 access. These limits do not account for other Cloudflare account usage. Unbound images expire after 24h; bound images at most seven days. No external URL fetch.",
          requestBody: { required: true, content: Object.fromEntries(["image/jpeg", "image/png", "image/webp"].map(type => [type, { schema: { type: "string", format: "binary" } }])) },
          responses: { "201": { description: "{id,content_type,size_bytes,expires_at}; immutable owner-scoped metadata, no R2 key or upstream URL" }, "503": { description: "Private storage unavailable" }, "413": { description: "Byte limit exceeded" }, "429": { description: "Storage/upload quota exceeded" } } },
      },
      "/v1/video/reference-images/{id}": {
        get: { summary: "Read owned private reference metadata", security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Same safe metadata shape as upload" }, "404": { description: "Unavailable or not owned" } } },
      },
      "/v1/video/reference-images/{id}/content": {
        get: { summary: "Stream a reference image using its restricted provider ticket", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "ticket", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Private no-store image; original image type, current account/token revocation enforced" }, "404": { description: "Invalid, expired, revoked or mismatched ticket" } } },
      },
      "/v1/images/generations": {
        post: {
          summary: "OpenAI-compatible Image Generation",
          description:
            "Generate pictures from a prompt. Billed once per request at the model's price_per_call, " +
            "plus search_calls x search_price_per_call if the caller declares a server-side search tool, " +
            "not per token and not per picture; only models whose billing unit is \"call\" answer here. " +
            "A failed answer (any 4xx or 5xx from the upstream) is not billed. Streaming is not " +
            "supported and responses are never served from the gateway cache.",
          operationId: "createImage",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["model", "prompt"],
                  properties: {
                    model: { type: "string", description: "Model name or alias configured on this gateway" },
                    prompt: { type: "string", description: "What to draw" },
                    n: {
                      type: "integer",
                      minimum: 1,
                      description: "How many pictures to generate; the gateway rejects more than its cap",
                    },
                    size: { type: "string", description: "Passed through to the upstream, e.g. 1024x1024" },
                    response_format: {
                      type: "string",
                      enum: ["url", "b64_json"],
                      description: "\"url\" is strongly preferred: a base64 answer costs the gateway far more CPU",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Generated pictures, either as urls or as base64 payloads",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
            "400": {
              description:
                "model_not_billed_per_call, model_billed_per_call, model_pricing_missing, " +
                "too_many_images, images_do_not_stream or a malformed request",
            },
            "401": {
              $ref: "#/components/responses/UnauthorizedError",
            },
            "429": {
              $ref: "#/components/responses/RateLimitError",
            },
            "500": {
              $ref: "#/components/responses/InternalServerError",
            },
          },
        },
      },
      "/v1/dashboard/billing/subscription": {
        get: {
          summary: "Get Billing Subscription (Balance)",
          description: "OpenAI-compatible balance probe. Reports the device wallet as hard/soft/system limits: hard and system limits are the wallet balance, the soft limit subtracts per-request holds. Rate limited to 3 requests per minute per device.",
          operationId: "billingSubscription",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Wallet balance in OpenAI billing_subscription form",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      object: { type: "string", example: "billing_subscription" },
                      has_payment_method: { type: "boolean" },
                      soft_limit_usd: { type: "number" },
                      hard_limit_usd: { type: "number" },
                      system_hard_limit_usd: { type: "number" },
                      access_until: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
            "401": {
              $ref: "#/components/responses/UnauthorizedError",
            },
            "429": {
              $ref: "#/components/responses/RateLimitError",
            },
          },
        },
      },
      "/v1/dashboard/billing/usage": {
        get: {
          summary: "Get Billing Usage (Spend)",
          description: "OpenAI-compatible spend report: SUM(cost_usd) over the window, in CENTS (the legacy API unit). Accepts start_date/end_date (YYYY-MM-DD); defaults to the current month. Rate limited to 3 requests per minute per device.",
          operationId: "billingUsage",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            {
              name: "start_date",
              in: "query",
              required: false,
              schema: { type: "string", example: "2026-10-01" },
              description: "Window start (inclusive, YYYY-MM-DD). Defaults to the month start.",
            },
            {
              name: "end_date",
              in: "query",
              required: false,
              schema: { type: "string", example: "2026-10-31" },
              description: "Window end (inclusive, YYYY-MM-DD). Defaults to now.",
            },
          ],
          responses: {
            "200": {
              description: "Spend in OpenAI billing usage form",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      object: { type: "string", example: "list" },
                      total_usage: { type: "number", description: "Spend in US cents" },
                    },
                  },
                },
              },
            },
            "401": {
              $ref: "#/components/responses/UnauthorizedError",
            },
            "429": {
              $ref: "#/components/responses/RateLimitError",
            },
          },
        },
      },
      "/v1/user/balance": {
        get: {
          summary: "Get User Balance (DeepSeek format)",
          description: "DeepSeek-compatible balance probe: the same wallet as the billing endpoints, in the GET /user/balance shape DeepSeek clients and balance widgets expect. total_balance is a two-decimal string; the wallet has no granted/topped-up split, so granted_balance is \"0.00\" and topped_up_balance carries the balance. Also reachable without the /v1 prefix at /user/balance. Rate limited to 3 requests per minute per device.",
          operationId: "billingUserBalance",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Wallet balance in DeepSeek user/balance form",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      is_available: { type: "boolean" },
                      balance_infos: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            currency: { type: "string", example: "CNY" },
                            total_balance: { type: "string", example: "12.50" },
                            granted_balance: { type: "string", example: "0.00" },
                            topped_up_balance: { type: "string", example: "12.50" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": {
              $ref: "#/components/responses/UnauthorizedError",
            },
            "429": {
              $ref: "#/components/responses/RateLimitError",
            },
          },
        },
      },
      "/v1/models": {
        get: {
          summary: "List Available Models",
          description: "List all currently configured and enabled AI models and aliases available through the gateway.",
          operationId: "listModels",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          responses: {
            "200": {
              description: "List of available models in OpenAI format",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ModelListResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/v1/models/{model_id}": {
        get: {
          summary: "Retrieve Model Details",
          description: "Get metadata, capability tags, and pricing for a specific model or alias.",
          operationId: "retrieveModel",
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            {
              name: "model_id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The model ID or alias",
            },
          ],
          responses: {
            "200": {
              description: "Model details",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ModelItem",
                  },
                },
              },
            },
            "404": {
              description: "Model not found",
            },
          },
        },
      },
      "/health": {
        get: {
          summary: "Gateway Health Check",
          description: "Unauthenticated health probe endpoint for uptime monitoring.",
          responses: {
            "200": {
              description: "Service is healthy and ready",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      service: { type: "string", example: "personal-ai-gateway" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Device Token passed in Authorization header: Bearer <token>",
        },
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Device Token passed in x-api-key header",
        },
      },
      schemas: {
        VideoGenerationRequest: {
          type: "object", additionalProperties: false, required: ["model", "prompt", "size", "seconds"],
          properties: {
            model: { type: "string", minLength: 1, maxLength: 256, ...(videoModelIds.length ? { enum: videoModelIds } : {}), description: "Explicit video model name or alias" },
            prompt: { type: "string", minLength: 1, maxLength: 8000 },
            reference_image_ids: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, description: "Ordered immutable private uploaded image IDs. No external URLs or binary data. Requires explicit model capability; max 5 MiB each, 15 MiB total. Omit for text-only generation." },
            size: { type: "string", pattern: "^[1-9][0-9]{0,3}x[1-9][0-9]{0,3}$", description: "Must be explicitly allowed by this model; each dimension is at most 4096" },
            seconds: { type: "integer", minimum: 3, maximum: 15, description: "Must be inside this model's configured duration range" },
          },
        },
        VideoTask: {
          type: "object", additionalProperties: false, required: ["id", "model", "status", "seconds", "size", "price_per_call", "cost_usd", "result_url", "error_code", "created_at", "updated_at"],
          description: "Public task metadata only. Private adapter configuration and upstream task identifiers are never returned. Timestamp values are Unix milliseconds. Unconfirmed submissions must not be resubmitted using a new idempotency key.",
          properties: {
            id: { type: "string" }, model: { type: "string" },
            status: { type: "string", enum: ["submitting", "submission_unknown", "pending", "succeeded", "failed"] },
            seconds: { type: "integer", minimum: 3, maximum: 15 }, size: { type: "string" },
            price_per_call: { type: "number", minimum: 0 }, cost_usd: { type: "number", minimum: 0 },
            result_url: { type: "string", nullable: true, description: "Same-origin relative /v1/video/generations/{id}/content path; never the upstream URL. Browser playback needs an explicitly minted short-lived content ticket." }, next_poll_at: { type: "integer", nullable: true }, requires_review: { type: "boolean" }, error_code: { type: "string", nullable: true },
            created_at: { type: "integer" }, updated_at: { type: "integer" },
          },
        },
        ChatCompletionRequest: {
          type: "object",
          required: ["model", "messages"],
          properties: {
            model: {
              type: "string",
              description: "ID of the model or alias to use",
              ...(modelIds.length ? { enum: modelIds, example: modelIds[0] } : serviceSelected ? {}
                : { enum: ["gpt-4o", "claude-3-5-sonnet", "deepseek-reasoner"], example: "gpt-4o" }),
            },
            messages: {
              type: "array",
              description: "A list of messages comprising the conversation so far.",
              items: {
                type: "object",
                required: ["role", "content"],
                properties: {
                  role: {
                    type: "string",
                    enum: ["system", "user", "assistant", "tool"],
                    example: "user",
                  },
                  content: {
                    oneOf: [
                      { type: "string", example: "Hello, what can you do?" },
                      { type: "array", items: { type: "object" } },
                    ],
                  },
                  name: { type: "string" },
                },
              },
            },
            temperature: {
              type: "number",
              minimum: 0,
              maximum: 2,
              default: 1,
              description: "Sampling temperature between 0 and 2.",
            },
            max_tokens: {
              type: "integer",
              minimum: 1,
              description: "The maximum number of tokens to generate in the chat completion.",
            },
            stream: {
              type: "boolean",
              default: false,
              description: "If set, partial message deltas will be sent as Server-Sent Events.",
            },
            tools: {
              type: "array",
              items: { type: "object" },
              description: "A list of tools the model may call.",
            },
          },
        },
        ChatCompletionResponse: {
          type: "object",
          properties: {
            id: { type: "string", example: "chatcmpl-12345" },
            object: { type: "string", example: "chat.completion" },
            created: { type: "integer", example: 1785542400 },
            model: { type: "string", example: "gpt-4o" },
            choices: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer", example: 0 },
                  message: {
                    type: "object",
                    properties: {
                      role: { type: "string", example: "assistant" },
                      content: { type: "string", example: "Hello! How can I assist you today?" },
                    },
                  },
                  finish_reason: { type: "string", example: "stop" },
                },
              },
            },
            usage: {
              type: "object",
              properties: {
                prompt_tokens: { type: "integer", example: 12 },
                completion_tokens: { type: "integer", example: 9 },
                total_tokens: { type: "integer", example: 21 },
              },
            },
          },
        },
        EmbeddingRequest: {
          type: "object",
          required: ["model", "input"],
          additionalProperties: false,
          properties: {
            model: { type: "string", description: "Embedding model name or alias configured on this gateway", ...(embeddingModelIds.length ? { enum: embeddingModelIds } : serviceSelected ? {} : { enum: ["text-embedding-3-small"] }) },
            input: {
              oneOf: [
                { type: "string", minLength: 1, description: "One non-empty text string" },
                { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 }, description: "One to 64 non-empty text strings" },
              ],
              description: "Text to embed; total JSON request body must be no larger than 256 KiB",
            },
            dimensions: { type: "integer", minimum: 1, maximum: 4096, description: "Optional output dimensions" },
            encoding_format: { type: "string", enum: ["float", "base64"], default: "float" },
            user: { type: "string", description: "Optional end-user identifier" },
          },
        },
        EmbeddingResponse: {
          type: "object",
          properties: {
            object: { type: "string", example: "list" },
            data: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, object: { type: "string", example: "embedding" }, embedding: { oneOf: [{ type: "array", items: { type: "number" } }, { type: "string", format: "byte" }] } } } },
            model: { type: "string" },
            usage: { type: "object", properties: { prompt_tokens: { type: "integer" }, total_tokens: { type: "integer" } }, description: "Input-token usage only" },
          },
        },
        AnthropicMessageRequest: {
          type: "object",
          required: ["model", "messages", "max_tokens"],
          properties: {
            model: {
              type: "string",
              example: "claude-3-5-sonnet",
            },
            messages: {
              type: "array",
              items: {
                type: "object",
                required: ["role", "content"],
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
              },
            },
            max_tokens: { type: "integer", example: 4096 },
            system: { type: "string" },
            temperature: { type: "number", example: 1 },
            stream: { type: "boolean", default: false },
          },
        },
        ModelItem: {
          type: "object",
          properties: {
            id: { type: "string", example: "gpt-4o" },
            object: { type: "string", example: "model" },
            created: { type: "integer", example: 1785542400 },
            owned_by: { type: "string", example: "openai" },
            capabilities: {
              type: "array",
              items: { type: "string" },
              example: ["vision", "tool_call", "long_context"],
            },
            supports_reasoning: {
              type: "boolean",
              description:
                "Whether the proxy will honour a reasoning effort on this model. A group always answers true unless its config sets supports_reasoning to false.",
              example: true,
            },
            supported_reasoning_levels: {
              type: "array",
              description: "The ladder a caller may pick from; empty when supports_reasoning is false.",
              items: {
                type: "object",
                properties: {
                  effort: { type: "string", example: "high" },
                  description: { type: "string" },
                },
              },
            },
            default_reasoning_level: {
              type: "string",
              nullable: true,
              description: "The level used when the caller names none; null when supports_reasoning is false.",
              example: "medium",
            },
          },
        },
        ModelListResponse: {
          type: "object",
          properties: {
            object: { type: "string", example: "list" },
            data: {
              type: "array",
              items: { $ref: "#/components/schemas/ModelItem" },
            },
          },
        },
      },
      responses: {
        UnauthorizedError: {
          description: "Authentication failed. Missing or invalid Bearer Token.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string", example: "unauthorized" },
                },
              },
            },
          },
        },
        RateLimitError: {
          description: "Rate limit exceeded or budget quota reached.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string", example: "rate_limit_exceeded" },
                  message: { type: "string", example: "Device monthly spending limit exceeded" },
                },
              },
            },
          },
        },
        InternalServerError: {
          description: "Internal gateway or upstream error.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string", example: "upstream_error" },
                },
              },
            },
          },
        },
      },
    },
  };
}
