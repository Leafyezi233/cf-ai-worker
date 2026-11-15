export const VIDEO_REFERENCE_MAX_FILES = 3;
export const VIDEO_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
export const VIDEO_REFERENCE_TOTAL_BYTES = 15 * 1024 * 1024;
export const VIDEO_REFERENCE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export interface VideoReferenceUpload { id: string; content_type: string; size_bytes: number; expires_at: string | number }
export interface VideoContentTicket { url: string; expires_at: string | number }
export function videoExpiryTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  return typeof value === "string" && value.length > 0 ? Date.parse(value) : NaN;
}
export function videoReferenceLimit(limits: { reference_images?: { max_images: number } } | undefined): number {
  const max = limits?.reference_images?.max_images;
  return typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 3 ? max : 0;
}
export function validateVideoReferenceFiles(files: readonly Pick<File, "type" | "size">[], maxImages: number): void {
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 3 || files.length > maxImages) throw new Error("参考图数量超出管理员限制（最多 3 张）");
  if (files.some(file => !VIDEO_REFERENCE_TYPES.includes(file.type as typeof VIDEO_REFERENCE_TYPES[number]))) throw new Error("参考图仅支持 JPEG、PNG、WebP");
  if (files.some(file => !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > VIDEO_REFERENCE_MAX_BYTES)) throw new Error("每张参考图须大于 0 且不超过 5 MiB");
  if (files.reduce((sum, file) => sum + file.size, 0) > VIDEO_REFERENCE_TOTAL_BYTES) throw new Error("参考图总大小不能超过 15 MiB");
}
export function parseVideoReferenceUpload(value: unknown, file: Pick<File, "type" | "size">, now = Date.now()): VideoReferenceUpload {
  const item = value as Partial<VideoReferenceUpload> | null;
  if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || item.content_type !== file.type || item.size_bytes !== file.size || !Number.isFinite(videoExpiryTime(item.expires_at)) || videoExpiryTime(item.expires_at) <= now) throw new Error("参考图上传响应无效或已过期；不会自动创建视频任务");
  return { id: item.id, content_type: item.content_type, size_bytes: item.size_bytes, expires_at: item.expires_at! };
}
export function safeVideoContentTicketUrl(raw: unknown, contentPath: string): string | null {
  if (!/^\/v1\/video\/generations\/[A-Za-z0-9_-]{1,128}\/content$/.test(contentPath) || typeof raw !== "string" || raw.length > 8192 || !raw.startsWith(contentPath + "?ticket=")) return null;
  const ticket = raw.slice(contentPath.length + 8);
  try {
    const decoded = decodeURIComponent(ticket);
    return /^enc:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded) && encodeURIComponent(decoded) === ticket ? raw : null;
  } catch { return null; }
}
export function parseVideoContentTicket(value: unknown, contentPath: string, now = Date.now()): VideoContentTicket {
  const item = value as Partial<VideoContentTicket> | null;
  const url = safeVideoContentTicketUrl(item?.url, contentPath);
  if (!url || !Number.isFinite(videoExpiryTime(item?.expires_at)) || videoExpiryTime(item?.expires_at) <= now) throw new Error("视频短时链接无效或已过期；请手动重新获取，不会重新生成视频");
  return { url, expires_at: item!.expires_at! };
}
