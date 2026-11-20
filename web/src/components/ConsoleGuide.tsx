import { useMemo, useState, type ReactNode } from "react";
import { buildDshProfile, DSH_PROFILE_HELP, type ModelConfigMetadata } from "../utils/modelConfigExport";
import { isEmbeddingModel, isTextModel, isVideoModel } from "../utils/modelType";
import type { ConsoleModels } from "../api/consoleClient";
import { Card, CopyButton } from "./ui";
import { GATEWAY_ERROR_HELP } from "../utils/gatewayErrors";

type ModelItem = ConsoleModels["items"][number];

const FALLBACK_BASE = "http://127.0.0.1:8787";

/**
 * The console is served by the same Worker as the /v1 gateway, so in a browser the page origin is
 * the gateway address users must configure. Outside a browser (SSR, tests) the local default is used.
 */
export function gatewayBase(): string {
  try {
    const origin = typeof window !== "undefined" ? window.location?.origin : undefined;
    if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  } catch {
    // fall through to the local default
  }
  return FALLBACK_BASE;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800/80 px-3 py-1.5">
        <span className="text-[11px] font-medium text-slate-400">{lang}</span>
        <CopyButton text={code} label="复制" className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100" />
      </div>
      <pre className="overflow-x-auto whitespace-pre p-3 font-mono text-[12px] leading-relaxed text-slate-200">
        {code}
      </pre>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{children}</code>;
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</div>
        <div className="break-all font-mono text-[13px] text-slate-800 dark:text-slate-100">{value}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{hint}</div> : null}
      </div>
      <CopyButton text={value} label="复制" />
    </div>
  );
}

