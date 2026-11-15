import type { Env } from "../types";
import { ensureSchema } from "../db/schema";
import { isEncryptedSecret, openSecret, sealSecret } from "../utils/crypto";

export interface VideoTicketPayload {
  kind: "video" | "reference";
  id: string;
  device_id: string;
  sub_token_id: string | null;
  expires_at: number;
}
const PURPOSE = "cpg-content-ticket-v1";
const LIMITS = { video: 5 * 60_000, reference: 7 * 24 * 60 * 60_000 };
const safeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(v);
function validPayload(p: VideoTicketPayload): boolean {
  return (p.kind === "video" || p.kind === "reference") && safeId(p.id) && safeId(p.device_id)
    && (p.sub_token_id === null || safeId(p.sub_token_id)) && Number.isSafeInteger(p.expires_at);
}

export async function signVideoTicket(env: Env, payload: {kind:'video'|'reference';id:string;device_id:string;sub_token_id:string|null;expires_at:number}): Promise<string> {
  const now = Date.now();
  if (!env.ENCRYPTION_KEY?.trim() || !validPayload(payload) || payload.expires_at <= now
    || payload.expires_at - now > LIMITS[payload.kind]) throw new Error("content_ticket_unavailable");
  return sealSecret(JSON.stringify({ purpose: PURPOSE, issued_at: now, kind: payload.kind, id: payload.id,
    device_id: payload.device_id, sub_token_id: payload.sub_token_id, expires_at: payload.expires_at }), env.ENCRYPTION_KEY);
}

export async function verifyVideoTicket(env: Env, ticket: string, kind: 'video'|'reference', id: string): Promise<VideoTicketPayload | null> {
  try {
    if (!env.ENCRYPTION_KEY?.trim() || typeof ticket !== "string" || ticket.length > 2048 || !isEncryptedSecret(ticket)) return null;
    const plain = await openSecret(ticket, env.ENCRYPTION_KEY);
    if (!plain) return null;
    const p = JSON.parse(plain);
    const now = Date.now();
    if (!p || typeof p !== "object" || !validPayload(p) || p.purpose !== PURPOSE || p.kind !== kind || p.id !== id
      || !Number.isSafeInteger(p.issued_at) || p.issued_at > now || p.expires_at <= now
      || p.expires_at <= p.issued_at || p.expires_at - p.issued_at > LIMITS[kind]) return null;
    await ensureSchema(env);
    const owner = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND enabled = 1 AND revoked_at IS NULL")
      .bind(p.device_id).first();
    if (!owner) return null;
    if (p.sub_token_id !== null && !await env.DB.prepare("SELECT id FROM device_sub_tokens WHERE id = ? AND device_id = ? AND enabled = 1 AND revoked_at IS NULL")
      .bind(p.sub_token_id, p.device_id).first()) return null;
    return {kind:p.kind,id:p.id,device_id:p.device_id,sub_token_id:p.sub_token_id,expires_at:p.expires_at};
  } catch { return null; }
}
