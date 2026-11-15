export function unsupportedResponsesBridgeFields(body: any): string[] {
  const fields: string[] = [];
  const supported = new Set(["model", "input", "messages", "instructions", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "max_output_tokens", "max_tokens", "max_completion_tokens", "reasoning", "text", "response_format", "stream", "store", "background", "metadata", "user", "presence_penalty", "frequency_penalty", "stop", "seed"]);
  for (const key of Object.keys(body || {})) if (!supported.has(key) && body[key] !== undefined) fields.push(key);
  if (body?.reasoning && typeof body.reasoning === "object") for (const key of Object.keys(body.reasoning)) if (key !== "effort") fields.push("reasoning." + key);
  if (body?.text && typeof body.text === "object") for (const key of Object.keys(body.text)) if (key !== "format") fields.push("text." + key);
  if (Array.isArray(body?.input)) body.input.forEach((item: any, i: number) => {
    if (!item || typeof item !== "object") return;
    const known = ["message", "reasoning", "function_call", "function_call_output"];
    if (item.type && !known.includes(item.type)) fields.push("input[" + i + "].type");
    if (item.encrypted_content) fields.push("input[" + i + "].encrypted_content");
    if (Array.isArray(item.content)) item.content.forEach((p: any, j: number) => {
      if (p && !["input_text", "output_text", "text", "input_image", "image_url"].includes(p.type)) fields.push("input[" + i + "].content[" + j + "]");
    });
  });
  return [...new Set(fields)];
}
