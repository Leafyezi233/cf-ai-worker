import { describe, expect, it } from "vitest";
import { modelMaskingTransform } from "../src/gateway/caller_identity";
import {
  cleanReasoningAndContent,
  createChatToResponsesTransform,
  detectRepetitionLoop,
  extractDsmlToolCalls,
} from "../src/gateway/responses_adapter";
import { chatReasoningTransform, createChatReasoningState } from "../src/gateway/thinking_sse";

const CEILING_MS = 400;

async function runStream(chunks: string[]): Promise<string> {
  const transform = createChatToResponsesTransform("resp_cost", "deepseek-v3");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  const reader = stream.pipeThrough(transform).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("DSML scanning stays linear", () => {
  it("rejects a wall of unclosed tool_calls open tags without rescanning", () => {
    const text = "<|DSML|tool_calls>".repeat(40000);
    const started = Date.now();
    const result = extractDsmlToolCalls(text);
    const elapsed = Date.now() - started;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("rejects the spaced-out variant of the same wall", () => {
    const text = "< | DSML | tool_calls >".repeat(20000);
    const started = Date.now();
    const result = extractDsmlToolCalls(text);
    const elapsed = Date.now() - started;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("terminates on a stream whose tool_calls block never closes", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"< | DSML | tool_calls>\\n< | DSML | invoke name=\\"exec_command\\">"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await runStream(chunks);
    expect(out).toContain("response.completed");
    expect(out).not.toContain("< | DSML | tool_calls>");
  });
});

describe("cleanReasoningAndContent stays linear", () => {
  it("handles thousands of unclosed think tags", () => {
    const text = "<think>".repeat(20000);
    const started = Date.now();
    const result = cleanReasoningAndContent(text, "");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(CEILING_MS);
    expect(result.reasoning).toBe("");
    expect(result.content).toBe("");
  });

  it("takes the earliest open tag that actually has a close of the same kind", () => {
    const result = cleanReasoningAndContent("a<think>b<thought>why</thought>c", "");
    expect(result.reasoning).toBe("why");
    expect(result.content).toBe("abc");
  });

  it("matches think tags case-insensitively", () => {
    const result = cleanReasoningAndContent("<THINK>because</Thought>answer", "");
    expect(result.reasoning).toBe("because");
    expect(result.content).toBe("answer");
  });

  it("treats everything before a lone close tag as reasoning", () => {
    const result = cleanReasoningAndContent("reasoning only</think>answer", "");
    expect(result.reasoning).toBe("reasoning only");
    expect(result.content).toBe("answer");
  });

  it("leaves an explicitly supplied reasoning untouched by the tag scan", () => {
    const result = cleanReasoningAndContent("<think>x</think>body", "explicit");
    expect(result.reasoning).toBe("explicit");
    expect(result.content).toBe("xbody");
  });
});

describe("streaming accumulation stays linear", () => {
  it("survives one token per chunk", async () => {
    const chunks: string[] = [];
    for (let i = 0; i < 12000; i++) {
      chunks.push('data: {"choices":[{"delta":{"content":"这是第' + i + '个token的内容"}}]}\n\n');
    }
    chunks.push("data: [DONE]\n\n");
    const started = Date.now();
    const out = await runStream(chunks);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(CEILING_MS * 2);
    expect(out).toContain("response.completed");
    expect(out).toContain("这是第11999个token的内容");
  });
});

describe("the repetition guard does not degrade on low-variety output", () => {
  it("rejects a single-character tail without walking every candidate length", () => {
    const started = Date.now();
    for (let i = 0; i < 5000; i++) {
      expect(detectRepetitionLoop("a".repeat(2048)).isLoop).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(CEILING_MS);
  });

  it("still detects a real loop in normal text", () => {
    const result = detectRepetitionLoop("hello there, this is a sentence. ".repeat(20));
    expect(result.isLoop).toBe(true);
  });

  it("still ignores separator lines", () => {
    expect(detectRepetitionLoop("-".repeat(120)).isLoop).toBe(false);
  });

  it("keeps a low-variety stream linear end to end", async () => {
    const chunks: string[] = [];
    for (let i = 0; i < 16000; i++) {
      chunks.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    }
    chunks.push("data: [DONE]\n\n");
    const started = Date.now();
    const out = await runStream(chunks);
    expect(Date.now() - started).toBeLessThan(CEILING_MS * 2);
    expect(out).toContain("response.completed");
  });
});

describe("an open DSML block is drained linearly", () => {
  it("handles a block body that contains no '<' at all", async () => {
    const body = "x".repeat(128 * 1024);
    const chunks: string[] = ['data: {"choices":[{"delta":{"content":"< | DSML | tool_calls>"}}]}\n\n'];
    for (let i = 0; i < body.length; i += 8) {
      chunks.push('data: {"choices":[{"delta":{"content":"' + body.slice(i, i + 8) + '"}}]}\n\n');
    }
    chunks.push("data: [DONE]\n\n");
    const started = Date.now();
    const out = await runStream(chunks);
    expect(Date.now() - started).toBeLessThan(CEILING_MS * 2);
    expect(out).toContain("response.completed");
  });

  it("still parses a block that closes after a long body", async () => {
    const body = "y".repeat(40 * 1024);
    const chunks: string[] = [
      'data: {"choices":[{"delta":{"content":"< | DSML | tool_calls>\\n< | DSML | invoke name=\\"run\\">\\n< | DSML | parameter name=\\"cmd\\" string=\\"true\\">' +
        body +
        '</ | DSML | parameter>\\n</ | DSML | invoke>\\n</ | DSML | tool_calls>"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await runStream(chunks);
    expect(out).toContain('"type":"function_call"');
    expect(out).toContain('"name":"run"');
  });
});

describe("a completed DSML block is drained as soon as it closes", () => {
  it("emits the function call before later content, not at flush time", async () => {
    const block =
      "< | DSML | tool_calls>\n< | DSML | invoke name=\"run\">\n< | DSML | parameter name=\"cmd\" string=\"true\">ls</ | DSML | parameter>\n</ | DSML | invoke>\n</ | DSML | tool_calls>";
    const chunks = [
      'data: {"choices":[{"delta":{"content":' + JSON.stringify(block) + "}}]}\n\n",
      'data: {"choices":[{"delta":{"content":"after the call"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await runStream(chunks);
    const callAt = out.indexOf('"type":"function_call"');
    const afterAt = out.indexOf("after the call");
    expect(callAt).toBeGreaterThan(-1);
    expect(afterAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(afterAt);
  });
});

describe("the streaming drain agrees with the one-shot parser", () => {
  const pieces = [
    "< | DSML | tool_calls>",
    "</ | DSML | tool_calls>",
    "< | DSML | invoke name=\"run\">",
    "</ | DSML | invoke>",
    "< | DSML | parameter name=\"cmd\" string=\"true\">",
    "</ | DSML | parameter>",
    "<", "/", "|", ">", " ", "\n", "x", "ls", "< |", "DSML", "</ | DSML",
  ];

  function randomMarkup(rnd: () => number): string {
    const n = 1 + Math.floor(rnd() * 12);
    let out = "";
    for (let i = 0; i < n; i++) out += pieces[Math.floor(rnd() * pieces.length)];
    return out;
  }

  function callsFromStream(out: string): { name: string; arguments: string }[] {
    const calls: { name: string; arguments: string }[] = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      let evt: any;
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (evt?.type === "response.output_item.done" && evt.item?.type === "function_call") {
        calls.push({ name: evt.item.name, arguments: evt.item.arguments });
      }
    }
    return calls;
  }

  it("matches extractDsmlToolCalls over 400 random inputs", async () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let mismatches = 0;
    for (let iter = 0; iter < 400; iter++) {
      const text = randomMarkup(rnd);
      const expected = extractDsmlToolCalls(text);
      const expectedCalls = (expected?.toolCalls ?? []).map((c) => ({
        name: c.name,
        arguments: JSON.stringify(c.arguments),
      }));

      const chunks: string[] = [];
      let i = 0;
      while (i < text.length) {
        const size = 1 + Math.floor(rnd() * 5);
        chunks.push('data: {"choices":[{"delta":{"content":' + JSON.stringify(text.slice(i, i + size)) + "}}]}\n\n");
        i += size;
      }
      chunks.push("data: [DONE]\n\n");
      const out = await runStream(chunks);
      const got = callsFromStream(out).map((c) => ({ name: c.name, arguments: c.arguments }));
      const want = expectedCalls.map((c) => ({ name: c.name, arguments: c.arguments }));
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        mismatches++;
        if (mismatches <= 3) console.log("MISMATCH", JSON.stringify({ text, want, got }));
      }
    }
    expect(mismatches).toBe(0);
  });
});

describe("the chat thinking stage costs nothing on a stream without tags", () => {
  const LF = String.fromCharCode(10);
  const words = "the quick brown fox jumps over a lazy dog and then keeps running through the field".split(" ");
  const frames: string[] = [];
  for (let i = 0; i < 16000; i++) {
    const text = (i ? " " : "") + words[i % words.length];
    frames.push(
      "data: " + JSON.stringify({ model: "gw-primary", choices: [{ index: 0, delta: { content: text } }] }) + LF + LF
    );
  }

  async function timeThrough(withStage: boolean): Promise<number> {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    let stream: ReadableStream<Uint8Array> = body;
    if (withStage) stream = stream.pipeThrough(chatReasoningTransform());
    stream = stream.pipeThrough(modelMaskingTransform("gw-primary"));
    const started = Date.now();
    const out = await new Response(stream).text();
    expect(out.length).toBeGreaterThan(0);
    return Date.now() - started;
  }

  it("adds no more than a small fraction of the masking stage it sits next to", async () => {
    await timeThrough(true);
    const without: number[] = [];
    const withStage: number[] = [];
    for (let round = 0; round < 5; round++) {
      without.push(await timeThrough(false));
      withStage.push(await timeThrough(true));
    }
    without.sort((a, b) => a - b);
    withStage.sort((a, b) => a - b);
    const baseline = Math.max(without[2], 1);
    expect(withStage[2]).toBeLessThan(baseline * 3 + CEILING_MS / 4);
  });
});

describe("the chat thinking stage stays linear on hostile stream shapes", () => {
  const LF = String.fromCharCode(10);

  async function runStage(chunks: string[], state = createChatReasoningState()) {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    const out = await new Response(body.pipeThrough(chatReasoningTransform(state))).text();
    return { out, state };
  }

  it("does not rescan the whole buffer for a stream that never sends a newline", async () => {
    const chunk = "a".repeat(4096);
    const chunks: string[] = [];
    for (let i = 0; i < 1024; i++) chunks.push(chunk);
    const started = Date.now();
    const { out } = await runStage(chunks);
    expect(Date.now() - started).toBeLessThan(CEILING_MS * 2);
    expect(out.length).toBe(4 * 1024 * 1024);
  });

  it("does not double count a provider that resends the whole reasoning each frame", async () => {
    const chunks: string[] = [];
    let acc = "";
    for (let i = 0; i < 200; i++) {
      acc += "why";
      chunks.push(
        "data: " + JSON.stringify({ choices: [{ index: 0, delta: { reasoning: acc } }] }) + LF + LF
      );
    }
    chunks.push("data: [DONE]" + LF + LF);
    const started = Date.now();
    const { state } = await runStage(chunks);
    expect(Date.now() - started).toBeLessThan(CEILING_MS);
    expect(state.reasoning).toBe(acc);
    expect(state.reasoning.length).toBe(600);
  });

  it("stops accumulating instead of growing past the cache ceiling", async () => {
    const chunks: string[] = [
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "<think>plan</think>" } }] }) + LF + LF,
    ];
    for (let i = 0; i < 400; i++) {
      chunks.push(
        "data: " +
          JSON.stringify({ choices: [{ index: 0, delta: { content: "x".repeat(4096) } }] }) +
          LF +
          LF
      );
    }
    chunks.push("data: [DONE]" + LF + LF);
    const { state } = await runStage(chunks);
    expect(state.overflowed).toBe(true);
    expect(state.contentComplete).toBe(false);
    expect(state.content.length).toBeLessThan(600 * 1024);
  });
});

