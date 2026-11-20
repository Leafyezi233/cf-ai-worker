import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Empty, Select, Textarea } from "./ui";
import { isTextModel } from "../utils/modelType";
import { streamConsoleChat, type ConsoleModels } from "../api/consoleClient";
import { explainGatewayError } from "../utils/gatewayErrors";

const EFFORT_LEVELS = [
  { effort: "low", description: "低" },
  { effort: "medium", description: "中" },
  { effort: "high", description: "高" },
  { effort: "xhigh", description: "极高" },
  { effort: "max", description: "最高" },
];

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function Bubble({ role, children, pending = false }: { role: ChatMessage["role"]; children: string; pending?: boolean }) {
  const mine = role === "user";
  return <div className={"flex " + (mine ? "justify-end" : "justify-start")}>
    <div className={"max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-6 " + (mine
      ? "rounded-br-sm bg-brand-600 text-white"
      : "rounded-bl-sm bg-white text-slate-800 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700")}>
      <span className="sr-only">{mine ? "你：" : "模型："}</span>
      {children || (pending ? "…" : "")}
      {pending && children ? <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-current align-text-bottom opacity-60" /> : null}
    </div>
  </div>;
}

export function ConsoleChatCard({ models }: { models: ConsoleModels | null }) {
  const items = useMemo(
    () => (models?.items || []).filter((m) => isTextModel(m) && m.billing_unit !== "call"),
    [models]
  );
  const [modelName, setModelName] = useState("");
  const [effort, setEffort] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const selected = items.find((m) => m.model_name === modelName) || items[0];
  const activeModel = modelName || selected?.model_name || "";
  const effortLevels =
    selected?.supported_reasoning_levels && selected.supported_reasoning_levels.length > 0
      ? selected.supported_reasoning_levels
      : EFFORT_LEVELS;

  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, draft]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send() {
    const text = input.trim();
    if (!text || !selected || streaming) return;
    setError("");
    setInput("");
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setDraft("");
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let answer = "";
    try {
      await streamConsoleChat(
        {
          model: selected.model_name,
          endpoint: selected.chat_endpoint,
          messages: history,
          max_tokens: 4096,
          ...(effort ? { reasoning_effort: effort } : {}),
        },
        (chunk) => {
          answer += chunk;
          setDraft(answer);
        },
        controller.signal
      );
    } catch (err: any) {
      if (err?.name !== "AbortError") setError(explainGatewayError(err?.code, err?.message || "请求失败"));
    } finally {
      setStreaming(false);
      abortRef.current = null;
      setMessages(answer ? [...history, { role: "assistant", content: answer }] : history);
      setDraft("");
    }
  }
  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setDraft("");
    setError("");
  }

  if (!items.length) {
    return (
      <Card title="在线试一句">
        <Empty text="当前没有可用于对话的模型" />
      </Card>
    );
  }

  const empty = messages.length === 0 && !streaming;

  return (
    <Card
      title="在线试一句"
      action={
        <Button size="sm" variant="ghost" onClick={reset} disabled={streaming || messages.length === 0}>
          清空对话
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          不写代码，先确认模型能正常回复。这里使用当前登录账户发起真实调用，会按实际用量计费，并记录在“用量与账单”中。
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Select
            aria-label="模型"
            value={activeModel}
            disabled={streaming}
            onChange={(e) => {
              setModelName(e.target.value);
              setEffort("");
            }}
          >
            {items.map((m) => (
              <option key={m.id} value={m.model_name}>
                {m.display_name || m.model_name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="推理等级"
            value={effort}
            disabled={streaming || !selected?.supports_reasoning}
            onChange={(e) => setEffort(e.target.value)}
          >
            <option value="">
              {selected?.supports_reasoning
                ? selected.default_reasoning_level
                  ? `默认推理等级（${selected.default_reasoning_level}）`
                  : "默认推理等级"
                : "该模型无推理等级"}
            </option>
            {effortLevels.map((level) => (
              <option key={level.effort} value={level.effort}>
                {level.effort}
                {level.description && level.description !== level.effort ? `（${level.description}）` : ""}
              </option>
            ))}
          </Select>
        </div>

        <div ref={scrollRef} aria-live="polite" className="max-h-80 min-h-[7rem] space-y-2 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/60">
          {empty ? <div className="flex h-[5rem] items-center justify-center text-xs text-slate-400 dark:text-slate-500">发送一句话，例如“你好，介绍一下你自己”</div> : null}
          {messages.map((m, i) => <Bubble key={i} role={m.role}>{m.content}</Bubble>)}
          {streaming ? <Bubble role="assistant" pending>{draft}</Bubble> : null}
        </div>

        {error ? (
          <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/30 dark:text-rose-400">{error}</div>
        ) : null}

        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Textarea
            aria-label="输入消息"
            rows={2}
            value={input}
            placeholder="输入消息；Ctrl / ⌘ + Enter 发送，Enter 换行"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
            }}
            disabled={streaming}
            className="!font-sans"
          />
          <div className="flex items-center justify-end gap-2">
            {streaming ? <Button type="button" variant="outline" onClick={stop}>停止生成</Button> : null}
            <Button type="submit" disabled={streaming || !input.trim()}>
              {streaming ? "生成中…" : "发送"}
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}
