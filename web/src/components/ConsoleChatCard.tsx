import { useMemo, useRef, useState } from "react";
import { Button, Card, Empty, Select, Spinner, Textarea } from "./ui";
import { isTextModel } from "../utils/modelType";
import { streamConsoleChat, type ConsoleModels } from "../api/consoleClient";

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

  const selected = items.find((m) => m.model_name === modelName) || items[0];
  const activeModel = modelName || selected?.model_name || "";
  const effortLevels =
    selected?.supported_reasoning_levels && selected.supported_reasoning_levels.length > 0
      ? selected.supported_reasoning_levels
      : EFFORT_LEVELS;

  async function send() {
    const text = input.trim();
    if (!text || !selected || streaming) return;
    setError("");
    setInput("");
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
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
      if (err?.name !== "AbortError") setError(err?.message || "请求失败");
    } finally {
      setStreaming(false);
      abortRef.current = null;
      if (answer) {
        setMessages([...history, { role: "assistant", content: answer }]);
      } else {
        setMessages(history);
      }
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
      <Card title="试一句">
        <Empty text="当前没有可用于对话的模型" />
      </Card>
    );
  }

  const transcript = messages.map((m) => m.role + ": " + m.content).join("\n\n");

  return (
    <Card
      title="试一句"
      action={
        <Button size="sm" variant="ghost" onClick={reset} disabled={streaming}>
          清空
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Select
            aria-label="模型"
            value={activeModel}
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
            disabled={!selected?.supports_reasoning}
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

        {transcript || draft ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-100 dark:border-slate-800 p-3 text-xs text-slate-700 dark:text-slate-300">
            {transcript}
            {transcript ? "\n\n" : ""}
            {draft ? "assistant: " + draft : ""}
          </pre>
        ) : null}

        {error ? (
          <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>
        ) : null}

        <Textarea
          rows={3}
          value={input}
          placeholder="说点什么，回车换行，点击发送"
          onChange={(e) => setInput(e.target.value)}
          disabled={streaming}
        />
        <div className="flex items-center gap-2">
          <Button onClick={send} disabled={streaming || !input.trim()}>
            {streaming ? "生成中…" : "发送"}
          </Button>
          {streaming ? (
            <Button variant="ghost" onClick={stop}>
              停止
            </Button>
          ) : null}
          {streaming ? <Spinner text=" " /> : null}
        </div>
      </div>
    </Card>
  );
}