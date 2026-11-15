import type { ProtocolKind } from "./protocol_capabilities";

export function isOpaqueProtocolPart(item: any): boolean {
  return !!item && typeof item === "object" && (
    typeof item.encrypted_content === "string" && item.encrypted_content.length > 0 ||
    typeof item.signature === "string" && item.signature.length > 0 ||
    item.type === "reasoning.encrypted" || item.type === "redacted_thinking");
}
const reasoningPart = (item: any) => ["thinking", "redacted_thinking", "reasoning", "reasoning.encrypted"].includes(item?.type);

export function dropOpaqueProtocolState(body: any, kind: ProtocolKind): any {
  const key = kind === "responses" ? "input" : "messages";
  if (!Array.isArray(body?.[key])) return body;
  const items: any[] = [];
  for (const item of body[key]) {
    if (!item || typeof item !== "object") { items.push(item); continue; }
    if (reasoningPart(item)) continue;
    const copy = { ...item };
    delete copy.signature;
    delete copy.encrypted_content;
    let changed = isOpaqueProtocolPart(item);
    if (Array.isArray(item.reasoning_details)) {
      const details = item.reasoning_details.filter((part: any) => !isOpaqueProtocolPart(part));
      if (details.length !== item.reasoning_details.length) {
        changed = true;
        if (details.length) copy.reasoning_details = details;
        else delete copy.reasoning_details;
        delete copy.reasoning_content;
      }
    }
    if (Array.isArray(item.content)) {
      copy.content = item.content.filter((part: any) => !reasoningPart(part)).map((part: any) => {
        if (!isOpaqueProtocolPart(part)) return part;
        changed = true;
        const content = { ...part };
        delete content.signature;
        delete content.encrypted_content;
        return content;
      });
      changed ||= copy.content.length !== item.content.length;
    }
    const emptyContent = copy.content == null || copy.content === "" || Array.isArray(copy.content) && copy.content.length === 0;
    if (changed && emptyContent && !copy.tool_calls?.length && !copy.function_call && !copy.refusal && !copy.reasoning_details?.length
      && (!copy.type || copy.type === "message") && copy.role !== "tool" && copy.role !== "function") continue;
    items.push(copy);
  }
  const clean = { ...body, [key]: items };
  if (kind === "messages") {
    clean.thinking = { type: "disabled" };
    delete clean.reasoning_effort;
    if (clean.output_config && typeof clean.output_config === "object") {
      clean.output_config = { ...clean.output_config };
      delete clean.output_config.effort;
      if (!Object.keys(clean.output_config).length) delete clean.output_config;
    }
  }
  return clean;
}
