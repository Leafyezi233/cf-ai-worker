import { useMemo, useState } from "react";
import { buildDshProfile, DSH_PROFILE_HELP } from "../utils/modelConfigExport";
import { isEmbeddingModel, isTextModel, isVideoModel } from "../utils/modelType";
import type { ConsoleModels } from "../api/consoleClient";
import { Card, CopyButton } from "./ui";


type ModelItem = ConsoleModels["items"][number];

const BASE = "http://127.0.0.1:8787";

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800/80">
        <span className="text-[11px] font-medium text-slate-400">{lang}</span>
        <CopyButton
          text={code}
          className="text-slate-400 hover:text-slate-100 hover:bg-slate-800 p-1 rounded"
        />
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed text-slate-200 font-mono whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card title={title} action={action}>
      <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">{children}</div>
    </Card>
  );
}

const ENDPOINTS: { method: string; path: string; desc: string }[] = [
  { method: "POST", path: "/v1/chat/completions", desc: "对话（OpenAI 形态，支持图片输入做图生图）" },
  { method: "POST", path: "/v1/messages", desc: "对话（Anthropic 形态，max_tokens 必带）" },
  { method: "POST", path: "/v1/responses", desc: "对话（OpenAI Responses 形态）" },
  { method: "POST", path: "/v1/images/generations", desc: "文生图（仅图片模型）" },
  { method: "POST", path: "/v1/videos", desc: "创建标准视频任务（按模型分辨率 / 参考视频报价表计费）" },
  { method: "GET", path: "/v1/videos/:id", desc: "查询标准视频任务" },
  { method: "POST", path: "/v1/videos/reference-images", desc: "上传标准视频私有参考图，单张最多 5 MiB" },
  { method: "GET", path: "/v1/videos/reference-videos/limits", desc: "读取当前参考视频上传限制" },
  { method: "POST", path: "/v1/videos/reference-videos", desc: "上传私有参考视频，先查询上传限制" },
  { method: "POST", path: "/v1/video/reference-images", desc: "上传参考图（二进制 JPEG/PNG/WebP；不会自动创建任务）" },
  { method: "POST", path: "/v1/video/generations/:id/content-ticket", desc: "显式播放/下载时获取短时内容票据，不重新生成" },
  { method: "POST", path: "/v1/video/generations", desc: "创建视频任务（Idempotency-Key 必填；按成功任务次数计费）" },
  { method: "GET", path: "/v1/video/generations", desc: "列出当前 Token 的视频任务" },
  { method: "GET", path: "/v1/video/generations/:id", desc: "查询当前 Token 的单个视频任务" },
  { method: "POST", path: "/v1/embeddings", desc: "文本向量（仅 Embedding 模型；只收输入 Token）" },
  { method: "GET", path: "/v1/models", desc: "列出当前设备可用的模型" },
  { method: "GET", path: "/v1/dashboard/billing/subscription", desc: "OpenAI 兼容余额查询（3 RPM）" },
  { method: "GET", path: "/v1/dashboard/billing/usage", desc: "OpenAI 兼容用量查询（3 RPM）" },
];

const ERRORS: { code: string; meaning: string; fix: string }[] = [
  { code: "401", meaning: "API key 无效或未携带", fix: "确认 Authorization: Bearer 头，Token 在设备控制台创建" },
  { code: "400 per_call_text_only", meaning: "按次计费模型收到纯文本请求", fix: "按次模型必须带图片输入（成本保护：纯文本会白烧一次上游全价）" },
  { code: "413", meaning: "请求体超过网关上限（10MB）", fix: "压缩或减少图片；若 1MB 就报 413，是你自己链路的反代限制" },
  { code: "429", meaning: "触发限流", fix: "网关/console/billing 各有独立限流桶，稍后重试" },
];

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[12px] text-slate-700 dark:text-slate-200">{children}</code>;
}

