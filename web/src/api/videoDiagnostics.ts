import { api } from "./client";

export type VideoDiagnosticOperation = "arm" | "disarm";
export interface VideoDiagnosticControlResult {
  ok: true;
  device_id: string;
  armed: boolean;
  enabled_until: number | null;
  retention_days: number;
}

export async function controlVideoDiagnostics(deviceId: string, operation: VideoDiagnosticOperation): Promise<VideoDiagnosticControlResult> {
  const result = await api.post<VideoDiagnosticControlResult>("/api/video-tasks/diagnostics/" + operation, { device_id: deviceId });
  if (!result || result.ok !== true || result.device_id !== deviceId || result.armed !== (operation === "arm") ||
    (operation === "arm" ? !Number.isFinite(result.enabled_until) || Number(result.enabled_until) <= 0 : result.enabled_until !== null)) {
    throw new Error("采样操作响应无法确认，请勿据此提交视频。");
  }
  return result;
}
