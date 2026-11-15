export const OUTPUT_TOKEN_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;

export type OutputTokenField = (typeof OUTPUT_TOKEN_FIELDS)[number];

export function outputTokenLimit(body: any): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  for (const field of OUTPUT_TOKEN_FIELDS) {
    const raw = body[field];
    if (typeof raw === "boolean" || raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export function outputTokenField(body: any): OutputTokenField | undefined {
  if (!body || typeof body !== "object") return undefined;
  return OUTPUT_TOKEN_FIELDS.find((field) => body[field] !== undefined && body[field] !== null);
}

export function setOutputTokenLimit(
  body: Record<string, any>,
  value: number,
  prefer: OutputTokenField = "max_tokens"
): OutputTokenField {
  const field = outputTokenField(body) ?? prefer;
  for (const other of OUTPUT_TOKEN_FIELDS) delete body[other];
  body[field] = value;
  return field;
}
