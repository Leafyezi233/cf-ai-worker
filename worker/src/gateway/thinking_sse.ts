import { ThinkingSplitter, joinSegments } from "./thinking";

const LF = String.fromCharCode(10);
const Q = String.fromCharCode(34);
const DATA_PREFIX = "data: ";
const DATA_KEYWORD = "data:";
const MAX_PENDING_CHARS = 256 * 1024;
const MAX_TRACKED_CHARS = 512 * 1024;
const LF_CODE = 10;
const ALIAS_NEEDLES = [Q + "reasoning" + Q, Q + "thinking" + Q, Q + "reasoning_details" + Q];

const REASONING_ALIASES = ["reasoning", "thinking"] as const;

export interface ChatReasoningState {
  reasoning: string;
  content: string;
  rewrote: boolean;
  contentComplete: boolean;
  overflowed: boolean;
}

export function createChatReasoningState(): ChatReasoningState {
  return { reasoning: "", content: "", rewrote: false, contentComplete: true, overflowed: false };
}

function stringField(node: any, key: string): string {
  if (!node || typeof node !== "object") return "";
  const value = node[key];
  return typeof value === "string" ? value : "";
}

export function reasoningFromDetails(node: any): string {
  const details = node?.reasoning_details;
  if (!Array.isArray(details)) return "";
  let out = "";
  for (const block of details) {
    if (!block || typeof block !== "object") continue;
    const text = typeof block.text === "string" ? block.text : typeof block.thinking === "string" ? block.thinking : "";
    out += text;
  }
  return out;
}

export function reasoningTextFromNode(node: any): string {
  const standard = stringField(node, "reasoning_content");
  if (standard) return standard;
  for (const alias of REASONING_ALIASES) {
    const value = stringField(node, alias);
    if (value) return value;
  }
  return reasoningFromDetails(node);
}

export function hasAliasField(text: string): boolean {
  for (const needle of ALIAS_NEEDLES) if (text.indexOf(needle) >= 0) return true;
  return false;
}

export function mayNeedChatNormalisation(text: string): boolean {
  if (text.indexOf("<") >= 0) return true;
  return hasAliasField(text);
}

function addReasoning(state: ChatReasoningState, text: string): void {
  if (!text || state.overflowed) return;
  if (state.reasoning && text.length > state.reasoning.length && text.startsWith(state.reasoning)) {
    if (text.length > MAX_TRACKED_CHARS) {
      state.overflowed = true;
      return;
    }
    state.reasoning = text;
    return;
  }
  if (state.reasoning.length + text.length > MAX_TRACKED_CHARS) {
    state.overflowed = true;
    return;
  }
  state.reasoning += text;
}

function addContent(state: ChatReasoningState, text: string): void {
  if (!text || state.overflowed) return;
  if (state.content.length + text.length > MAX_TRACKED_CHARS) {
    state.overflowed = true;
    state.contentComplete = false;
    return;
  }
  state.content += text;
}

export function normalizeChatNode(
  node: any,
  splitter: ThinkingSplitter,
  state: ChatReasoningState
): boolean {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  let reasoning = stringField(node, "reasoning_content");
  const aliased = !reasoning;
  if (aliased) {
    for (const alias of REASONING_ALIASES) {
      const value = stringField(node, alias);
      if (!value) continue;
      reasoning = value;
      node.reasoning_content = value;
      delete node[alias];
      changed = true;
      break;
    }
  }
  if (!reasoning) {
    const fromDetails = reasoningFromDetails(node);
    if (fromDetails) {
      reasoning = fromDetails;
      node.reasoning_content = fromDetails;
      changed = true;
    }
  }
  if (changed) {
    addReasoning(state, reasoning);
    state.rewrote = true;
  }

  const content = node.content;
  if (typeof content === "string" && content) {
    const segments = splitter.push(content);
    const answer = joinSegments(segments, false);
    const thought = joinSegments(segments, true);
    addContent(state, answer);
    addReasoning(state, thought);
    if (answer !== content) {
      node.content = answer;
      changed = true;
      state.rewrote = true;
    }
    if (thought) {
      reasoning += thought;
      node.reasoning_content = reasoning;
      changed = true;
    }
    return changed;
  }

  if (Array.isArray(content)) {
    const kept: any[] = [];
    let thought = "";
    let dropped = false;
    let touched = false;
    for (const part of content) {
      if (!part || part.type !== "text" || typeof part.text !== "string" || !part.text) {
        kept.push(part);
        continue;
      }
      const segments = splitter.push(part.text);
      const answer = joinSegments(segments, false);
      const inner = joinSegments(segments, true);
      thought += inner;
      addContent(state, answer);
      addReasoning(state, inner);
      if (answer === part.text) {
        kept.push(part);
        continue;
      }
      touched = true;
      state.rewrote = true;
      if (answer) kept.push({ ...part, text: answer });
      else dropped = true;
    }
    if (touched) {
      node.content = dropped && !kept.length ? "" : kept;
      changed = true;
    }
    if (thought) {
      reasoning += thought;
      node.reasoning_content = reasoning;
      changed = true;
    }
  }
  return changed;
}

function framePayload(line: string): string | null {
  if (!line.startsWith(DATA_KEYWORD)) return null;
  return line.slice(DATA_KEYWORD.length).trim();
}

