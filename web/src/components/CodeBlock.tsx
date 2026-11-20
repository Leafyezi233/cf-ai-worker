import type { ReactNode } from "react";
import { CopyButton } from "./ui";

export type CodeLang = "bash" | "powershell" | "python" | "js" | "json" | "toml" | "text";

type Rule = [kind: string, pattern: string];

const STRING = '"(?:\\\\.|[^"\\\\\\n])*"|\'[^\'\\n]*\'';
const NUMBER = "\\b\\d+(?:\\.\\d+)?\\b";

const RULES: Record<CodeLang, Rule[]> = {
  bash: [
    ["comment", "(?<![^\\s])#[^\\n]*"],
    ["string", STRING],
    ["variable", "\\$[A-Za-z_][A-Za-z0-9_]*"],
    ["keyword", "\\b(?:curl|export|pip|npm|npx|install|claude|codex|set)\\b"],
    ["flag", "(?<![\\w/-])--?[A-Za-z][\\w-]*"],
  ],
  powershell: [
    ["comment", "(?<![^\\s])#[^\\n]*"],
    ["string", STRING],
    ["variable", "\\$env:[A-Za-z_][A-Za-z0-9_]*|\\$[A-Za-z_][A-Za-z0-9_]*"],
    ["keyword", "\\b(?:setx)\\b"],
  ],
  python: [
    ["comment", "#[^\\n]*"],
    ["string", STRING],
    ["keyword", "\\b(?:import|from|as|print|def|return|await|async|for|in|if|else|with|None|True|False)\\b"],
    ["number", NUMBER],
  ],
  js: [
    ["comment", "//[^\\n]*"],
    ["string", STRING + "|`[^`]*`"],
    ["keyword", "\\b(?:import|from|const|let|await|new|async|function|return|export|default)\\b"],
    ["number", NUMBER],
  ],
  json: [
    ["key", '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'],
    ["string", STRING],
    ["keyword", "\\b(?:true|false|null)\\b"],
    ["number", "-?" + NUMBER],
  ],
  toml: [
    ["comment", "#[^\\n]*"],
    ["section", "^\\[[^\\]\\n]+\\]"],
    ["key", "^[A-Za-z0-9_.-]+(?=\\s*=)"],
    ["string", STRING],
    ["keyword", "\\b(?:true|false)\\b"],
    ["number", NUMBER],
  ],
  text: [],
};

const TOKEN_CLASS: Record<string, string> = {
  comment: "text-slate-500 italic",
  string: "text-emerald-300",
  variable: "text-amber-300",
  keyword: "text-sky-300",
  flag: "text-sky-300",
  number: "text-orange-300",
  key: "text-brand-300",
  section: "text-brand-300 font-semibold",
};

const COMPILED = new Map<CodeLang, RegExp | null>();

function compiled(lang: CodeLang): RegExp | null {
  if (!COMPILED.has(lang)) {
    const rules = RULES[lang];
    COMPILED.set(lang, rules.length ? new RegExp(rules.map(([, pattern]) => "(" + pattern + ")").join("|"), "gm") : null);
  }
  return COMPILED.get(lang) ?? null;
}

/** Splits code into coloured spans. The concatenated text is always exactly the input. */
export function highlight(code: string, lang: CodeLang): ReactNode[] {
  const re = compiled(lang);
  if (!re) return [code];
  const rules = RULES[lang];
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let match = re.exec(code); match; match = re.exec(code)) {
    if (match[0] === "") { re.lastIndex++; continue; }
    if (match.index > last) out.push(code.slice(last, match.index));
    const group = match.slice(1).findIndex((value) => value !== undefined);
    out.push(<span key={match.index} className={TOKEN_CLASS[rules[group][0]]}>{match[0]}</span>);
    last = match.index + match[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/**
 * Dark code panel used across the console docs: a title bar with an optional tab strip and copy
 * button, then the highlighted code. It is dark in both themes, like most API documentation.
 */
export function CodeBlock({ code, lang = "text", title, tabs, copyLabel = "复制" }: {
  code: string;
  lang?: CodeLang;
  title?: ReactNode;
  /** Optional tab strip rendered in the title bar (e.g. curl / Python / Node.js). */
  tabs?: ReactNode;
  copyLabel?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0b1020] shadow-card dark:shadow-none">
      <div className="flex min-h-[2.5rem] items-center justify-between gap-2 border-b border-white/[0.06] bg-white/[0.02] px-2">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {tabs ?? (title ? <span className="px-2 text-[11px] font-medium text-slate-400">{title}</span> : null)}
        </div>
        <CopyButton text={code} label={copyLabel} className="shrink-0 rounded-md px-2 py-1 text-slate-400 hover:bg-white/10 hover:text-white" />
      </div>
      <pre className="overflow-x-auto whitespace-pre p-4 font-mono text-[12.5px] leading-relaxed text-slate-200">
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}

/** A tab button styled for the dark code panel title bar. */
export function CodeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick}
      className={"whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 " + (active
        ? "bg-white/10 text-white"
        : "text-slate-400 hover:bg-white/5 hover:text-slate-200")}>
      {children}
    </button>
  );
}
