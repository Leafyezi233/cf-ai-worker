import { useRef, useState } from "react";
import {
  canCleanupUsageRetention, sameUsageRetentionBatch, usageRetentionApi, usageRetentionBatchFromText,
  USAGE_RETENTION_DEFAULT_LIMIT, USAGE_RETENTION_MAX_LIMIT,
  readPendingUsageRetentionCleanup, persistPendingUsageRetentionCleanup, clearPendingUsageRetentionCleanup,
  type UsageRetentionBatch, type UsageRetentionResponse,
} from "../api/usageRetention";
import { ApiError } from "../api/client";
import { Button, Card, Input } from "./ui";

type Operation = { kind: "backfill" } | { kind: "verify" } | { kind: "preview"; batch: UsageRetentionBatch } | { kind: "cleanup"; batch: UsageRetentionBatch; operationId?: string };

function restoreCleanup() {
  try { return { pending: readPendingUsageRetentionCleanup(), error: "" }; }
  catch (error) { return { pending: null, error: "无法读取清理恢复记录；禁止清理：" + (error instanceof Error ? error.message : String(error)) }; }
}
type Result = { label: string; item: Record<string, unknown> };

function JsonResult({ result }: { result: Result | null }) {
  if (!result) return null;
  return <div className="space-y-1"><p className="text-sm font-medium">{result.label}</p>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-950">{JSON.stringify(result.item, null, 2)}</pre></div>;
}

