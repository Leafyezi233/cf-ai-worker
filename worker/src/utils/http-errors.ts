import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export const handleHttpError: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error("Worker unhandled error:", err);
  return c.json({ error: "internal_server_error" }, 500);
};