describe("DSML attribute parsing tolerates real-world shapes", () => {
  const wrap = (inner: string) =>
    "< | DSML | tool_calls>\n" + inner + "\n</ | DSML | tool_calls>";

  it("accepts a parameter with no space before its string attribute", () => {
    const text = wrap(
      '< | DSML | invoke name="run">\n< | DSML | parameter name="cmd"string="true">ls</ | DSML | parameter>\n</ | DSML | invoke>'
    );
    const result = extractDsmlToolCalls(text);
    expect(result?.toolCalls[0].name).toBe("run");
    expect(result?.toolCalls[0].arguments).toEqual({ cmd: "ls" });
  });

  it("skips an unknown attribute instead of folding it into the name", () => {
    const text = wrap(
      '< | DSML | invoke name="run">\n< | DSML | parameter name="cmd" foo="x" string="true">ls</ | DSML | parameter>\n</ | DSML | invoke>'
    );
    const result = extractDsmlToolCalls(text);
    expect(result?.toolCalls[0].arguments).toEqual({ cmd: "ls" });
  });

  it("keeps JSON parsing for parameters without string=true", () => {
    const text = wrap(
      '< | DSML | invoke name="run">\n< | DSML | parameter name="list">["a","b"]</ | DSML | parameter>\n</ | DSML | invoke>'
    );
    const result = extractDsmlToolCalls(text);
    expect(result?.toolCalls[0].arguments).toEqual({ list: ["a", "b"] });
  });
});