/** Collapsible reference topic; content stays in the DOM so it is searchable with the browser's find. */
function RefSection({ id, title, summary, children }: { id: string; title: string; summary?: string; children: ReactNode }) {
  return (
    <details id={id} className="group border-t border-slate-100 first:border-t-0 dark:border-slate-800">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 sm:px-5 dark:hover:bg-slate-800/40 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">{title}</span>
          {summary ? <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{summary}</span> : null}
        </span>
        <span aria-hidden="true" className="shrink-0 text-slate-400 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="space-y-3 px-4 pb-5 text-sm leading-6 text-slate-600 sm:px-5 dark:text-slate-300">{children}</div>
    </details>
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


export type ConnectionClient = "openai" | "anthropic" | "dsh";
export type ConnectionProtocol = "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
type ConnectionModel = ModelConfigMetadata & Pick<Partial<ModelItem>, "protocol_capabilities">;

export function connectionProtocol(client: ConnectionClient, protocol: ConnectionProtocol): ConnectionProtocol {
  if (client === "anthropic") return "/v1/messages";
  if (client === "dsh") return "/v1/chat/completions";
  return protocol === "/v1/responses" ? protocol : "/v1/chat/completions";
}

export function connectionModels(items: readonly ConnectionModel[], client: ConnectionClient, protocol: ConnectionProtocol) {
  const endpoint = connectionProtocol(client, protocol);
  const byId = new Map<string, { id: string; label: string }>();
  const blocked = new Set<string>();
  const dshIds = client === "dsh"
    ? new Set(buildDshProfile(items, gatewayBase() + "/v1").config.providers["cpg-gateway"]?.models.map((model) => model.id) ?? [])
    : null;
  for (const item of items) {
    const id = item.alias || item.model_name || "";
    if (!id.trim()) continue;
    const endpoints = item.protocol_capabilities?.supported_endpoints ?? [item.chat_endpoint || "/v1/chat/completions"];
    if (!isTextModel(item) || (item.input_modalities && !item.input_modalities.includes("text")) || !endpoints.includes(endpoint) || (dshIds && !dshIds.has(id))) {
      blocked.add(id);
      byId.delete(id);
      continue;
    }
    if (!blocked.has(id)) byId.set(id, { id, label: item.display_name || id });
  }
  return [...byId.values()];
}

export function connectionConfig(items: readonly ConnectionModel[], client: ConnectionClient, protocol: ConnectionProtocol, selected: string) {
  const options = connectionModels(items, client, protocol);
  const model = options.find((option) => option.id === selected) ?? options[0];
  if (!model) return null;
  const endpoint = connectionProtocol(client, protocol);
  const base = gatewayBase();
  return { baseURL: endpoint === "/v1/messages" ? base : base + "/v1", endpoint: base + endpoint, apiKey: "$CPG_API_KEY", model: model.id };
}

type ConnectionConfig = NonNullable<ReturnType<typeof connectionConfig>>;
type SnippetKind = "env" | "curl" | "python" | "node";

/** Ready-to-run examples for the exact client, protocol and model chosen in the wizard. Keys are read from CPG_API_KEY. */
export function connectionSnippets(config: ConnectionConfig, protocol: ConnectionProtocol): Record<SnippetKind, string> {
  const q = JSON.stringify(config.model);
  const base = config.baseURL;
  const anthropic = protocol === "/v1/messages";
  const env = [
    "# macOS / Linux（写入 ~/.zshrc 或 ~/.bashrc 可长期生效）",
    'export CPG_API_KEY="粘贴你的子 Token"',
    ...(anthropic
      ? ['export ANTHROPIC_BASE_URL="' + base + '"', 'export ANTHROPIC_API_KEY="$CPG_API_KEY"']
      : ['export OPENAI_BASE_URL="' + base + '"', 'export OPENAI_API_KEY="$CPG_API_KEY"']),
    "",
    "# Windows PowerShell",
    '$env:CPG_API_KEY = "粘贴你的子 Token"',
    ...(anthropic
      ? ['$env:ANTHROPIC_BASE_URL = "' + base + '"', "$env:ANTHROPIC_API_KEY = $env:CPG_API_KEY"]
      : ['$env:OPENAI_BASE_URL = "' + base + '"', "$env:OPENAI_API_KEY = $env:CPG_API_KEY"]),
  ].join("\n");
  const body = protocol === "/v1/responses"
    ? '{"model": ' + q + ', "input": "你好"}'
    : anthropic
    ? '{"model": ' + q + ', "max_tokens": 1024, "messages": [{"role": "user", "content": "你好"}]}'
    : '{"model": ' + q + ', "messages": [{"role": "user", "content": "你好"}]}';
  const curl = [
    "curl " + config.endpoint + " \\",
    '  -H "Authorization: Bearer $CPG_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '" + body + "'",
  ].join("\n");
  const python = anthropic ? [
    "# pip install anthropic",
    "import os",
    "from anthropic import Anthropic",
    "",
    'client = Anthropic(base_url="' + base + '", api_key=os.environ["CPG_API_KEY"])',
    "msg = client.messages.create(",
    "    model=" + q + ",",
    "    max_tokens=1024,",
    '    messages=[{"role": "user", "content": "你好"}],',
    ")",
    "print(msg.content[0].text)",
  ].join("\n") : [
    "# pip install openai",
    "import os",
    "from openai import OpenAI",
    "",
    'client = OpenAI(base_url="' + base + '", api_key=os.environ["CPG_API_KEY"])',
    ...(protocol === "/v1/responses" ? [
      'resp = client.responses.create(model=' + q + ', input="你好")',
      "print(resp.output_text)",
    ] : [
      "resp = client.chat.completions.create(",
      "    model=" + q + ",",
      '    messages=[{"role": "user", "content": "你好"}],',
      ")",
      "print(resp.choices[0].message.content)",
    ]),
  ].join("\n");
  const node = anthropic ? [
    "// npm install @anthropic-ai/sdk",
    'import Anthropic from "@anthropic-ai/sdk";',
    "",
    'const client = new Anthropic({ baseURL: "' + base + '", apiKey: process.env.CPG_API_KEY });',
    "const msg = await client.messages.create({",
    "  model: " + q + ",",
    "  max_tokens: 1024,",
    '  messages: [{ role: "user", content: "你好" }],',
    "});",
    "console.log(msg.content[0].text);",
  ].join("\n") : [
    "// npm install openai",
    'import OpenAI from "openai";',
    "",
    'const client = new OpenAI({ baseURL: "' + base + '", apiKey: process.env.CPG_API_KEY });',
    ...(protocol === "/v1/responses" ? [
      'const resp = await client.responses.create({ model: ' + q + ', input: "你好" });',
      "console.log(resp.output_text);",
    ] : [
      "const resp = await client.chat.completions.create({",
      "  model: " + q + ",",
      '  messages: [{ role: "user", content: "你好" }],',
      "});",
      "console.log(resp.choices[0].message.content);",
    ]),
  ].join("\n");
  return { env, curl, python, node };
}

const SNIPPET_TABS: { key: SnippetKind; label: string }[] = [
  { key: "env", label: "环境变量" },
  { key: "curl", label: "curl" },
  { key: "python", label: "Python" },
  { key: "node", label: "Node.js" },
];

function SnippetTabs({ config, protocol }: { config: ConnectionConfig; protocol: ConnectionProtocol }) {
  const [kind, setKind] = useState<SnippetKind>("curl");
  const snippets = connectionSnippets(config, protocol);
  return <div className="space-y-2">
    <div role="tablist" aria-label="示例代码" className="flex flex-wrap gap-1">
      {SNIPPET_TABS.map(tab => <button key={tab.key} type="button" role="tab" aria-selected={kind === tab.key} onClick={() => setKind(tab.key)}
        className={"rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + (kind === tab.key
          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>{tab.label}</button>)}
    </div>
    <CodeBlock code={snippets[kind]} lang={kind === "env" ? "终端 · 设置环境变量" : SNIPPET_TABS.find(t => t.key === kind)!.label + " · " + protocol} />
  </div>;
}

export function ConsoleDshExport({ models }: { models: ConsoleModels | null | undefined }) {
  const [show, setShow] = useState(false);
  const dshExport = useMemo(() => show && models ? buildDshProfile(models.items, gatewayBase() + "/v1") : null, [show, models]);
  return <div className="space-y-3">
    <p>DSH 使用 profile JSON 配置，包含你可用的模型；密钥从环境变量 <Mono>CPG_API_KEY</Mono> 读取。</p>
    <button type="button" onClick={() => setShow((value) => !value)} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">{show ? "收起 DSH 配置" : "生成 DSH 配置 JSON"}</button>
    {show && !models && <p role="alert">模型列表加载失败，无法生成。</p>}
    {dshExport && <>
      {(dshExport.warnings.length > 0 || dshExport.skipped.length > 0) && <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {dshExport.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
        {dshExport.skipped.map(({ id, reason }) => <p key={id}>已跳过 {id}：{reason}</p>)}
      </div>}
      <CodeBlock code={JSON.stringify(dshExport.config, null, 2)} lang="DSH profile JSON · 复制配置" />
    </>}
    <p className="text-xs text-slate-500 dark:text-slate-400">{DSH_PROFILE_HELP}</p>
  </div>;
}

function Step({ n, title, children, last = false }: { n: number; title: string; children: ReactNode; last?: boolean }) {
  return <li className="relative flex gap-4">
    {!last ? <span aria-hidden="true" className="absolute left-[13px] top-8 bottom-0 w-px bg-slate-200 dark:bg-slate-700" /> : null}
    <span aria-hidden="true" className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{n}</span>
    <div className={"min-w-0 flex-1 space-y-3 " + (last ? "" : "pb-7")}>
      <h3 className="pt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {children}
    </div>
  </li>;
}

function Choice({ checked, title, text, onSelect }: { checked: boolean; title: string; text: string; onSelect: () => void }) {
  return <button type="button" role="radio" aria-checked={checked} onClick={onSelect}
    className={"min-w-0 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + (checked
      ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:border-brand-500 dark:bg-brand-950/40"
      : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")}>
    <span className={"block text-sm font-medium " + (checked ? "text-brand-700 dark:text-brand-300" : "text-slate-800 dark:text-slate-100")}>{title}</span>
    <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{text}</span>
  </button>;
}

const CLIENTS: { key: ConnectionClient; title: string; text: string }[] = [
  { key: "openai", title: "OpenAI 兼容", text: "OpenAI SDK 及大多数兼容 OpenAI 接口的客户端" },
  { key: "anthropic", title: "Anthropic", text: "Anthropic SDK 及使用 Messages 接口的客户端" },
  { key: "dsh", title: "DeepSeek Harness", text: "生成 DSH profile 配置文件" },
];

export function ConsoleConnectionWizard({ models, onOpenKeys, onOpenModels }: {
  models: ConsoleModels | null | undefined;
  onOpenKeys?: () => void;
  onOpenModels?: () => void;
}) {
  // Keep exactly these three pieces of state, in this order (tests seed them positionally).
  const [client, setClient] = useState<ConnectionClient>("openai");
  const [protocol, setProtocol] = useState<ConnectionProtocol>("/v1/chat/completions");
  const [selected, setSelected] = useState("");
  const endpoint = connectionProtocol(client, protocol);
  const options = connectionModels(models?.items ?? [], client, endpoint);
  const config = connectionConfig(models?.items ?? [], client, endpoint, selected);
  return <Card title="快速接入 · 4 步完成">
    <ol className="text-sm leading-6 text-slate-600 dark:text-slate-300">
      <Step n={1} title="准备 API 密钥">
        <p>API 密钥就是<strong className="font-medium text-slate-800 dark:text-slate-100">子 Token</strong>：每个应用单独创建一个，明文只在创建时显示一次。登录用的主 Token 不要填进第三方应用，也不要放进公开链接。</p>
        {onOpenKeys
          ? <button type="button" onClick={onOpenKeys} className="inline-flex items-center rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 dark:bg-brand-950/50 dark:text-brand-300 dark:hover:bg-brand-900/50">创建子 Token →</button>
          : <p>前往账户中的 Token 管理创建子 Token，再返回继续配置。</p>}
      </Step>

      <Step n={2} title="选择你的客户端">
        <div role="radiogroup" aria-label="接入客户端" className="grid gap-2 sm:grid-cols-3">
          {CLIENTS.map(item => <Choice key={item.key} checked={client === item.key} title={item.title} text={item.text}
            onSelect={() => { setClient(item.key); setSelected(""); }} />)}
        </div>
        {client === "openai" ? <div className="space-y-1.5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">请求协议</div>
          <div role="radiogroup" aria-label="接入协议" className="grid gap-2 sm:grid-cols-2">
            <Choice checked={endpoint === "/v1/chat/completions"} title="Chat Completions" text="/v1/chat/completions · 兼容性最好，不确定就选它"
              onSelect={() => { setProtocol("/v1/chat/completions"); setSelected(""); }} />
            <Choice checked={endpoint === "/v1/responses"} title="Responses" text="/v1/responses · 仅在客户端明确使用 Responses 接口时选择"
              onSelect={() => { setProtocol("/v1/responses"); setSelected(""); }} />
          </div>
        </div> : null}
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          {client === "anthropic"
            ? "使用 /v1/messages 接口，请求必须带 max_tokens；Base URL 不带 /v1。"
            : client === "dsh"
            ? "DSH 使用 OpenAI 文本 profile 格式，并要求模型声明真实上下文与输出上限等完整能力。"
            : "以客户端实际支持的协议为准，不按模型名称猜测。"}
        </p>
      </Step>

      <Step n={3} title="选择模型">
        {!models ? <p role="status">模型列表加载失败，请点击右上角“刷新数据”。</p>
          : options.length === 0 ? <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">没有支持此客户端 / 协议的文本模型，请切换协议或联系管理员。</p>
          : <label className="block">
            <span className="sr-only">兼容模型</span>
            <select aria-label="兼容模型" className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              value={config?.model ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {options.map((model) => <option key={model.id} value={model.id}>{model.label === model.id ? model.id : model.label + " · " + model.id}</option>)}
            </select>
          </label>}
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          仅列出你有权限、且支持所选协议的文本模型。
          {onOpenModels ? <> <button type="button" onClick={onOpenModels} className="font-medium text-brand-600 hover:underline dark:text-brand-400">在模型广场查看价格 →</button></> : null}
        </p>
      </Step>

      <Step n={4} title={client === "dsh" ? "生成 DSH 配置" : "填入配置并运行"} last>
        {client === "dsh" ? <>
          {config ? null : <p role="status">当前没有满足 DSH 能力要求的模型，暂不生成配置。</p>}
          <ConsoleDshExport models={models} />
        </> : config ? <>
          <p>在客户端里填写这三项即可；<Mono>API Key</Mono> 处粘贴第 1 步创建的子 Token。</p>
          <div className="grid gap-2 lg:grid-cols-3">
            <CopyRow label="Base URL" value={config.baseURL} hint={endpoint === "/v1/messages" ? "Anthropic SDK 使用根地址，不要拼接 /v1" : "OpenAI SDK 使用带 /v1 的地址，不要重复拼接"} />
            <CopyRow label="Model" value={config.model} />
            <div className="flex min-w-0 items-center rounded-lg border border-dashed border-slate-300 px-3 py-2 dark:border-slate-700">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">API Key</div>
                <div className="text-[13px] text-slate-700 dark:text-slate-200">你的子 Token（以 ccs_ 开头）</div>
              </div>
            </div>
          </div>
          <p>也可以直接运行下面的示例：先在“环境变量”里设置 <Mono>CPG_API_KEY</Mono>，示例会从中读取密钥。</p>
          <SnippetTabs config={config} protocol={endpoint} />
        </> : <p role="status">完成第 3 步后，这里会生成可直接复制的配置和示例代码。</p>}
      </Step>
    </ol>
  </Card>;
}

export function ConsoleGuide({
  models,
  onOpenModels,
  onOpenKeys,
  playground,
}: {
  models: ConsoleModels | null | undefined;
  onOpenModels?: () => void;
  onOpenKeys?: () => void;
  /** Optional in-page "try it" panel rendered right after the setup steps. */
  playground?: ReactNode;
}) {
  const base = gatewayBase();
  const items: ModelItem[] = models?.items ?? [];
  const embeddingModel = items.find(isEmbeddingModel)?.model_name;
  const embeddingBody = useMemo(() => embeddingModel
    ? JSON.stringify({ model: embeddingModel, input: ["你好", "语义搜索"], encoding_format: "float", user: "example-user" }, null, 2)
    : '{\n  "model": "your-embedding-model",\n  "input": ["你好", "语义搜索"],\n  "encoding_format": "float",\n  "user": "example-user"\n}', [embeddingModel]);
  const embeddingCode = [
    "curl " + base + "/v1/embeddings \\",
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
    "curl " + base + "/v1/video/generations \\",
    '  -H "Authorization: Bearer $CPG_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Idempotency-Key: example-video-job-001" \\',
    "  -d '" + videoBody + "'",
    "",
    "curl " + base + "/v1/video/generations -H \"Authorization: Bearer $CPG_API_KEY\"",
    "curl " + base + "/v1/video/generations/YOUR_TASK_ID -H \"Authorization: Bearer $CPG_API_KEY\"",
  ].join("\n");

  const imageCode = perCall
    ? [
        "curl " + base + "/v1/chat/completions \\",
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
    <div className="space-y-5">

      <ConsoleConnectionWizard models={models} onOpenKeys={onOpenKeys} onOpenModels={onOpenModels} />

      {playground ? <section id="guide-playground" aria-label="在线试一句">{playground}</section> : null}

      <Card title="接入信息速查">
        <div className="grid gap-2 md:grid-cols-3">
          <CopyRow label="OpenAI 兼容 Base URL" value={base + "/v1"} />
          <CopyRow label="Anthropic Base URL" value={base} />
          <CopyRow label="鉴权请求头" value="Authorization: Bearer <API 密钥>" hint="Anthropic 客户端也可用 x-api-key 请求头" />
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          所有 <Mono>/v1</Mono> 请求都需要 API 密钥（子 Token）。
        </p>
      </Card>

      <section aria-labelledby="guide-reference-heading" className="space-y-2">
        <div>
          <h3 id="guide-reference-heading" className="font-semibold text-slate-900 dark:text-slate-100">更多接口与参考</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">向量、图片、视频等接口和常见问题。</p>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200/60 bg-white dark:border-slate-800 dark:bg-slate-900">
          <RefSection id="guide-embeddings" title="Embeddings · 文本向量" summary="/v1/embeddings · 仅按输入 Token 计费">
            <p>向量模型使用 <Mono>/v1/embeddings</Mono>，不要发送到对话接口。首版 <Mono>input</Mono> 接受一个字符串或字符串数组（不支持 token ID 数组）；<Mono>encoding_format</Mono> 为 <Mono>float</Mono> 或 <Mono>base64</Mono>。可选 <Mono>dimensions</Mono> 必须为上游支持的正整数，<Mono>user</Mono> 为字符串。</p>
            <CodeBlock code={embeddingCode} lang="curl · Embeddings" />
            <p>仅按输入 Token 计费，不收输出费用。不传 dimensions 时使用模型默认维数。</p>
            <p>向量维数和兼容性以模型声明为准，不同模型生成的向量不要混用。</p>
          </RefSection>

          {perCall ? (
            <RefSection id="guide-image" title="图生图（按次计费模型）" summary="chat/completions + image_url · 一次请求计一次费">
              <p>
                按次计费模型（如 <Mono>{perCall.model_name}</Mono>）走 <Mono>chat/completions</Mono>
                ，content 用数组并附 <Mono>image_url</Mono>（base64 data URL
                同样支持）；一次请求计一次 <Mono>price_per_call</Mono>
                。纯文本请求会被 400 <Mono>per_call_text_only</Mono> 拒绝。
              </p>
              <CodeBlock code={imageCode} lang="curl · 图生图" />
            </RefSection>
          ) : null}

          <RefSection id="guide-video-standard" title="标准视频 API" summary="/v1/videos · 按报价表计费，仅成功任务结算">
            <p>标准视频使用 <Mono>POST /v1/videos</Mono> 创建、<Mono>GET /v1/videos</Mono> 列表、<Mono>GET /v1/videos/:id</Mono> 查询。报价按分辨率及是否含参考视频区分，按秒或按次计价；只有成功的任务计费，按提交时的报价结算。</p>
            <p>参考图用 <Mono>POST /v1/videos/reference-images</Mono> 上传（JPEG / PNG / WebP 二进制，单张最多 5 MiB）。参考视频先用 <Mono>GET /v1/videos/reference-videos/limits</Mono> 查询限制，再以 <Mono>video/mp4</Mono> 上传到 <Mono>POST /v1/videos/reference-videos</Mono>。</p>
            <p>提交必须携带 <Mono>Idempotency-Key</Mono>；重试同一个任务时沿用原 key 和原请求体，不会重复计费。</p>
          </RefSection>

          <RefSection id="guide-video-vendors" title="Minimax 与 Doubao 视频 · 独立能力规则" summary="首尾帧、素材组合与默认参数的差异">
            <p>Minimax 标准视频保留原有规则：尾帧必须有首帧，首尾帧不能混用参考图、视频或音频；按秒报价。不要套用 Doubao 的素材上限或组合规则。</p>
            <p>Doubao 模型由公开 video.request_format=doubao_content 标识。创建可使用 model、prompt、duration、ratio、resolution 和 reference_image_ids / reference_video_ids、first_frame_id / last_frame_id、image_urls / video_urls / audio_urls 简写，或官方 content 数组；不要混用 content 与简写。默认时长与比例取模型公开 default_duration / default_ratio，所有规格、素材数量及 max_total_refs 均以所选分组声明为准，不能按模型名称猜测。</p>
            <p>Doubao 在分组允许首尾帧时可仅传尾帧、可帧+音频；不能把帧与普通参考图或视频混用。私有上传服务仍独立限制最多 9 张图 / 3 个视频，不代表外部 URL 或模型能力上限。音频单独参考需分组显式开启。</p>
            <p>Doubao 报价分 ¥/次和 ¥/秒。任务 completed 但 content_available=false 时表示下载未配置，请联系管理员获取结果，无需重新提交。</p>
          </RefSection>

          <RefSection id="guide-video-legacy" title="旧版视频 API" summary="/v1/video/generations · 按成功任务次数计费">
            <p>使用 <Mono>POST /v1/video/generations</Mono> 提交，<Mono>GET /v1/video/generations</Mono> 列表，<Mono>GET /v1/video/generations/:id</Mono> 查询。只有 <Mono>succeeded</Mono> 的任务收一次 <Mono>price_per_call</Mono>，不是按秒计费，失败不扣费。</p>
            <p>必填 <Mono>model、prompt、seconds、size</Mono>。把示例中的 <Mono>YOUR_SUPPORTED_SIZE</Mono> 换成模型支持的尺寸，<Mono>seconds</Mono> 为 3–15 秒。提交必须携带 <Mono>Idempotency-Key</Mono>，重试时沿用相同 key 和请求体。</p>
            <CodeBlock code={videoCode} lang="curl · Video" />
            <p>模型声明了 <Mono>video.reference_images.max_images</Mono> 时可使用参考图：先上传到 <Mono>POST /v1/video/reference-images</Mono>，再把返回的 ID 按顺序填入 <Mono>reference_image_ids</Mono>。最多 3 张，每张 5 MiB、合计 15 MiB，仅 JPEG / PNG / WebP。</p>
            <p><Mono>submitting / submission_unknown / pending</Mono> 都不是失败，请继续查询，不要换 key 重新提交。任务 <Mono>succeeded</Mono> 后，通过 <Mono>/v1/video/generations/:id/content</Mono> 获取短时链接播放或下载，重复播放不会再次收费。</p>
          </RefSection>

          <RefSection id="guide-endpoints" title="端点清单" summary={ENDPOINTS.length + " 个公开接口"}>
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    <th scope="col" className="py-1.5 pr-3 font-medium">方法</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">路径</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">说明</th>
                    <th scope="col" className="py-1.5 font-medium"><span className="sr-only">复制</span></th>
                  </tr>
                </thead>
                <tbody>
                  {ENDPOINTS.map((e) => (
                    <tr key={e.method + e.path} className="border-t border-slate-100 dark:border-slate-800/80">
                      <td className="py-2 pr-3 font-mono text-[11px] text-brand-600 dark:text-brand-400">{e.method}</td>
                      <td className="py-2 pr-3 font-mono text-[12px] text-slate-700 dark:text-slate-200">{e.path}</td>
                      <td className="py-2 pr-3">{e.desc}</td>
                      <td className="py-2"><CopyButton text={e.path} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs">流式输出：对话请求体加 <Mono>"stream": true</Mono>，响应为 SSE 增量帧。余额查询 <Mono>/v1/dashboard/billing/subscription</Mono> 与 <Mono>/usage</Mono> 为 OpenAI 历史兼容格式，限流 3 RPM。</p>
          </RefSection>

          <RefSection id="guide-billing" title="计费规则" summary="Token、按次、峰谷倍率与预占">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>文本 Token 计费模型：按输入 / 输出 token 单价（每百万）计费，另有缓存读 / 写价。</li>
              <li>Embedding 模型：仅按输入 token 单价（每百万）计费，不收输出费，不使用响应缓存。</li>
              <li>按次计费模型：一次请求一次 <Mono>price_per_call</Mono>，与图片大小无关。</li>
              <li>峰谷定价：模型广场里显示当前倍率与时段，处于峰时按倍率上浮计价。</li>
              <li>预占机制：请求开始先冻结预估费用，响应结束后按实际用量结算、多余返还。</li>
            </ul>
            {onOpenModels ? <button type="button" onClick={onOpenModels} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">查看具体价格 →</button> : null}
          </RefSection>

          <RefSection id="guide-errors" title="限制与常见错误" summary="报错代码是什么意思、该怎么办">
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    <th scope="col" className="py-1.5 pr-3 font-medium">错误码</th>
                    <th scope="col" className="py-1.5 pr-3 font-medium">意思</th>
                    <th scope="col" className="py-1.5 font-medium">怎么办</th>
                  </tr>
                </thead>
                <tbody>
                  {GATEWAY_ERROR_HELP.map((e) => (
                    <tr key={e.code} className="border-t border-slate-100 align-top dark:border-slate-800/80">
                      <td className="whitespace-nowrap py-2 pr-3 font-mono text-[12px] text-slate-700 dark:text-slate-200">{e.code}</td>
                      <td className="py-2 pr-3">{e.what}</td>
                      <td className="py-2">{e.fix}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs">
              错误码在响应的 <Mono>error</Mono> 字段里，例如 <Mono>{'{"error": "insufficient_balance"}'}</Mono>；个别接口按 OpenAI 形态返回 <Mono>{'{"error": {"message", "type", "code"}}'}</Mono>，这时看 <Mono>code</Mono>。
              请求体上限 10MB；如果 1MB 左右就报 413，通常是你自己链路上的反向代理限制。
            </p>
          </RefSection>
        </div>
      </section>
    </div>
  );
}
