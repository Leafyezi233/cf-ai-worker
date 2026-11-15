import type { ModelWithProvider } from "../types";
import { planProtocolRoute } from "./protocol_capabilities";

export type ResponsesMode = "native" | "chat_adapter" | "disabled";

export function readResponsesMode(row: Pick<ModelWithProvider, "config_json">): ResponsesMode {
  try {
    const mode = JSON.parse(row.config_json || "{}").responses_mode;
    if (mode === undefined || mode === "chat_adapter") return "chat_adapter";
    return mode === "native" ? "native" : "disabled";
  } catch {
    return "chat_adapter";
  }
}

export function requiresNativeResponses(body: any): boolean {
  if (Array.isArray(body?.include) && body.include.includes("reasoning.encrypted_content")) return true;
  if (Array.isArray(body?.tools) && body.tools.some((t: any) => t?.type === "custom")) return true;
  if (!Array.isArray(body?.input)) return false;
  return body.input.some((item: any) => {
    if (!item || typeof item !== "object") return false;
    if (item.encrypted_content || item.type === "item_reference") return true;
    if (item.type === "custom_tool_call" || item.type === "custom_tool_call_output") return true;
    if (!Array.isArray(item.content)) return false;
    return item.content.some((part: any) =>
      part?.type === "input_file" || (part?.type === "input_image" && part.file_id)
    );
  });
}

export function canServeResponses(row: ModelWithProvider, nativeRequired: boolean): boolean {
  return planProtocolRoute(row, "responses", nativeRequired) !== null;
}

export function unsupportedNativeRequestFields(body: any): string[] {
  const fields: string[] = [];
  if (body.store !== undefined && body.store !== false) fields.push("store");
  if (body.background !== undefined && body.background !== false) fields.push("background");
  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool: any, i: number) => {
      if (!tool || !["function", "custom"].includes(tool.type)) fields.push(`tools[${i}]`);
    });
  }
  if (Array.isArray(body.input)) {
    body.input.forEach((item: any, i: number) => {
      if (item?.type === "item_reference") fields.push(`input[${i}]`);
      if (Array.isArray(item?.content)) item.content.forEach((part: any, j: number) => {
        if (part?.file_id) fields.push(`input[${i}].content[${j}].file_id`);
      });
    });
  }
  return fields;
}
