import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { ensureSchema } from "./schema";

export const VIDEO_REFERENCE_R2_LIMITS = Object.freeze({ put: 10_000, get: 100_000 });
export type VideoReferenceR2Operation = keyof typeof VIDEO_REFERENCE_R2_LIMITS;
const periodAt = (now: number) => new Date(now).toISOString().slice(0,7);

export async function withVideoReferenceR2Budget<T>(env: Env, kind: VideoReferenceR2Operation, dispatch: () => Promise<T>): Promise<T> {
  try {
    await ensureSchema(env);
    const period = periodAt(Date.now());
    const column = kind === "put" ? "put_attempts" : "get_attempts";
    const result = await env.DB.prepare(
      "INSERT INTO video_reference_r2_budget(period," + column + ") VALUES (?,1) " +
      "ON CONFLICT(period) DO UPDATE SET " + column + " = " + column + " + 1 WHERE " + column + " < ?"
    ).bind(period,VIDEO_REFERENCE_R2_LIMITS[kind]).run();
    if (result.success !== true || result.meta?.changes !== 1) throw new Error("quota_or_ambiguous_write");
    if (periodAt(Date.now()) !== period) throw new Error("month_changed");
  } catch {
    throw new HTTPException(503,{message:"reference_r2_budget_unavailable"});
  }
  return dispatch();
}