function rewriteLine(line: string, splitters: ChoiceSplitters, state: ChatReasoningState): string {
  const payload = framePayload(line);
  if (payload === null) return line;
  const trimmed = payload;
  if (!trimmed) return line;
  if (trimmed === "[DONE]") {
    return releaseHeld(splitters, state) + line;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return line;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.choices)) return line;
  let changed = false;
  for (const choice of parsed.choices) {
    if (!choice || typeof choice !== "object") continue;
    const splitter = splitters.get(typeof choice.index === "number" ? choice.index : 0);
    if (normalizeChatNode(choice.delta, splitter, state)) changed = true;
    if (normalizeChatNode(choice.message, splitter, state)) changed = true;
  }
  return changed ? DATA_PREFIX + JSON.stringify(parsed) : line;
}

function syntheticFrame(index: number, delta: any): string {
  return DATA_PREFIX + JSON.stringify({ choices: [{ index, delta }] }) + LF + LF;
}

class ChoiceSplitters {
  private readonly map = new Map<number, ThinkingSplitter>();

  get(index: number): ThinkingSplitter {
    let splitter = this.map.get(index);
    if (!splitter) {
      splitter = new ThinkingSplitter();
      this.map.set(index, splitter);
    }
    return splitter;
  }

  busy(): boolean {
    for (const splitter of this.map.values()) if (splitter.open || splitter.holding) return true;
    return false;
  }

  indexes(): number[] {
    return [...this.map.keys()].sort((a, b) => a - b);
  }
}

function releaseHeld(splitters: ChoiceSplitters, state: ChatReasoningState): string {
  let out = "";
  for (const index of splitters.indexes()) {
    const tail = splitters.get(index).flush();
    const answer = joinSegments(tail, false);
    const thought = joinSegments(tail, true);
    if (thought) {
      addReasoning(state, thought);
      out += syntheticFrame(index, { reasoning_content: thought });
    }
    if (answer) {
      addContent(state, answer);
      out += syntheticFrame(index, { content: answer });
    }
  }
  return out;
}

function terminateOpenEvent(out: string): string {
  if (!out) return "";
  if (out.endsWith(LF + LF)) return out;
  if (out.endsWith(LF)) return out + LF;
  return out + LF + LF;
}

export function chatReasoningTransform(state?: ChatReasoningState): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const splitters = new ChoiceSplitters();
  const counters = state ?? createChatReasoningState();
  let pending = "";
  let engaged = false;

  const needsWork = (text: string): boolean =>
    engaged || splitters.busy() || text.indexOf("<") >= 0 || hasAliasField(text);

  const rewriteBlock = (text: string): string => {
    if (!text) return "";
    if (!needsWork(text)) return text;
    engaged = true;
    const lines = text.split(LF);
    let out = "";
    for (let i = 0; i < lines.length; i++) {
      out += rewriteLine(lines[i], splitters, counters);
      if (i + 1 < lines.length) out += LF;
    }
    return out;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (!pending && text.charCodeAt(text.length - 1) === LF_CODE && !needsWork(text)) {
        counters.contentComplete = false;
        controller.enqueue(chunk);
        return;
      }
      const buffered = pending.length;
      pending += text;
      const newlineInChunk = text.lastIndexOf(LF);
      const cut = newlineInChunk < 0 ? -1 : buffered + newlineInChunk;
      if (cut < 0) {
        if (pending.length > MAX_PENDING_CHARS) {
          counters.contentComplete = false;
          controller.enqueue(encoder.encode(pending));
          pending = "";
        }
        return;
      }
      if (!needsWork(pending)) {
        counters.contentComplete = false;
        controller.enqueue(encoder.encode(pending.slice(0, cut + 1)));
        pending = pending.slice(cut + 1);
        return;
      }
      const block = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      controller.enqueue(encoder.encode(rewriteBlock(block)));
    },
    flush(controller) {
      pending += decoder.decode();
      const rewritten = rewriteBlock(pending);
      pending = "";
      const held = releaseHeld(splitters, counters);
      const out = held ? terminateOpenEvent(rewritten) + held : rewritten;
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}

export function splitFencesFromText(text: string): { content: string; reasoning: string } {
  if (!text || text.indexOf("<") < 0) return { content: text, reasoning: "" };
  const splitter = new ThinkingSplitter();
  const segments = splitter.push(text);
  const tail = splitter.flush();
  return {
    content: joinSegments(segments, false) + joinSegments(tail, false),
    reasoning: joinSegments(segments, true) + joinSegments(tail, true),
  };
}

export function stripFencesFromText(text: string): string {
  if (!text || text.indexOf("<") < 0) return text;
  return splitFencesFromText(text).content;
}

export function normalizeChatCompletion(json: any, state?: ChatReasoningState): boolean {
  const splitters = new ChoiceSplitters();
  const counters = state ?? createChatReasoningState();
  let changed = false;
  if (!json || typeof json !== "object" || !Array.isArray(json.choices)) return false;
  for (const choice of json.choices) {
    if (!choice || typeof choice !== "object") continue;
    const splitter = splitters.get(typeof choice.index === "number" ? choice.index : 0);
    if (normalizeChatNode(choice.message, splitter, counters)) changed = true;
    const tail = splitter.flush();
    const answer = joinSegments(tail, false);
    const thought = joinSegments(tail, true);
    if (!answer && !thought) continue;
    const message = choice.message;
    if (!message || typeof message !== "object") continue;
    if (answer) message.content = (typeof message.content === "string" ? message.content : "") + answer;
    if (thought) message.reasoning_content = stringField(message, "reasoning_content") + thought;
    changed = true;
  }
  return changed;
}