export function ConsoleGuide({
  models,
  onOpenModels,
}: {
  models: ConsoleModels | null | undefined;
  onOpenModels?: () => void;
}) {
  const items: ModelItem[] = models?.items ?? [];
  const demoModel = items.find(isTextModel)?.model_name || "your-chat-model";
  const embeddingModel = items.find(isEmbeddingModel)?.model_name;
  const embeddingBody = useMemo(() => embeddingModel
    ? JSON.stringify({ model: embeddingModel, input: ["你好", "语义搜索"], encoding_format: "float", user: "example-user" }, null, 2)
    : '{\n  "model": "your-embedding-model",\n  "input": ["你好", "语义搜索"],\n  "encoding_format": "float",\n  "user": "example-user"\n}', [embeddingModel]);
  const embeddingCode = [
    "curl " + BASE + "/v1/embeddings \\",
    '  -H "Authorization: Bearer $CPG_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '" + embeddingBody + "'",
  ].join("\n");
  const perCall = items.find((m) => !isEmbeddingModel(m) && !isVideoModel(m) && (m.model_type === "image" || (m.model_type !== "text" && m.billing_unit === "call")));
  const videoModel = items.find(isVideoModel);
  const videoBody = videoModel
    ? JSON.stringify({ model: videoModel.model_name, prompt: "一只猫在花园里散步", seconds: 3, size: "YOUR_SUPPORTED_SIZE" }, null, 2)
    : '{"model":"your-video-model","prompt":"一只猫在花园里散步","seconds":3,"size":"YOUR_SUPPORTED_SIZE"}';
  const videoCode = [
    "curl " + BASE + "/v1/video/generations " + String.fromCharCode(92),
    '  -H "Authorization: Bearer $CPG_API_KEY" ' + String.fromCharCode(92),
    '  -H "Content-Type: application/json" ' + String.fromCharCode(92),
    '  -H "Idempotency-Key: example-video-job-001" ' + String.fromCharCode(92),
    "  -d '" + videoBody + "'",
    "",
    "curl " + BASE + "/v1/video/generations -H \"Authorization: Bearer $CPG_API_KEY\"",
    "curl " + BASE + "/v1/video/generations/YOUR_TASK_ID -H \"Authorization: Bearer $CPG_API_KEY\"",
  ].join("\n");
  const [showDsh, setShowDsh] = useState(false);
  const dshExport = useMemo(() => showDsh && models
    ? buildDshProfile(models.items, BASE + "/v1") : null, [showDsh, models]);
  const dshJson = useMemo(() => dshExport ? JSON.stringify(dshExport.config, null, 2) : "", [dshExport]);

  const chatCode = [
    "curl " + BASE + "/v1/chat/completions \\",
    '  -H "Authorization: Bearer $CPG_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '{",
    '    "model": "' + demoModel + '",',
    '    "messages": [{"role": "user", "content": "你好"}],',
    '    "stream": false',
    "  }'",
  ].join("\n");

  const pythonCode = [
    "from openai import OpenAI",
    "",
    "client = OpenAI(",
    '    base_url="' + BASE + '/v1",',
    '    api_key="$CPG_API_KEY",  # 设备控制台创建的 Token',
    ")",
    "",
    "resp = client.chat.completions.create(",
    '    model="' + demoModel + '",',
    '    messages=[{"role": "user", "content": "你好"}],',
    ")",
    "print(resp.choices[0].message.content)",
  ].join("\n");

  const tsCode = [
    'import OpenAI from "openai";',
    "",
    "const client = new OpenAI({",
    '  baseURL: "' + BASE + '/v1",',
    "  apiKey: process.env.CPG_API_KEY, // 设备控制台创建的 Token",
    "});",
    "",
    "const resp = await client.chat.completions.create({",
    '  model: "' + demoModel + '",',
    '  messages: [{ role: "user", content: "你好" }],',
    "});",
    "console.log(resp.choices[0].message.content);",
  ].join("\n");

  const imageCode = perCall
    ? [
        "curl " + BASE + "/v1/chat/completions \\",
        '  -H "Authorization: Bearer $CPG_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        "  -d '{",
        '    "model": "' + perCall.model_name + '",',
        '    "messages": [{',
        '      "role": "user",',
        '      "content": [',
        '        {"type": "text", "text": "把这只猫改成宇航员"},',
        '        {"type": "image_url", "image_url": {"url": "data:image/png;base64,<BASE64>"}}',
        "      ]",
        "    }]",
        "  }'",
      ].join("\n")
    : "";

  return (
    <div className="space-y-4">
      <SectionCard title="接入信息">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Base URL</div>
            <div className="font-mono text-[12px] break-all text-slate-700 dark:text-slate-200">{BASE}</div>
          </div>
          <CopyButton text={BASE} label="复制" />
        </div>
        <p>
          鉴权：所有 <Mono>/v1</Mono> 请求携带 <Mono>Authorization: Bearer $CPG_API_KEY</Mono>
          。API Key 即设备控制台的 Token，只在创建时完整显示一次，请妥善保存；子 Token
          权限受限（不能登录控制台），适合分发给第三方。
        </p>
        <p>
          余额查询：<Mono>/v1/dashboard/billing/subscription</Mono> 与 <Mono>/usage</Mono>
          ，OpenAI 历史兼容格式，限流 3 RPM。
        </p>
      </SectionCard>

      <SectionCard title="DSH profile（0.2.0-rc.2）">
        <p>仅导出当前 Token / 当前路由权限下的模型（含可用分组），不是模型广场所有报价；不会切换服务分组、创建 Token 或写入真实密钥。</p>
        <button type="button" onClick={() => setShowDsh((value) => !value)} className="text-blue-600 hover:underline">{showDsh ? "收起 DSH 配置" : "生成 DSH 配置 JSON"}</button>
        {showDsh && !models && <p role="alert">当前权限模型列表未加载或加载失败，无法导出；请重试模型列表。不会改用模型广场数据。</p>}
        {dshExport && <>
          {(dshExport.warnings.length > 0 || dshExport.skipped.length > 0) && <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {dshExport.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
            {dshExport.skipped.map(({ id, reason }) => <p key={id}>已跳过 {id}：{reason}</p>)}
          </div>}
          <CodeBlock code={dshJson} lang="DSH profile JSON · 复制配置" />
        </>}
        <p>{DSH_PROFILE_HELP}</p>
      </SectionCard>

      <SectionCard title="快速开始">
        <p>三种语言任选，把示例中的模型名换成「模型广场」里你可用的模型即可直接运行：</p>
        <CodeBlock code={chatCode} lang="curl" />
        <CodeBlock code={pythonCode} lang="Python · openai" />
        <CodeBlock code={tsCode} lang="TypeScript · openai" />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          流式输出：请求体加 <Mono>"stream": true</Mono>，响应为 SSE 增量帧。
        </p>
      </SectionCard>

      <SectionCard title="Embeddings · 文本向量">
        <p>向量模型使用 <Mono>/v1/embeddings</Mono>，不要发送到对话接口。首版 <Mono>input</Mono> 接受一个字符串或字符串数组（不支持 token ID 数组）；<Mono>encoding_format</Mono> 为 <Mono>float</Mono> 或 <Mono>base64</Mono>。可选 <Mono>dimensions</Mono> 必须为上游支持的正整数，<Mono>user</Mono> 为字符串。</p>
        <CodeBlock code={embeddingCode} lang="curl · Embeddings" />
        <p>仅按输入 Token 计费，不收输出费用，不使用响应缓存，也不进入在线对话。示例未指定 dimensions 以沿用模型默认维数；需要时在 JSON 中加上上游支持的 dimensions。</p>
        <p>向量维数和兼容性以模型声明为准；如需固定向量空间，请联系管理员确认，避免混用不兼容的向量结果。</p>
      </SectionCard>

      <SectionCard title="标准视频 · 按报价表计费">
        <p>标准视频使用 <Mono>POST /v1/videos</Mono> 创建、<Mono>GET /v1/videos</Mono> 列表、<Mono>GET /v1/videos/:id</Mono> 查询。报价按分辨率及是否包含参考视频区分：按秒报价乘以生成时长，按次报价按一次成功任务计算；仅成功任务结算，未定价不代表免费。最终费用以提交时冻结的报价为准，不使用旧版的每次调用价格。</p>
        <p>私有参考图上传使用 <Mono>POST /v1/videos/reference-images</Mono>，以实际 JPEG / PNG / WebP Content-Type 发送二进制，单张最多 5 MiB。参考视频先查询 <Mono>GET /v1/videos/reference-videos/limits</Mono>，再以 <Mono>video/mp4</Mono> 向 <Mono>POST /v1/videos/reference-videos</Mono> 发送二进制；格式、大小和时长以上传限制接口实时返回值为准，未配置则禁用。上传与删除均需 Bearer 鉴权，上传本身不创建生成任务。</p>
        <p>创建时使用当前模型公开声明的参数和返回的素材 ID；图片及视频数量、组合方式仍受模型配置限制。提交必须携带 <Mono>Idempotency-Key</Mono>，未知结果沿用原 key 与请求参数，不自动重发付费任务。仅在返回可用的本网关内容接口时允许播放/下载，不暴露上游地址。</p>
      </SectionCard>

      <SectionCard title="secure_skill 与 Doubao · 独立能力规则">
        <p>secure_skill 标准视频保留协议规则：尾帧必须有首帧，首尾帧不能混用参考图、视频或音频；按秒报价。不要套用 Doubao 的素材上限或组合规则。</p>
        <p>Doubao 模型由公开 video.request_format=doubao_content 标识。创建可使用 model、prompt、duration、ratio、resolution 和 reference_image_ids / reference_video_ids、first_frame_id / last_frame_id、image_urls / video_urls / audio_urls 简写，或官方 content 数组；不要混用 content 与简写。默认时长与比例取模型公开 default_duration / default_ratio，所有规格、素材数量及 max_total_refs 均以所选分组声明为准，不能按模型名称猜测。</p>
        <p>Doubao 在分组允许首尾帧时可仅传尾帧、可帧+音频；不能把帧与普通参考图或视频混用。私有上传服务仍独立限制最多 9 张图 / 3 个视频，不代表外部 URL 或模型能力上限。音频单独参考需分组显式开启。</p>
        <p>Doubao 报价逐项区分 ¥/次和 ¥/秒；首版默认未配置安全下载。任务 completed 且 content_available=false 或结果 URL 为空时，显示“生成完成，下载未配置，请联系管理员获取帮助”，不能当失败重新提交或重复付费，不展示播放按钮或上游链接。</p>
      </SectionCard>

      <SectionCard title="旧版视频 · 按成功任务次数计费">
        <p>视频使用 <Mono>POST /v1/video/generations</Mono> 提交，<Mono>GET /v1/video/generations</Mono> 列表，<Mono>GET /v1/video/generations/:id</Mono> 查询。仅 <Mono>succeeded</Mono> 任务收一次 <Mono>price_per_call</Mono>，不是按秒计费；失败不扣费，无 Token、缓存或搜索附加费。未定价不代表免费。</p>
        <p>必填 <Mono>model、prompt、seconds、size</Mono>。示例的 <Mono>YOUR_SUPPORTED_SIZE</Mono> 必须替换为管理员显式支持的尺寸，<Mono>seconds</Mono> 应在模型声明范围内（全局 3–15 秒），不能猜测尺寸。提交必须携带 <Mono>Idempotency-Key</Mono>；同一个逻辑任务的重试必须沿用相同 key 与完全相同请求体。</p>
        <CodeBlock code={videoCode} lang="curl · Video" />
        <p>参考图仅在目录显式声明 <Mono>video.reference_images.max_images</Mono> 时可用，缺省禁用。先携带 Bearer 和实际图片 Content-Type，将二进制图片上传到 <Mono>POST /v1/video/reference-images</Mono>，再将响应中的 ID 按选定顺序作为 <Mono>reference_image_ids</Mono> 提交；最多 3 张，每张 5 MiB、合计 15 MiB，仅 JPEG / PNG / WebP。上传不会自动提交视频；未配置 R2 返回 503，请联系管理员。参考图过期/缺失时不要替换已锁定任务参数或为未知提交换 key。</p>
        <p><Mono>submitting / submission_unknown / pending</Mono> 均不是失败，不应换 key 重新提交。提交结果未知时仅查询或联系管理员；同 key 重试只用于恢复同一任务，不会创建第二个付费任务。只在 <Mono>succeeded</Mono> 且返回当前任务的同源相对 <Mono>/v1/video/generations/:id/content</Mono> 结果端点后，点击播放/下载获取短时票据。原生播放器只使用短时票据，不传主 Token URL，不回退上游 URL；票据过期时请手动重新获取。重复播放不创建视频、不重复收取创建费。</p>
      </SectionCard>

      <SectionCard title="端点清单">
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                <th className="py-1.5 pr-3 font-medium">方法</th>
                <th className="py-1.5 pr-3 font-medium">路径</th>
                <th className="py-1.5 pr-3 font-medium">说明</th>
                <th className="py-1.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={e.method + e.path} className="border-t border-slate-100 dark:border-slate-800/80">
                  <td className="py-2 pr-3 font-mono text-[11px] text-blue-600 dark:text-blue-400">{e.method}</td>
                  <td className="py-2 pr-3 font-mono text-[12px] text-slate-700 dark:text-slate-200">{e.path}</td>
                  <td className="py-2 pr-3">{e.desc}</td>
                  <td className="py-2">
                    <CopyButton text={e.path} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {perCall ? (
        <SectionCard title="图生图（按次计费模型）">
          <p>
            按次计费模型（如 <Mono>{perCall.model_name}</Mono>）走 <Mono>chat/completions</Mono>
            ，content 用数组并附 <Mono>image_url</Mono>（base64 data URL
            同样支持）；一次请求计一次 <Mono>price_per_call</Mono>
            。纯文本请求会被 400 <Mono>per_call_text_only</Mono> 拒绝。
          </p>
          <CodeBlock code={imageCode} lang="curl · 图生图" />
        </SectionCard>
      ) : null}

      <SectionCard
        title="计费规则"
        action={
          onOpenModels ? (
            <button
              type="button"
              onClick={onOpenModels}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            >
              查看具体价格 →
            </button>
          ) : undefined
        }
      >
        <ul className="list-disc pl-5 space-y-1.5">
          <li>文本 Token 计费模型：按输入 / 输出 token 单价（每百万）计费，另有缓存读 / 写价。</li>
          <li>Embedding 模型：仅按输入 token 单价（每百万）计费，不收输出费，不使用响应缓存。</li>
          <li>
            按次计费模型：一次请求一次 <Mono>price_per_call</Mono>，与图片大小无关。
          </li>
          <li>峰谷定价：模型广场里显示当前倍率与时段，处于峰时按倍率上浮计价。</li>
          <li>预占机制：请求开始先冻结预估费用，响应结束后按实际用量结算、多余返还。</li>
        </ul>
      </SectionCard>

      <SectionCard title="限制与常见错误">
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                <th className="py-1.5 pr-3 font-medium">状态码</th>
                <th className="py-1.5 pr-3 font-medium">含义</th>
                <th className="py-1.5 font-medium">处理</th>
              </tr>
            </thead>
            <tbody>
              {ERRORS.map((e) => (
                <tr key={e.code} className="border-t border-slate-100 dark:border-slate-800/80 align-top">
                  <td className="py-2 pr-3 font-mono text-[12px] text-slate-700 dark:text-slate-200 whitespace-nowrap">
                    {e.code}
                  </td>
                  <td className="py-2 pr-3">{e.meaning}</td>
                  <td className="py-2">{e.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          其他限制：请求体上限 10MB；错误响应统一为 OpenAI 形态
          <Mono>{'{"error": {"message": ..., "type": ..., "code": ...}}'}</Mono>
          。
        </p>
      </SectionCard>
    </div>
  );
}