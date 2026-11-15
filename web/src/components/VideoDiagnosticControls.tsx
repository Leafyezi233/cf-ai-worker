import { useRef, useState } from "react";
import { controlVideoDiagnostics, type VideoDiagnosticOperation } from "../api/videoDiagnostics";
import { fmtTime } from "../api/client";
import { Button } from "./ui";

export function VideoDiagnosticControls({ deviceId, deviceName, onBusyChange }: { deviceId: string; deviceName: string; onBusyChange?: (busy: boolean) => void }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<VideoDiagnosticOperation | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function control(operation: VideoDiagnosticOperation) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(operation);
    onBusyChange?.(true);
    setMessage("");
    setError("");
    try {
      const result = await controlVideoDiagnostics(deviceId, operation);
      setMessage(operation === "arm"
        ? "启用成功：请在 " + fmtTime(result.enabled_until) + " 前提交下一笔新视频任务。这里只确认启用成功，不表示任务已被采样。"
        : "取消成功：尚未绑定任务的待采样已取消。已绑定任务的采样不会因此停止，已有样本也不会删除。");
    } catch (err) {
      setError((err instanceof Error ? err.message : "采样操作失败") + " 若遇到网络错误，操作是否生效可能无法确认，请先不要提交视频。");
    } finally {
      inFlight.current = false;
      setBusy(null);
      onBusyChange?.(false);
    }
  }
  return <div className="space-y-4 text-sm text-slate-600 dark:text-slate-300">
    <div><div className="font-medium text-slate-900 dark:text-slate-100">{deviceName}</div><div className="break-all font-mono text-xs">{deviceId}</div></div>
    <p>为此账户下一笔新视频任务采样，主 Token 和子 Token 共用一次名额。24 小时内有效；已有任务和幂等重试不会占用新名额。</p>
    <p>最多保存创建、处理中、结束和错误四份脱敏样本，每份不超过 64 KiB，保留 7 天。仅管理员可查看或导出。</p>
    <p>按钮不会生成视频或触发付费请求。请看到“启用成功”后再提交视频；重复启用会重新等待下一笔新任务。</p>
    <p className="text-xs">此处不查询当前采样状态。取消仅作用于尚未绑定任务的待采样，不会停止已绑定任务的采样，也不会删除样本。</p>
    {message ? <p role="status" className="text-emerald-700 dark:text-emerald-400">{message}</p> : null}
    {error ? <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={busy !== null} onClick={() => void control("arm")}>{busy === "arm" ? "正在启用…" : "采样下一笔视频"}</Button>
      <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void control("disarm")}>{busy === "disarm" ? "正在取消…" : "取消待采样"}</Button>
    </div>
  </div>;
}