export default function UsageRetentionMaintenance() {
  const [restored] = useState(restoreCleanup);
  const [storageError, setStorageError] = useState(restored.error);
  const [enabled, setEnabled] = useState(false);
  const [cutoff, setCutoff] = useState(() => restored.pending ? new Date(restored.pending.batch.before).toISOString().replace(".000Z", "Z") : "");
  const [limit, setLimit] = useState(() => String(restored.pending?.batch.limit ?? USAGE_RETENTION_DEFAULT_LIMIT));
  const [after, setAfter] = useState(() => restored.pending?.batch.after ? `${restored.pending.batch.after.createdAt}:${restored.pending.batch.after.id}` : "");
  const [verified, setVerified] = useState(false);
  const [preview, setPreview] = useState<UsageRetentionBatch | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [unknown, setUnknown] = useState<Operation | null>(() => restored.pending ? { kind: "cleanup", ...restored.pending } : null);
  const [status, setStatus] = useState<Result | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState("");
  let batch: UsageRetentionBatch | null = null;
  let validation = "";
  try { batch = usageRetentionBatchFromText(cutoff, limit, after); }
  catch (error) { validation = error instanceof Error ? error.message : "参数无效"; }
  const unknownCleanup = unknown?.kind === "cleanup" ? unknown.batch : null;
  const allowCleanup = canCleanupUsageRetention({ enabled, verified, confirmed, busy, batch, preview, unknownCleanup })
    && !storageError && (unknown === null || unknown.kind === "cleanup");

  function invalidate() { setPreview(null); setConfirmed(false); setResult(null); }
  function changeField(set: (value: string) => void, value: string) {
    if (inFlight.current || unknown || storageError) return;
    invalidate(); set(value); setMessage("");
  }
  function changeEnabled(value: boolean) {
    if (inFlight.current) return;
    invalidate(); setEnabled(value); setMessage("");
  }

  async function refreshStatus() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); invalidate(); setMessage("");
    try {
      const response = await usageRetentionApi.status();
      setStatus({ label: "服务器状态（原始 JSON）", item: response.item });
      setMessage(unknown ? "状态已刷新，但不能据此断言上次请求完成。结果仍未知；保留原参数，按原请求手动重试。" : "状态已刷新；服务器最终决定是否允许清理。");
    } catch (error) { setMessage("状态刷新失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function run(operation: Operation) {
    if (inFlight.current || !enabled) return;
    const recoveringCleanup = unknown?.kind === "cleanup";
    if (unknown && operation.kind !== unknown.kind && !(recoveringCleanup && (operation.kind === "preview" || operation.kind === "verify"))) return;
    if (unknown && "batch" in unknown && "batch" in operation && !sameUsageRetentionBatch(unknown.batch, operation.batch)) return;
    if (operation.kind === "cleanup" && !allowCleanup) return;
    if (operation.kind === "preview" && !verified) return;
    if (operation.kind === "cleanup") {
      operation = { ...operation, operationId: unknown?.kind === "cleanup" ? unknown.operationId : crypto.randomUUID() };
      try {
        persistPendingUsageRetentionCleanup({ operationId: operation.operationId!, batch: operation.batch });
      } catch (error) {
        invalidate();
        setStorageError("无法保存清理恢复记录；未发送清理请求：" + (error instanceof Error ? error.message : String(error)));
        return;
      }
    }
    inFlight.current = true; setBusy(true); invalidate(); setMessage("");
    if (operation.kind === "backfill" || operation.kind === "verify") setVerified(false);
    try {
      let response: UsageRetentionResponse;
      if (operation.kind === "backfill") response = await usageRetentionApi.backfill();
      else if (operation.kind === "verify") response = await usageRetentionApi.verify();
      else if (operation.kind === "preview") response = await usageRetentionApi.preview(operation.batch);
      else response = await usageRetentionApi.cleanup(operation.batch, true, operation.operationId!);
      if (operation.kind === "verify") setVerified(response.item.ok === true && response.item.status === "verified");
      if (operation.kind === "preview") setPreview({ ...operation.batch });
      if (operation.kind === "cleanup") clearPendingUsageRetentionCleanup({ operationId: operation.operationId!, batch: operation.batch });
      if (!recoveringCleanup || operation.kind === "cleanup") setUnknown(null);
      const labels = { backfill: "本批回填响应", verify: "校验响应（须人工检查）", preview: "本批预览响应（须人工检查）", cleanup: "本批清理响应" };
      setResult({ label: labels[operation.kind] + "（原始 JSON）", item: response.item });
      setMessage(operation.kind === "cleanup" ? "已收到本批响应，不代表全部清理完成；不会自动推进游标或执行下一批。" : "已收到响应。请检查服务器结果；最终清理资格由服务器校验。");
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && unknown === null) {
        if (operation.kind === "cleanup") {
          try { clearPendingUsageRetentionCleanup({ operationId: operation.operationId!, batch: operation.batch }); }
          catch (storageFailure) {
            setUnknown(operation);
            setMessage("服务器已拒绝，但恢复记录未安全清除；保留同键恢复：" + (storageFailure instanceof Error ? storageFailure.message : String(storageFailure)));
            return;
          }
        }
        setMessage("服务器拒绝本次请求；未确认完成，清理仍锁定。请检查响应并重新校验、预览：" + error.message);
      } else {
        if (!recoveringCleanup) setUnknown(operation);
        setMessage("结果未知（可能丢失 ACK），不是已完成。请刷新状态，勿推进游标；仅可用相同截止时间、游标和批量手动重试。错误：" + (error instanceof Error ? error.message : String(error)));
      }
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <Card title="用量明细保留维护（仅管理员 / 手动）">
    <div className="space-y-5 text-slate-700 dark:text-slate-200">
      <div className="space-y-2 text-sm">
        <p>默认关闭。每次点击只处理一批；没有自动循环、定时任务或自动续跑。</p>
        <p className="font-medium">仅清理符合服务器条件的旧用量明细；保留汇总、钱包、月卡、审计及计费凭证（summaries / wallet / monthly / audit / billing proofs）。</p>
        <p>历史明细删除不可撤销。页面校验不替代服务器权限、汇总完整性和清理安全校验。</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => changeEnabled(event.target.checked)} />启用本次手动维护（不修改服务器开关）</label>
        <Button type="button" variant="secondary" disabled={busy} onClick={refreshStatus}>刷新状态</Button>
      </div>
      <JsonResult result={status} />
      <section className="space-y-2" aria-label="第一阶段：回填">
        <h3 className="font-medium">1. 回填汇总：一批 500 条</h3>
        <p className="text-sm">可按服务器响应人工重复回填，不会自动续跑。之后执行校验。</p>
        <Button type="button" disabled={!enabled || busy || unknown !== null} onClick={() => run({ kind: "backfill" })}>回填一批（500）</Button>
      </section>
      <section className="space-y-2" aria-label="第二阶段：校验">
        <h3 className="font-medium">2. 校验汇总与明细</h3>
        <p className="text-sm">须收到校验响应并人工检查；任何返回字段均原样展示，不据此猜测可删除范围。</p>
        <Button type="button" disabled={!enabled || busy || (unknown !== null && unknown.kind !== "cleanup")} onClick={() => run({ kind: "verify" })}>执行校验</Button>
      </section>
      <section className="space-y-3" aria-label="第三阶段：预览与单批清理">
        <h3 className="font-medium">3. 预览后确认清理一批</h3>
        <label className="block space-y-1 text-sm"><span>明确 UTC 整点截止时间（严格早于此时，不使用本地时区）</span>
          <Input type="text" value={cutoff} placeholder="YYYY-MM-DDTHH:00:00Z" disabled={busy || unknown !== null || !!storageError} onChange={event => changeField(setCutoff, event.target.value)} /></label>
        <label className="block space-y-1 text-sm"><span>单批数量（默认 100，最大 1000）</span>
          <Input type="number" min={1} max={USAGE_RETENTION_MAX_LIMIT} step={1} value={limit} disabled={busy || unknown !== null || !!storageError} onChange={event => changeField(setLimit, event.target.value)} /></label>
        <label className="block space-y-1 text-sm"><span>after 游标（createdAt:id，使用服务器 next；首批留空，不自动推进）</span>
          <Input type="text" inputMode="numeric" value={after} disabled={busy || unknown !== null || !!storageError} onChange={event => changeField(setAfter, event.target.value)} /></label>
        {validation && <p className="text-sm text-amber-700 dark:text-amber-400">{validation}</p>}
        {batch && <p className="break-all text-xs">本批参数：{JSON.stringify(batch)} / UTC {new Date(batch.before).toISOString()}</p>}
        <Button type="button" variant="secondary" disabled={!enabled || !verified || !batch || busy || (unknown !== null && unknown.kind !== "cleanup")} onClick={() => batch && run({ kind: "preview", batch: { ...batch } })}>预览此批（不删除）</Button>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={!enabled || !preview || busy} onChange={event => setConfirmed(event.target.checked)} />
          我已检查本批预览和校验结果，确认只删除上述 UTC 截止时间之前的本批明细，保留汇总与全部计费凭证。</label>
        <Button type="button" variant="danger" disabled={!allowCleanup} onClick={() => batch && run({ kind: "cleanup", batch: { ...batch } })}>{unknownCleanup ? "相同参数安全重试清理一批" : "确认清理一批"}</Button>
      </section>
      {unknown && <div role="alert" className="space-y-2 rounded-lg border border-amber-400 p-3 text-sm">
        <p className="font-medium">上次 {unknown.kind} 结果未知，不是已完成。参数已冻结，刷新不会自动重试。</p>
        <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(unknown, null, 2)}</pre>
        {unknown.kind === "cleanup" ? <p>先刷新状态并执行校验，须收到服务器 verified 校验成功，再以相同参数重新预览并勾选确认，然后用原操作标识安全重试同一批；不要推进游标。</p>
          : <Button type="button" variant="warning" disabled={!enabled || busy} onClick={() => run(unknown)}>相同参数手动重试上次请求</Button>}
      </div>}
      {storageError && <p role="alert" className="text-sm text-amber-700">{storageError}</p>}
      {message && <p role="status" aria-live="polite" className="text-sm">{message}</p>}
      <JsonResult result={result} />
    </div>
  </Card>;
}
