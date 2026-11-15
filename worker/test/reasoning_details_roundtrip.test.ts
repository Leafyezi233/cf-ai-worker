import { describe, expect, it } from "vitest";
import {
  convertResponsesRequest,
  convertChatToResponsesJson,
  createChatToResponsesTransform,
} from "../src/gateway/responses_adapter";
import { normalizeChatNode, createChatReasoningState } from "../src/gateway/thinking_sse";
import { ThinkingSplitter } from "../src/gateway/thinking";

const SIGNATURE = "sk-sig-9f8e7d6c5b4a-DO-NOT-MANGLE";
const DETAILS = [
  { type: "reasoning.text", text: "Step one, then step two.", signature: SIGNATURE, format: "openai" },
  { type: "reasoning.text", text: "Second block." },
];

function sseChunks(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
}

async function drainSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.pipeThrough(
    createChatToResponsesTransform("resp_details_test", "test-model")
  ).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

function dataEvents(sse: string): any[] {
  const events: any[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (!payload || payload === "[DONE]") continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

describe("reasoning_details /v1/responses round-trip", () => {
  it("relays an inbound reasoning item's details verbatim onto the assistant message", () => {
    const req = {
      model: "test-model",
      input: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "scratchpad" }],
          reasoning_details: DETAILS,
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
      stream: false,
    };
    const out = convertResponsesRequest(req);
    const assistant = out.messages.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("scratchpad");
    expect(assistant.reasoning_details).toEqual(DETAILS);
    expect(assistant.reasoning_details[0].signature).toBe(SIGNATURE);
  });

  it("attaches details even when a reasoning item carries no extractable text", () => {
    const req = {
      model: "test-model",
      input: [
        { type: "reasoning", reasoning_details: DETAILS },
        {
          type: "function_call",
          call_id: "call_2",
          name: "get_weather",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_2", output: "sunny" },
      ],
      stream: false,
    };
    const out = convertResponsesRequest(req);
    const assistant = out.messages.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_details).toEqual(DETAILS);
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it("forwards reasoning text and details on chat-shaped messages verbatim", () => {
    const req = {
      model: "test-model",
      messages: [
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "why",
          reasoning_details: DETAILS,
        },
      ],
      stream: false,
    };
    const out = convertResponsesRequest(req);
    expect(out.messages[0].reasoning_content).toBe("why");
    expect(out.messages[0].reasoning_details).toEqual(DETAILS);
  });

  it("merges streamed reasoning_details fragments (late signature) into the done item", async () => {
    const sse = await drainSSE(
      sseChunks([
        'data: {"id":"c1","choices":[{"delta":{"reasoning_details":[{"id":"rs_1","text":"Think "}]}}]}\n\n',
        'data: {"id":"c1","choices":[{"delta":{"reasoning_details":[{"id":"rs_1","text":"more."}]}}]}\n\n',
        'data: {"id":"c1","choices":[{"delta":{"reasoning_details":[{"id":"rs_1","signature":"' + SIGNATURE + '","format":"openai"}]}}]}\n\n',
        'data: {"id":"c1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    const events = dataEvents(sse);
    const doneItem = events.find((e) => e.type === "response.output_item.done" && e.item?.type === "reasoning");
    expect(doneItem).toBeTruthy();
    expect(doneItem.item.details).toEqual([
      { id: "rs_1", text: "Think more.", signature: SIGNATURE, format: "openai" },
    ]);
    const completed = events.find((e) => e.type === "response.completed");
    expect(completed.response.output[0].details).toEqual(doneItem.item.details);
    expect(completed.response.output[0].summary).toEqual([{ type: "summary_text", text: "Think more." }]);
    expect(events.filter((e) => e.type === "response.reasoning_text.delta").map((e) => e.delta)).toEqual([
      "Think ",
      "more.",
    ]);
  });

  it("still opens a reasoning item when only reasoning_details arrive (no text)", async () => {
    const sse = await drainSSE(
      sseChunks([
        'data: {"id":"c2","choices":[{"delta":{"reasoning_details":[{"id":"rs_2","thinking":"silent block","signature":"' + SIGNATURE + '"}]}}]}\n\n',
        'data: {"id":"c2","choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    const events = dataEvents(sse);
    const doneItem = events.find((e) => e.type === "response.output_item.done" && e.item?.type === "reasoning");
    expect(doneItem).toBeTruthy();
    expect(doneItem.item.details[0].text).toBe("silent block");
    expect(doneItem.item.details[0].signature).toBe(SIGNATURE);
  });

  it("synthesizes details on the non-stream reasoning item from the upstream message", () => {
    const out = convertChatToResponsesJson(
      { choices: [{ message: { content: "Hi", reasoning_content: "why", reasoning_details: DETAILS } }] },
      "resp_x"
    );
    const reasoningItem = out.output.find((o: any) => o.type === "reasoning");
    expect(reasoningItem.summary[0].text).toBe("why");
    expect(reasoningItem.details).toEqual(DETAILS);
  });

  it("adds no details field when the upstream sent none (old shape unchanged)", () => {
    const out = convertChatToResponsesJson(
      { choices: [{ message: { content: "Hi", reasoning_content: "why" } }] },
      "resp_y"
    );
    const reasoningItem = out.output.find((o: any) => o.type === "reasoning");
    expect("details" in reasoningItem).toBe(false);

    const req = convertResponsesRequest({
      model: "test-model",
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "scratchpad" }] },
        { type: "function_call", call_id: "call_3", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "call_3", output: "ok" },
      ],
      stream: false,
    });
    const assistant = req.messages.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("scratchpad");
    expect("reasoning_details" in assistant).toBe(false);
  });
});

describe("normalizeChatNode keeps reasoning_details on the wire", () => {
  it("preserves reasoning_details and folds reasoning_content alongside them", () => {
    const node: any = { content: "answer", reasoning_details: DETAILS };
    const changed = normalizeChatNode(node, new ThinkingSplitter(), createChatReasoningState());
    expect(node.reasoning_content).toBe("Step one, then step two.Second block.");
    expect(node.reasoning_details).toEqual(DETAILS);
    expect(changed).toBe(true);
  });

  it("still deletes string reasoning aliases that would leak to clients", () => {
    const node: any = { content: "answer", reasoning: "private" };
    normalizeChatNode(node, new ThinkingSplitter(), createChatReasoningState());
    expect(node.reasoning).toBeUndefined();
    expect(node.reasoning_content).toBe("private");
  });
});
