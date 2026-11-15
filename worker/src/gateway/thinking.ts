import { asciiLowerCode } from "./text_scan";

export const THINK_TAG_NAMES = ["thinking", "thought", "think"] as const;

export const THINK_OPEN_TAGS = THINK_TAG_NAMES.map((name) => "<" + name + ">");
export const THINK_CLOSE_TAGS = THINK_TAG_NAMES.map((name) => "</" + name + ">");
export const THINK_TAGS = [...THINK_OPEN_TAGS, ...THINK_CLOSE_TAGS];

const LT = 60;
const GT = 62;
const SLASH = 47;
const MAX_TAG_CHARS = 16;

export interface ThinkTagSpan {
  start: number;
  end: number;
  name: string;
  closing: boolean;
}

function isNameCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function matchName(text: string, from: number, to: number): string | null {
  const len = to - from;
  for (const name of THINK_TAG_NAMES) {
    if (name.length !== len) continue;
    let k = 0;
    while (k < len && asciiLowerCode(text.charCodeAt(from + k)) === name.charCodeAt(k)) k++;
    if (k === len) return name;
  }
  return null;
}

function nameIsPrefix(text: string, from: number, to: number): boolean {
  const len = to - from;
  for (const name of THINK_TAG_NAMES) {
    if (len > name.length) continue;
    let k = 0;
    while (k < len && asciiLowerCode(text.charCodeAt(from + k)) === name.charCodeAt(k)) k++;
    if (k === len) return true;
  }
  return false;
}

function readTag(text: string, at: number): ThinkTagSpan | null {
  let i = at + 1;
  let closing = false;
  if (i < text.length && text.charCodeAt(i) === SLASH) {
    closing = true;
    i++;
  }
  const nameStart = i;
  const limit = Math.min(text.length, at + MAX_TAG_CHARS);
  while (i < limit) {
    const code = text.charCodeAt(i);
    if (code === GT) break;
    if (!isNameCode(code)) return null;
    i++;
  }
  if (i >= limit || text.charCodeAt(i) !== GT) return null;
  const name = matchName(text, nameStart, i);
  if (!name) return null;
  return { start: at, end: i + 1, name, closing };
}

export function findThinkTag(text: string, from: number): ThinkTagSpan | null {
  const n = text.length;
  let i = from;
  while (i < n) {
    const at = text.indexOf("<", i);
    if (at < 0) return null;
    const span = readTag(text, at);
    if (span) return span;
    i = at + 1;
  }
  return null;
}

function couldGrow(text: string, at: number): boolean {
  let i = at + 1;
  if (i >= text.length) return true;
  if (text.charCodeAt(i) === SLASH) {
    i++;
    if (i >= text.length) return true;
  }
  const nameStart = i;
  const limit = Math.min(text.length, at + MAX_TAG_CHARS);
  while (i < limit) {
    const code = text.charCodeAt(i);
    if (code === GT) return false;
    if (!isNameCode(code)) return false;
    i++;
  }
  return nameIsPrefix(text, nameStart, i);
}

export function partialThinkTagLength(text: string): number {
  const limit = Math.min(text.length, MAX_TAG_CHARS);
  for (let len = limit; len >= 1; len--) {
    const start = text.length - len;
    if (text.charCodeAt(start) !== LT) continue;
    if (couldGrow(text, start)) return len;
  }
  return 0;
}

export interface ThinkingSegment {
  reasoning: boolean;
  text: string;
}

const NO_SEGMENTS: ThinkingSegment[] = [];

export class ThinkingSplitter {
  private depth = 0;
  private carry = "";

  get open(): boolean {
    return this.depth > 0;
  }

  get holding(): boolean {
    return this.carry.length > 0;
  }

  reset(): void {
    this.depth = 0;
    this.carry = "";
  }

  push(text: string): ThinkingSegment[] {
    const input = this.carry + text;
    this.carry = "";
    if (!input) return NO_SEGMENTS;
    const out: ThinkingSegment[] = [];
    const add = (reasoning: boolean, body: string): void => {
      if (!body) return;
      out.push({ reasoning, text: body });
    };
    let i = 0;
    while (i < input.length) {
      const tag = findThinkTag(input, i);
      if (!tag) {
        const rest = input.slice(i);
        const hold = partialThinkTagLength(rest);
        add(this.depth > 0, hold > 0 ? rest.slice(0, rest.length - hold) : rest);
        if (hold > 0) this.carry = rest.slice(rest.length - hold);
        break;
      }
      add(this.depth > 0, input.slice(i, tag.start));
      if (tag.closing) this.depth = this.depth > 0 ? this.depth - 1 : 0;
      else this.depth++;
      i = tag.end;
    }
    return out.length ? out : NO_SEGMENTS;
  }

  flush(): ThinkingSegment[] {
    const carried = this.carry;
    this.carry = "";
    if (!carried) return NO_SEGMENTS;
    return [{ reasoning: this.depth > 0, text: carried }];
  }
}

export function joinSegments(segments: ThinkingSegment[], reasoning: boolean): string {
  let out = "";
  for (const segment of segments) if (segment.reasoning === reasoning) out += segment.text;
  return out;
}
