import { describe, it, expect } from "vitest";
import { CallCompletionTracker } from "../src/gateway/call_completion";
const event = (obj: unknown) => "data: " + JSON.stringify(obj) + "\n\n";
describe("text call completion evidence", () => {
  it("preserves early errors even beyond the usage tail", () => {
    const t = new CallCompletionTracker("chat/completions");
    t.feed(event({error:{message:"failed"}}));
    for(let i=0;i<500;i++) t.feed(event({choices:[{delta:{content:"x".repeat(1000)}}]}));
    t.feed("data: [DONE]\n\n"); expect(t.billable).toBe(false);
  });
  it("does not treat quoted markers as control frames", () => {
    const t = new CallCompletionTracker("chat/completions");
    t.feed(event({choices:[{delta:{content:'data: [DONE] and "error": example'}}]}));
    expect(t.billable).toBe(false); t.feed("data: [DONE]\n\n"); expect(t.billable).toBe(true);
  });
  it.each(["messages", "chat/completions"] as const)("handles byte-sized CRLF chunks for %s", kind => {
    const t = new CallCompletionTracker(kind);
    const s=kind === "messages" ? event({type:"message_stop"}) : "data: [DONE]\n\n";
    for(const c of s.replace(/\n/g,"\r\n")) t.feed(c);
    expect(t.billable).toBe(true);
  });
  it("fails closed on oversized, malformed, and unterminated events", () => {
    for(const s of ["data: "+"x".repeat(1048577), "data: {bad}\n\ndata: [DONE]\n\n", "data: [DONE]\n"]) {
      const t=new CallCompletionTracker("chat/completions");t.feed(s);expect(t.billable).toBe(false);
    }
  });
});
