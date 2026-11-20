import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { buildDshProfile, DSH_PROFILE_HELP, type ModelConfigMetadata } from "../utils/modelConfigExport";
import { isEmbeddingModel, isTextModel, isVideoModel } from "../utils/modelType";
import { consoleAccountApi, type ConsoleApiKeyCheck, type ConsoleModels } from "../api/consoleClient";
import { Button, Card, CopyButton, Input } from "./ui";
import { IconAlertTriangle, IconCheck, IconKey } from "./icons";
import { GATEWAY_ERROR_HELP } from "../utils/gatewayErrors";
import { CodeBlock, CodeTab, type CodeLang } from "./CodeBlock";
import { ConsoleAccessCard, CopyRow, gatewayBase, Mono } from "./ConsoleAccessCard";

export { gatewayBase };

type ModelItem = ConsoleModels["items"][number];

/** Collapsible reference topic; content stays in the DOM so it is searchable with the browser's find. */
function RefSection({ id, title, summary, children }: { id: string; title: string; summary?: string; children: ReactNode }) {
  return (
    <details id={id} className="group scroll-mt-24 border-t border-slate-100 first:border-t-0 dark:border-slate-800">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 hover:bg-slate-50 sm:px-5 dark:hover:bg-slate-800/40 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span>
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

const SNIPPET_TABS: { key: SnippetKind; label: string; lang: CodeLang }[] = [
  { key: "env", label: "环境变量", lang: "bash" },
  { key: "curl", label: "curl", lang: "bash" },
  { key: "python", label: "Python", lang: "python" },
  { key: "node", label: "Node.js", lang: "js" },
];

/** A dark code panel with a tab strip in its title bar. */
function TabbedCode({ tabs, label, initial = 0 }: { tabs: { key: string; label: string; lang: CodeLang; code: string }[]; label: string; initial?: number }) {
  const [index, setIndex] = useState(initial);
  const current = tabs[Math.min(index, tabs.length - 1)];
  return <CodeBlock code={current.code} lang={current.lang} tabs={
    <div role="tablist" aria-label={label} className="flex items-center gap-1">
      {tabs.map((tab, i) => <CodeTab key={tab.key} active={tab.key === current.key} onClick={() => setIndex(i)}>{tab.label}</CodeTab>)}
    </div>} />;
}

function SnippetTabs({ config, protocol }: { config: ConnectionConfig; protocol: ConnectionProtocol }) {
  const snippets = connectionSnippets(config, protocol);
  return <TabbedCode label="示例代码" initial={1} tabs={SNIPPET_TABS.map((tab) => ({ ...tab, code: snippets[tab.key] }))} />;
}

export function ConsoleDshExport({ models }: { models: ConsoleModels | null | undefined }) {
  const [show, setShow] = useState(false);
  const dshExport = useMemo(() => show && models ? buildDshProfile(models.items, gatewayBase() + "/v1") : null, [show, models]);
  return <div className="space-y-3">
    <p>DSH 使用 profile JSON 配置，包含你可用的模型；密钥从环境变量 <Mono>CPG_API_KEY</Mono> 读取。</p>
    <Button type="button" variant="outline" size="sm" onClick={() => setShow((value) => !value)}>{show ? "收起 DSH 配置" : "生成 DSH 配置 JSON"}</Button>
    {show && !models && <p role="alert">模型列表加载失败，无法生成。</p>}
    {dshExport && <>
      {(dshExport.warnings.length > 0 || dshExport.skipped.length > 0) && <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
        {dshExport.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
        {dshExport.skipped.map(({ id, reason }) => <p key={id}>已跳过 {id}：{reason}</p>)}
      </div>}
      <CodeBlock code={JSON.stringify(dshExport.config, null, 2)} title="DSH profile JSON" />
    </>}
    <p className="text-xs text-slate-500 dark:text-slate-400">{DSH_PROFILE_HELP}</p>
  </div>;
}

function Step({ n, title, children, last = false }: { n: number; title: string; children: ReactNode; last?: boolean }) {
  return <li className="relative flex gap-4">
    {!last ? <span aria-hidden="true" className="absolute bottom-0 left-[13px] top-9 w-px bg-gradient-to-b from-brand-200 to-slate-200 dark:from-brand-800 dark:to-slate-800" /> : null}
    <span aria-hidden="true" className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white shadow-[0_0_0_4px] shadow-brand-50 dark:shadow-brand-500/10">{n}</span>
    <div className={"min-w-0 flex-1 space-y-3 " + (last ? "" : "pb-8")}>
      <h3 className="pt-0.5 text-[15px] font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {children}
    </div>
  </li>;
}

function Choice({ checked, title, text, onSelect }: { checked: boolean; title: string; text: string; onSelect: () => void }) {
  return <button type="button" role="radio" aria-checked={checked} onClick={onSelect}
    className={"min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + (checked
      ? "border-brand-500 bg-brand-50/70 ring-1 ring-brand-500 dark:border-brand-500 dark:bg-brand-500/10"
      : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")}>
    <span className={"block text-sm font-medium " + (checked ? "text-brand-700 dark:text-brand-200" : "text-slate-800 dark:text-slate-100")}>{title}</span>
    <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{text}</span>
  </button>;
}

const CHAT: ConnectionProtocol = "/v1/chat/completions";
const RESPONSES: ConnectionProtocol = "/v1/responses";
const MESSAGES: ConnectionProtocol = "/v1/messages";

export type ConnectionApp = "openai" | "anthropic" | "cherry" | "chatbox" | "immersive" | "claude-code" | "codex" | "dsh";

interface AppInfo {
  key: ConnectionApp;
  title: string;
  text: string;
  group: "sdk" | "app" | "agent";
  client: ConnectionClient;
  /** Protocol the app always uses; apps without one let the user pick. */
  protocol?: ConnectionProtocol;
  hint: string;
  mark: string;
  tone: string;
}

export const CONNECTION_APPS: readonly AppInfo[] = [
  { key: "openai", group: "sdk", title: "OpenAI 兼容", text: "OpenAI SDK 及大多数兼容 OpenAI 接口的客户端", client: "openai",
    hint: "以客户端实际支持的协议为准，不按模型名称猜测。", mark: "AI", tone: "bg-slate-900 text-white dark:bg-white dark:text-slate-900" },
  { key: "anthropic", group: "sdk", title: "Anthropic", text: "Anthropic SDK 及使用 Messages 接口的客户端", client: "anthropic", protocol: MESSAGES,
    hint: "使用 /v1/messages 接口，请求必须带 max_tokens；Base URL 不带 /v1。", mark: "A", tone: "bg-[#d97757] text-white" },
  { key: "cherry", group: "app", title: "Cherry Studio", text: "桌面 AI 聊天客户端", client: "openai", protocol: CHAT,
    hint: "按 OpenAI 类型添加，走 /v1/chat/completions 接口。", mark: "Ch", tone: "bg-rose-500 text-white" },
  { key: "chatbox", group: "app", title: "Chatbox", text: "桌面与手机聊天客户端", client: "openai", protocol: CHAT,
    hint: "以 OpenAI API 兼容模式添加，走 /v1/chat/completions 接口。", mark: "Cb", tone: "bg-sky-500 text-white" },
  { key: "immersive", group: "app", title: "沉浸式翻译", text: "浏览器网页与文档翻译插件", client: "openai", protocol: CHAT,
    hint: "按自定义 OpenAI 服务添加，要求填写完整的接口地址。", mark: "译", tone: "bg-violet-500 text-white" },
  { key: "claude-code", group: "agent", title: "Claude Code", text: "Anthropic 终端编程助手", client: "anthropic", protocol: MESSAGES,
    hint: "使用 /v1/messages 接口，请求必须带 max_tokens；Claude Code 会自动处理。", mark: ">_", tone: "bg-[#cc785c] text-white" },
  { key: "codex", group: "agent", title: "Codex CLI", text: "OpenAI 终端编程助手", client: "openai", protocol: RESPONSES,
    hint: "Codex 使用 /v1/responses 接口，只列出支持它的模型。", mark: ">_", tone: "bg-slate-800 text-white dark:bg-slate-700" },
  { key: "dsh", group: "agent", title: "DeepSeek Harness", text: "生成 DSH profile 配置文件", client: "dsh",
    hint: "DSH 使用 OpenAI 文本 profile 格式，并要求模型声明真实上下文与输出上限等完整能力。", mark: "DS", tone: "bg-blue-600 text-white" },
];

const APP_GROUPS: { key: AppInfo["group"]; label: string }[] = [
  { key: "sdk", label: "SDK 与代码" },
  { key: "app", label: "聊天与翻译应用" },
  { key: "agent", label: "编程助手" },
];

/** The chosen app, or the plain SDK entry for the client when the stored choice no longer matches it. */
export function connectionApp(client: ConnectionClient, app?: ConnectionApp): AppInfo {
  const chosen = CONNECTION_APPS.find((item) => item.key === app);
  if (chosen && chosen.client === client) return chosen;
  return CONNECTION_APPS.find((item) => item.key === client)!;
}

function AppChoice({ app, checked, onSelect }: { app: AppInfo; checked: boolean; onSelect: () => void }) {
  // The title span stays first inside the button; the grid puts the icon on the left.
  return <button type="button" role="radio" aria-checked={checked} onClick={onSelect}
    className={"grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-x-3 rounded-xl border px-3 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 " + (checked
      ? "border-brand-500 bg-brand-50/70 ring-1 ring-brand-500 dark:border-brand-500 dark:bg-brand-500/10"
      : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600")}>
    <span className={"col-start-2 row-start-1 truncate text-sm font-medium " + (checked ? "text-brand-700 dark:text-brand-200" : "text-slate-900 dark:text-slate-100")}>{app.title}</span>
    <span className="col-start-2 row-start-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{app.text}</span>
    <span aria-hidden="true" className={"col-start-1 row-span-2 row-start-1 flex h-9 w-9 items-center justify-center self-start rounded-lg font-mono text-[12px] font-bold " + app.tone}>{app.mark}</span>
  </button>;
}

interface SettingRow { label: string; value: string; hint?: string; secret?: boolean }

/** Field-by-field settings for desktop and browser apps, using the address form each app expects. */
export function appSettings(app: ConnectionApp, model: string, base: string): { path: string[]; rows: SettingRow[]; note: string } | null {
  const key: SettingRow = { label: "API 密钥", value: "粘贴第 1 步创建的 API 密钥", secret: true };
  if (app === "cherry") return {
    path: ["设置", "模型服务", "添加", "提供商类型选 OpenAI"],
    rows: [
      { label: "提供商名称", value: "CPG" },
      key,
      { label: "API 地址", value: base, hint: "只填根地址，Cherry Studio 会自动补上 /v1/chat/completions" },
      { label: "模型 ID", value: model, hint: "在“管理”里添加模型，填入这个 ID" },
    ],
    note: "填完点 API 密钥旁的“检查”，提示连接成功后，就能在对话里选这个模型。",
  };
  if (app === "chatbox") return {
    path: ["设置", "模型提供方", "添加", "API 模式选 OpenAI API 兼容"],
    rows: [
      { label: "名称", value: "CPG" },
      { label: "API 主机", value: base, hint: "只填根地址" },
      { label: "API 路径", value: "/v1/chat/completions" },
      { ...key },
      { label: "模型", value: model, hint: "在模型列表里新建一项，填入这个名称" },
    ],
    note: "保存后，在对话设置里切换到 CPG 和这个模型。",
  };
  if (app === "immersive") return {
    path: ["设置", "翻译服务", "添加兼容 OpenAI 的自定义 AI 服务"],
    rows: [
      { label: "自定义 API 接口地址", value: base + "/v1/chat/completions", hint: "这里要填完整地址，包含 /v1/chat/completions" },
      { ...key, label: "APIKEY" },
      { label: "模型", value: model, hint: "选“自定义模型”后填入" },
    ],
    note: "整页翻译会同时发出很多请求，按 Token 计费。建议选便宜、速度快的模型，并适当调低“每秒最大请求数”。",
  };
  return null;
}

/** Terminal setups for the coding agents. The key is pasted by the user, never filled in here. */
export function agentSnippets(app: "claude-code" | "codex", model: string, base: string): { key: string; label: string; lang: CodeLang; code: string }[] {
  const q = JSON.stringify(model);
  if (app === "claude-code") {
    const vars: [string, string][] = [
      ["ANTHROPIC_BASE_URL", base],
      ["ANTHROPIC_AUTH_TOKEN", "粘贴你的 API 密钥"],
      ["ANTHROPIC_MODEL", model],
      ["ANTHROPIC_DEFAULT_HAIKU_MODEL", model],
    ];
    return [
      { key: "unix", label: "macOS / Linux", lang: "bash", code: [
        "# 安装：npm install -g @anthropic-ai/claude-code",
        ...vars.map(([name, value]) => "export " + name + "=" + JSON.stringify(value)),
        "claude",
      ].join("\n") },
      { key: "windows", label: "Windows", lang: "powershell", code: [
        "# PowerShell",
        ...vars.map(([name, value]) => "$env:" + name + " = " + JSON.stringify(value)),
        "claude",
      ].join("\n") },
      { key: "settings", label: "settings.json", lang: "json", code: JSON.stringify({ env: Object.fromEntries(vars) }, null, 2) },
    ];
  }
  return [
    { key: "config", label: "config.toml", lang: "toml", code: [
      "# ~/.codex/config.toml（Windows：%USERPROFILE%\\.codex\\config.toml）",
      "model = " + q,
      'model_provider = "cpg"',
      "",
      "[model_providers.cpg]",
      'name = "CPG"',
      "base_url = " + JSON.stringify(base + "/v1"),
      'env_key = "CPG_API_KEY"',
      'wire_api = "responses"',
    ].join("\n") },
    { key: "unix", label: "macOS / Linux", lang: "bash", code: 'export CPG_API_KEY="粘贴你的 API 密钥"\ncodex' },
    { key: "windows", label: "Windows", lang: "powershell", code: '$env:CPG_API_KEY = "粘贴你的 API 密钥"\ncodex' },
  ];
}

function AppSettingsPanel({ app, path, rows, note }: { app: AppInfo; path: string[]; rows: SettingRow[]; note: string }) {
  return <div className="space-y-3">
    <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
        <span aria-hidden="true" className={"mr-1 flex h-5 w-5 items-center justify-center rounded font-mono text-[9px] font-bold " + app.tone}>{app.mark}</span>
        <span className="font-medium text-slate-700 dark:text-slate-200">{app.title}</span>
        {path.map((part) => <span key={part} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="text-slate-300 dark:text-slate-600">›</span>{part}</span>)}
      </div>
      <dl className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900">
        {rows.map((row) => <div key={row.label} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:flex-nowrap">
          <dt className="w-full shrink-0 text-xs font-medium text-slate-500 sm:w-32 dark:text-slate-400">{row.label}</dt>
          <dd className="min-w-0 flex-1">
            <span className={row.secret ? "text-[13px] italic text-slate-500 dark:text-slate-400" : "break-all font-mono text-[13px] text-slate-900 dark:text-slate-100"}>{row.value}</span>
            {row.hint ? <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">{row.hint}</span> : null}
          </dd>
          {row.secret ? null : <CopyButton text={row.value} label="复制" className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white" />}
        </div>)}
      </dl>
    </div>
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{note}</p>
  </div>;
}

function SuccessHint() {
  return <div className="flex gap-2.5 rounded-xl border border-emerald-200/70 bg-emerald-50/60 px-3 py-2.5 text-xs leading-5 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
    <IconCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    <span>看到模型回复就说明接通了。报错时先用右侧的“检查 API 密钥”，再对照“接不通？”里的常见原因。</span>
  </div>;
}

export interface GuidePrefs {
  app?: ConnectionApp;
  model?: string;
}

const MODEL_ROUTES: [ConnectionClient, ConnectionProtocol, ConnectionApp][] = [
  ["openai", CHAT, "openai"],
  ["openai", RESPONSES, "openai"],
  ["anthropic", MESSAGES, "anthropic"],
];

export function ConsoleConnectionWizard({ models, onOpenKeys, onOpenModels, apiKeyCount, initial, onChange }: {
  models: ConsoleModels | null | undefined;
  onOpenKeys?: () => void;
  onOpenModels?: () => void;
  /** Number of usable API keys on the account, when known. */
  apiKeyCount?: number;
  /** App and model to start with, e.g. when arriving from the model marketplace. */
  initial?: GuidePrefs;
  onChange?: (prefs: GuidePrefs) => void;
}) {
  const initialApp = CONNECTION_APPS.find((item) => item.key === initial?.app);
  // Keep these three pieces of state first, in this order (tests seed them positionally).
  const [client, setClient] = useState<ConnectionClient>(initialApp?.client ?? "openai");
  const [protocol, setProtocol] = useState<ConnectionProtocol>(CHAT);
  const [selected, setSelected] = useState(initial?.model ?? "");
  const [appKey, setAppKey] = useState<ConnectionApp | undefined>(initialApp?.key);
  const app = connectionApp(client, appKey);
  const endpoint = connectionProtocol(client, app.protocol ?? protocol);
  const items = models?.items ?? [];
  const options = connectionModels(items, client, endpoint);
  const config = connectionConfig(items, client, endpoint, selected);

  // A model picked elsewhere may only work over another protocol: move to the first route that lists it.
  const wanted = useRef(initial?.model);
  useEffect(() => {
    const want = wanted.current;
    if (!want || !models) return;
    wanted.current = undefined;
    if (connectionModels(models.items, client, endpoint).some((option) => option.id === want)) return;
    const route = MODEL_ROUTES.find(([c, p]) => connectionModels(models.items, c, p).some((option) => option.id === want));
    if (!route) return;
    setClient(route[0]);
    setProtocol(route[1]);
    setAppKey(route[2]);
  }, [models]);

  useEffect(() => {
    if (config) onChange?.({ app: app.key, model: config.model });
  }, [app.key, config?.model]);

  const choose = (next: AppInfo) => {
    setClient(next.client);
    setAppKey(next.key);
  };
  const settings = config ? appSettings(app.key, config.model, gatewayBase()) : null;

  return <Card title={<span className="flex flex-wrap items-baseline gap-x-2"><span>快速接入 · 4 步完成</span><span className="text-xs font-normal text-slate-500 dark:text-slate-400">选好应用，复制配置即可</span></span>}>
    <ol className="text-sm leading-6 text-slate-600 dark:text-slate-300">
      <Step n={1} title="准备 API 密钥">
        <p>API 密钥就是<strong className="font-medium text-slate-800 dark:text-slate-100">子 Token</strong>：每个应用单独创建一个，明文只在创建时显示一次。登录用的主 Token 不要填进第三方应用，也不要放进公开链接。</p>
        {apiKeyCount === undefined ? null : apiKeyCount > 0
          ? <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300"><IconCheck aria-hidden="true" className="h-3.5 w-3.5" />你已有 {apiKeyCount} 个可用的 API 密钥。找不到明文时新建一个即可。</p>
          : <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300"><IconAlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />你还没有 API 密钥，先创建一个。</p>}
        {onOpenKeys
          ? <button type="button" onClick={onOpenKeys} className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-xs hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900">创建子 Token →</button>
          : <p>前往账户中的 Token 管理创建子 Token，再返回继续配置。</p>}
      </Step>

      <Step n={2} title="选择你的客户端">
        <div role="radiogroup" aria-label="接入客户端" className="space-y-3">
          {APP_GROUPS.map((group) => <div key={group.key}>
            <div className="mb-1.5 text-[11px] font-medium text-slate-400 dark:text-slate-500">{group.label}</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CONNECTION_APPS.filter((item) => item.group === group.key).map((item) =>
                <AppChoice key={item.key} app={item} checked={app.key === item.key} onSelect={() => choose(item)} />)}
            </div>
          </div>)}
        </div>
        {app.key === "openai" ? <div className="space-y-1.5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">请求协议</div>
          <div role="radiogroup" aria-label="接入协议" className="grid gap-2 sm:grid-cols-2">
            <Choice checked={endpoint === CHAT} title="Chat Completions" text="/v1/chat/completions · 兼容性最好，不确定就选它"
              onSelect={() => setProtocol(CHAT)} />
            <Choice checked={endpoint === RESPONSES} title="Responses" text="/v1/responses · 仅在客户端明确使用 Responses 接口时选择"
              onSelect={() => setProtocol(RESPONSES)} />
          </div>
        </div> : null}
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{app.hint}</p>
      </Step>

      <Step n={3} title="选择模型">
        {!models ? <p role="status">模型列表加载失败，请点击右上角“刷新数据”。</p>
          : options.length === 0 ? <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">没有支持此客户端 / 协议的文本模型，请切换协议或联系管理员。</p>
          : <label className="block">
            <span className="sr-only">兼容模型</span>
            <select aria-label="兼容模型" className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-xs focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              value={config?.model ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {options.map((model) => <option key={model.id} value={model.id}>{model.label === model.id ? model.id : model.label + " · " + model.id}</option>)}
            </select>
          </label>}
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          仅列出你有权限、且支持所选协议的文本模型。{app.key === "claude-code" ? "Claude Code 依赖工具调用，请选支持工具调用的模型。" : ""}
          {onOpenModels ? <> <button type="button" onClick={onOpenModels} className="font-medium text-brand-600 hover:underline dark:text-brand-400">在模型广场查看价格 →</button></> : null}
        </p>
      </Step>

      <Step n={4} title={client === "dsh" ? "生成 DSH 配置" : "填入配置并运行"} last>
        {client === "dsh" ? <>
          {config ? null : <p role="status">当前没有满足 DSH 能力要求的模型，暂不生成配置。</p>}
          <ConsoleDshExport models={models} />
        </> : !config ? <p role="status">完成第 3 步后，这里会生成可直接复制的配置和示例代码。</p>
        : settings ? <AppSettingsPanel app={app} {...settings} />
        : app.key === "claude-code" || app.key === "codex" ? <>
          <p>{app.key === "claude-code"
            ? <>在终端里设置下面几项再运行 <Mono>claude</Mono>；写进 <Mono>~/.claude/settings.json</Mono> 可长期生效。后台小任务也会用同一个模型。</>
            : <>把配置写入 <Mono>~/.codex/config.toml</Mono>，再在终端设置 <Mono>CPG_API_KEY</Mono> 并运行 <Mono>codex</Mono>。密钥不写进配置文件。</>}</p>
          <TabbedCode label="配置步骤" tabs={agentSnippets(app.key, config.model, gatewayBase())} />
        </> : <>
          <p>在客户端里填写这三项即可；<Mono>API Key</Mono> 处粘贴第 1 步创建的子 Token。</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="sm:col-span-2"><CopyRow label="Base URL" value={config.baseURL} hint={endpoint === MESSAGES ? "Anthropic SDK 使用根地址，不要拼接 /v1" : "OpenAI SDK 使用带 /v1 的地址，不要重复拼接"} /></div>
            <CopyRow label="Model" value={config.model} />
            <div className="flex min-w-0 items-center rounded-xl border border-dashed border-slate-300 px-3 py-2.5 dark:border-slate-700">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">API Key</div>
                <div className="text-[13px] text-slate-700 dark:text-slate-200">你的子 Token（以 ccs_ 开头）</div>
              </div>
            </div>
          </div>
          <p>也可以直接运行下面的示例：先在“环境变量”里设置 <Mono>CPG_API_KEY</Mono>，示例会从中读取密钥。</p>
          <SnippetTabs config={config} protocol={endpoint} />
        </>}
        {config && client !== "dsh" ? <SuccessHint /> : null}
      </Step>
    </ol>
  </Card>;
}

type CheckTone = "ok" | "warn" | "bad";

/** Turns a key-check response into plain-language findings, most important first. */
export function keyCheckFindings(result: ConsoleApiKeyCheck): { tone: CheckTone; text: string }[] {
  const out: { tone: CheckTone; text: string }[] = [];
  if (result.cleaned) out.push({ tone: "warn", text: "粘贴的内容带了空格、引号或 Bearer 前缀。应用里只填密钥本身。" });
  if (result.kind === "unknown") {
    out.push({ tone: "bad", text: "这不是你账户下的有效密钥。检查是否复制完整；找不到明文就新建一个。" });
    return out;
  }
  const name = result.name ? "「" + result.name + "」" : "";
  if (result.kind === "login_token") out.push({ tone: "warn", text: "这是登录用的主 Token。它能调用，但不要填进第三方应用，请改用 API 密钥。" });
  else if (result.status === "active") out.push({ tone: "ok", text: "API 密钥" + name + "状态正常" });
  else out.push({ tone: "bad", text: "API 密钥" + name + (result.status === "revoked" ? "已撤销，不能再用。请换一个或新建。" : "已停用。请换一个或新建。") });
  if (result.status !== "active") return out;
  if (result.kind === "login_token" && !result.calls_enabled) out.push({ tone: "bad", text: "主 Token 已禁止调用，可在“账户与安全”恢复。" });
  const money = (result.available_usd < 0 ? "-¥" : "¥") + Math.abs(result.available_usd).toFixed(2);
  out.push(result.available_usd > 0
    ? { tone: "ok", text: "可用余额 " + money }
    : { tone: "warn", text: "可用余额 " + money + "，按量计费的请求会被拒绝。请联系管理员充值；月卡覆盖的请求不受影响。" });
  out.push(result.model_count
    ? { tone: "ok", text: "可用 " + result.model_count + " 个模型：" + result.models.join("、") + (result.model_count > result.models.length ? " 等" : "") }
    : { tone: "bad", text: "这个密钥没有可用的模型。请联系管理员开通。" });
  return out;
}

const FINDING_STYLE: Record<CheckTone, string> = {
  ok: "bg-emerald-500 text-white",
  warn: "bg-amber-500 text-white",
  bad: "bg-rose-500 text-white",
};

export function ConsoleKeyCheck() {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConsoleApiKeyCheck | null>(null);
  const [error, setError] = useState("");
  async function check(event: FormEvent) {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await consoleAccountApi.checkApiKey(key));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "检查失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }
  return <Card title={<span className="inline-flex items-center gap-2"><IconKey aria-hidden="true" className="h-4 w-4 text-brand-600 dark:text-brand-400" />检查 API 密钥</span>}>
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">粘贴应用里填的密钥，看看它能不能用、能调哪些模型。不产生费用，也不会保存。</p>
    <form onSubmit={check} className="mt-3 flex gap-2">
      <Input type="password" name="api-key-check" aria-label="要检查的 API 密钥" placeholder="ccs_..." value={key} autoComplete="off" spellCheck={false}
        onChange={(event) => { setKey(event.target.value); setResult(null); setError(""); }} className="min-w-0 flex-1 font-mono" />
      <Button type="submit" disabled={busy || !key.trim()}>{busy ? "检查中…" : "检查"}</Button>
    </form>
    {error ? <p role="alert" className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
    {result ? <ul aria-live="polite" className="mt-3 space-y-2">
      {keyCheckFindings(result).map((finding) => <li key={finding.text} className="flex gap-2 text-xs leading-5 text-slate-700 dark:text-slate-200">
        <span aria-hidden="true" className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold " + FINDING_STYLE[finding.tone]}>{finding.tone === "ok" ? "✓" : finding.tone === "warn" ? "!" : "✕"}</span>
        <span className="min-w-0 break-words"><span className="sr-only">{finding.tone === "ok" ? "通过：" : finding.tone === "warn" ? "注意：" : "问题："}</span>{finding.text}</span>
      </li>)}
    </ul> : null}
  </Card>;
}

const SYMPTOMS: { title: string; fix: string }[] = [
  { title: "404 Not Found", fix: "地址形式不对。OpenAI 类填带 /v1 的地址，Anthropic 类和 Cherry Studio 填根地址，沉浸式翻译填完整地址；不要重复拼接 /v1。" },
  { title: "401 / unauthorized", fix: "密钥没填对。用上面的“检查 API 密钥”确认；只填密钥本身，不带空格或 Bearer。" },
  { title: "model_not_found", fix: "模型名要和第 3 步列出的完全一致，不要照搬官方原名。" },
  { title: "insufficient_balance", fix: "可用余额不足，联系管理员充值。" },
  { title: "一直转圈或超时", fix: "检查本机代理是否拦截了这个地址；流式输出需要客户端支持 SSE。" },
];

function GuideTroubleshoot() {
  const openErrors = () => {
    const box = document.getElementById("guide-errors") as HTMLDetailsElement | null;
    if (!box) return;
    box.open = true;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return <Card title="接不通？">
    <ul className="space-y-3">
      {SYMPTOMS.map((item) => <li key={item.title} className="text-xs leading-5">
        <div className="font-mono text-[12px] font-medium text-slate-900 dark:text-slate-100">{item.title}</div>
        <div className="text-slate-500 dark:text-slate-400">{item.fix}</div>
      </li>)}
    </ul>
    <button type="button" onClick={openErrors} className="mt-3 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">查看全部错误码 →</button>
  </Card>;
}

export function ConsoleGuide({
  models,
  onOpenModels,
  onOpenKeys,
  playground,
  apiKeyCount,
  prefs,
  onPrefsChange,
}: {
  models: ConsoleModels | null | undefined;
  onOpenModels?: () => void;
  onOpenKeys?: () => void;
  /** Optional in-page "try it" panel rendered right after the setup steps. */
  playground?: ReactNode;
  apiKeyCount?: number;
  /** App and model to start the wizard with; updated as the user changes them. */
  prefs?: GuidePrefs;
  onPrefsChange?: (prefs: GuidePrefs) => void;
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
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-5">

      <ConsoleConnectionWizard models={models} onOpenKeys={onOpenKeys} onOpenModels={onOpenModels}
        apiKeyCount={apiKeyCount} initial={prefs} onChange={onPrefsChange} />

      {playground ? <section id="guide-playground" aria-label="在线试一句">{playground}</section> : null}

      <section aria-labelledby="guide-reference-heading" className="space-y-2">
        <div>
          <h3 id="guide-reference-heading" className="font-semibold text-slate-900 dark:text-slate-100">更多接口与参考</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">向量、图片、视频等接口和常见问题。</p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
          <RefSection id="guide-embeddings" title="Embeddings · 文本向量" summary="/v1/embeddings · 仅按输入 Token 计费">
            <p>向量模型使用 <Mono>/v1/embeddings</Mono>，不要发送到对话接口。首版 <Mono>input</Mono> 接受一个字符串或字符串数组（不支持 token ID 数组）；<Mono>encoding_format</Mono> 为 <Mono>float</Mono> 或 <Mono>base64</Mono>。可选 <Mono>dimensions</Mono> 必须为上游支持的正整数，<Mono>user</Mono> 为字符串。</p>
            <CodeBlock code={embeddingCode} lang="bash" title="curl · Embeddings" />
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
              <CodeBlock code={imageCode} lang="bash" title="curl · 图生图" />
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
            <CodeBlock code={videoCode} lang="bash" title="curl · Video" />
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

      <aside aria-label="接入工具" className="min-w-0 space-y-5">
        <ConsoleAccessCard />
        <ConsoleKeyCheck />
        <GuideTroubleshoot />
      </aside>
    </div>
  );
}
