export class CallCompletionTracker {
  private line = "";
  private data: string[] = [];
  private size = 0;
  private invalid = false;
  private complete = false;
  private failed = false;
  constructor(private readonly kind: "messages" | "chat/completions") {}
  feed(text: string): void {
    if (this.invalid) return;
    for (let start = 0; start < text.length;) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? text.length : end);
      this.size += part.length + (end < 0 ? 0 : 1);
      if (this.size > 1024 * 1024) { this.invalid = true; this.data = []; this.line = ""; return; }
      this.line += part;
      if (end < 0) return;
      const line = this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line;
      this.line = "";
      if (!line) { this.event(); this.size = 0; }
      else if (line.startsWith("data:")) this.data.push(line.slice(5).trimStart());
      start = end + 1;
    }
  }
  private event(): void {
    const data = this.data.join("\n"); this.data = [];
    if (!data) return;
    if (data === "[DONE]") { if (this.kind === "chat/completions") this.complete = true; return; }
    try {
      const obj = JSON.parse(data);
      if (obj?.error || obj?.type === "error") this.failed = true;
      if (this.kind === "messages" && obj?.type === "message_stop") this.complete = true;
    } catch { this.failed = true; }
  }
  get billable(): boolean { return this.complete && !this.failed && !this.invalid; }
}
