import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertResponsesRequest } from "../src/gateway/responses_adapter";
import { clearMemoryCacheForTest } from "../src/gateway/cache";
import { resetRateLimitMemory } from "../src/gateway/ratelimit";
import {
  CollectingExecutionContext,
  createRealD1,
  makeEnv,
  openAiAnswer,
  postJson,
  seedDevice,
  seedModel,
  seedProvider,
} from "./helpers/realGatewayEnv";


let realFetch: typeof globalThis.fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetRateLimitMemory();
  clearMemoryCacheForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const thinking = { type: "reasoning", content: [{ type: "reasoning_text", text: "the user wants the file list, call ls" }] };
const assistantTurn = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const userTurn = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

describe("thinking that comes back in the input is not turned into something the caller said", () => {
  it("attaches a reasoning item to the assistant turn it belongs to", () => {
    const out = convertResponsesRequest({
      model: "gw-primary",
      input: [userTurn("list the files"), thinking, assistantTurn("running ls")],
    });

    const said = out.messages.filter((m: any) => m.role === "user");
    expect(said).toHaveLength(1);
    expect(JSON.stringify(said[0])).toContain("list the files");
    const assisted = out.messages.filter((m: any) => m.role === "assistant");
    expect(assisted).toHaveLength(1);
    expect(assisted[0].reasoning_content).toContain("call ls");
    const userSaid = out.messages.filter((m: any) => m.role === "user").map((m: any) => JSON.stringify(m.content)).join(" ");
    expect(userSaid).not.toContain("call ls");
  });

  it("keeps the reasoning of a tool call with the tool call", () => {
    const out = convertResponsesRequest({
      model: "gw-primary",
      input: [
        userTurn("list the files"),
        thinking,
        { type: "function_call", call_id: "call_1", name: "ls", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      ],
    });

    const [assistant] = out.messages.filter((m: any) => m.role === "assistant");
    expect(assistant.tool_calls[0].function.name).toBe("ls");
    expect(assistant.reasoning_content).toContain("call ls");
    expect(out.messages.some((m: any) => m.role === "user" && JSON.stringify(m).includes("call ls"))).toBe(false);
  });

  it("does not invent an empty assistant turn for a reasoning item with no text", () => {
    const out = convertResponsesRequest({
      model: "gw-primary",
      input: [userTurn("hi"), { type: "reasoning", encrypted_content: "gAAAAAB" }, assistantTurn("hello")],
    });

    expect(out.messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    expect(out.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
  });

  it("sends the thinking to the upstream as reasoning, not as the caller speaking", async () => {
    const d1 = createRealD1();
    seedProvider(d1);
    seedModel(d1);
    await seedDevice(d1, { balance_usd: 1 });
    const env = makeEnv(d1);
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_input: any, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return openAiAnswer();
    }) as unknown as typeof globalThis.fetch;

    const exec = new CollectingExecutionContext();
    const res = await postJson(
      env,
      "/responses",
      { model: "gw-primary", input: [userTurn("list the files"), thinking, assistantTurn("running ls")] },
      exec
    );
    await res.text();
    await Promise.all(exec.pending);

    expect(res.status).toBe(200);
    const userText = bodies[0].messages
      .filter((m: any) => m.role === "user")
      .map((m: any) => JSON.stringify(m.content))
      .join(" ");
    expect(userText).toContain("list the files");
    expect(userText).not.toContain("call ls");
    d1.close();
  });
});
