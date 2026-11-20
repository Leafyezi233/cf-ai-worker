import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getConsoleToken, type ConsoleModels } from "../api/consoleClient";
import { videoApi, videoDefinitelyNotDispatched, videoErrorStatus, VideoApiError } from "../api/videoClient";
import { Button, Card, Empty, Input, Select, Textarea } from "./ui";
import { VideoReferencePicker, type VideoReferenceDraft } from "./VideoReferencePicker";
import { videoReferenceLimit, validateVideoReferenceFiles, videoExpiryTime, safeVideoContentTicketUrl, type VideoContentTicket } from "../utils/videoReferences";
import {
  VIDEO_POLL_INTERVAL_MS, VIDEO_STATUS_LABELS, canRetryVideoAttempt, canStartNewVideoAttempt,
  confirmVideoAttempt, createVideoAttempt, safeVideoResultUrl, validateVideoInput, videoNeedsPolling, saveVideoAttempt, loadVideoAttempt,
  prepareVideoAttemptForPost, canReleaseUnsentVideoAttempt, canReleaseRejectedVideoAttempt, mergeVideoTaskHistory, VIDEO_TASK_HISTORY_CAP, videoTaskPollDue, videoTaskReadDue,
  type VideoAttempt, type VideoPublicLimits, type VideoTaskView,
} from "../utils/videoTask";

function money(value: number): string { return `$${value.toFixed(4)}`; }
function time(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function VideoTicketMedia({ ticket, contentPath, mode, onError }: { ticket: VideoContentTicket; contentPath: string; mode: "play" | "download"; onError?: () => void }) {
  const validPath = safeVideoResultUrl(contentPath);
  const url = validPath && safeVideoContentTicketUrl(ticket.url, validPath);
  if (!url || !Number.isFinite(videoExpiryTime(ticket.expires_at)) || videoExpiryTime(ticket.expires_at) <= Date.now()) return null;
  return <>
    {mode === "play" ? <video className="w-full max-h-96 rounded" src={url} controls preload="none" onError={onError} /> : null}
    <a className="text-brand-600 underline" href={url} download target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">保存视频（短时链接）</a>
  </>;
}

export function VideoTaskCard({ task, onRefresh, refreshing = false }: { task: VideoTaskView; onRefresh?: () => void; refreshing?: boolean }) {
  const result = safeVideoResultUrl(task.result_url, task.id);
  const [ticket, setTicket] = useState<VideoContentTicket | null>(null);
  const [mediaError, setMediaError] = useState("");
  const [ticketLoading, setTicketLoading] = useState(false);
  const ticketRequest = useRef<AbortController | null>(null);
  const [mediaMode, setMediaMode] = useState<"play" | "download">("play");
  useEffect(() => {
    setTicket(null); setMediaError(""); setTicketLoading(false);
    return () => { ticketRequest.current?.abort(); ticketRequest.current = null; };
  }, [task.id, task.result_url, task.status]);
  useEffect(() => {
    if (!ticket) return;
    const timer = setTimeout(() => { setTicket(null); setMediaError("链接已过期，请重新获取（不会再次收费）。"); }, Math.min(2147483647, Math.max(0, videoExpiryTime(ticket.expires_at) - Date.now())));
    return () => clearTimeout(timer);
  }, [ticket]);
  async function openMedia(mode: "play" | "download") {
    if (!result || ticketRequest.current || task.status !== "succeeded") return;
    const controller = new AbortController();
    const credential = getConsoleToken();
    ticketRequest.current = controller; setTicketLoading(true); setMediaError(""); setTicket(null);
    try {
      const next = await videoApi.contentTicket(task.id, result, controller.signal);
      if (!controller.signal.aborted && credential === getConsoleToken()) { setMediaMode(mode); setTicket(next); }
    } catch (err) {
      if (!controller.signal.aborted) setMediaError((err instanceof Error ? err.message : "无法获取视频短时链接") + "；请手动重试播放/下载，不会重新生成视频。");
    } finally { if (ticketRequest.current === controller) ticketRequest.current = null; if (!controller.signal.aborted) setTicketLoading(false); }
  }
  return <article className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="break-all">{task.id}</strong>
      <span>{VIDEO_STATUS_LABELS[task.status]}</span>
      {onRefresh ? <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>刷新任务</Button> : null}
    </div>
    <div>{task.model} · {task.seconds} 秒 · {task.size}</div>
    <div>冻结单价 {money(task.price_per_call)}/成功任务次 · 已结算 {money(task.cost_usd)}</div>
    <div className="text-xs text-slate-500">创建：{time(task.created_at)} · 更新：{time(task.updated_at)}</div>
    {task.status === "submission_unknown" || task.requires_review ? <p className="text-amber-700 dark:text-amber-400">提交结果未知，请联系管理员核对，不要重复提交。</p> : null}
    {task.next_poll_at != null ? <p className="text-xs text-slate-500">下次可查询：{time(task.next_poll_at)}</p> : null}
    {task.error_code ? <p className="break-all text-rose-600">错误代码：{task.error_code}</p> : null}
    {task.status === "succeeded" && result ? <div className="space-y-2">
      <div className="flex gap-3">
        <Button size="sm" variant="secondary" disabled={ticketLoading} onClick={() => void openMedia("play")}>播放视频</Button>
        <Button size="sm" variant="secondary" disabled={ticketLoading} onClick={() => void openMedia("download")}>获取下载链接</Button>
      </div>
      {ticket ? <VideoTicketMedia ticket={ticket} contentPath={result} mode={mediaMode} onError={() => { setTicket(null); setMediaError("视频加载失败，请重新获取链接。"); }} /> : null}
      <p className="text-xs text-slate-500">重复播放或下载不会再次收费。</p>
    </div> : null}
    {mediaError ? <p role="alert" className="text-rose-600">{mediaError}</p> : null}
    {task.status === "succeeded" && task.result_url && !result ? <p>结果链接无效，请联系管理员。</p> : null}
  </article>;
}

export function ConsoleVideoCard({ models, token = "", active = false, limitsByModel = {} }: {
  models: ConsoleModels | null;
  token?: string;
  active?: boolean;
  limitsByModel?: Record<string, VideoPublicLimits>;
}) {
  const items = useMemo(() => (models?.items || []).filter((model) =>
    String(model.model_type) === "video" && !model.video?.resolutions?.length), [models]);
  const [modelName, setModelName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState("");
  const [size, setSize] = useState("");
  const [attempt, setAttempt] = useState<VideoAttempt | null>(null);
  const [ready, setReady] = useState(false);
  const [references, setReferences] = useState<VideoReferenceDraft[]>([]);
  const referencesRef = useRef<VideoReferenceDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);
  const referenceRequests = useRef(new Set<AbortController>());
  function updateReferences(next: VideoReferenceDraft[]) { referencesRef.current = next; setReferences(next); }
  function clearReferences() {
    for (const item of referencesRef.current) URL.revokeObjectURL(item.preview);
    updateReferences([]);
  }
  useEffect(() => () => {
    for (const controller of referenceRequests.current) controller.abort();
    for (const item of referencesRef.current) URL.revokeObjectURL(item.preview);
    referencesRef.current = [];
  }, []);
  useEffect(() => { clearReferences(); }, [token]);
  const mounted = useRef(true);
  const attemptRef = useRef<VideoAttempt | null>(null);
  const [tasks, setTasks] = useState<VideoTaskView[]>([]);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const pollInFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<ReadonlySet<string>>(new Set());
  const taskReads = useRef(new Set<string>());
  const taskReadAt = useRef(new Map<string, number>());
  const [error, setError] = useState("");
  const activeRef = useRef(active);
  activeRef.current = active;
  const createInFlight = useRef(false);
  const listInFlight = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const writes = useRef<Promise<void>>(Promise.resolve());
  const selected = items.find((item) => item.model_name === modelName) || items[0];
  const currentModel = attempt?.body.model || modelName || selected?.model_name || "";
  const limits = limitsByModel[currentModel] ?? items.find(item => item.model_name === currentModel)?.video;

  const maxReferenceImages = videoReferenceLimit(limits);
  function selectReferences(files: File[]) {
    if (attemptRef.current || createInFlight.current || uploadInFlight.current) return;
    const current = referencesRef.current;
    try {
      validateVideoReferenceFiles([...current.map(item => item.file), ...files], maxReferenceImages);
      const additions: VideoReferenceDraft[] = [];
      try { for (const file of files) additions.push({ key: crypto.randomUUID(), file, preview: URL.createObjectURL(file) }); }
      catch (err) { for (const item of additions) URL.revokeObjectURL(item.preview); throw err; }
      updateReferences([...current, ...additions]); setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "无法选择参考图"); }
  }
  function removeReference(key: string) {
    if (attemptRef.current || createInFlight.current || uploadInFlight.current) return;
    const current = referencesRef.current;
    const removed = current.find(item => item.key === key);
    if (removed) URL.revokeObjectURL(removed.preview);
    updateReferences(current.filter(item => item.key !== key));
  }
  function moveReference(index: number, delta: number) {
    if (attemptRef.current || createInFlight.current || uploadInFlight.current) return;
    const next = [...referencesRef.current];
    const target = index + delta;
    if (index < 0 || index >= next.length || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; updateReferences(next);
  }
  async function uploadReferences() {
    if (!activeRef.current || attemptRef.current || createInFlight.current || uploadInFlight.current || !ready || !token) return;
    uploadInFlight.current = true; setUploading(true); setError("");
    const controller = new AbortController(); referenceRequests.current.add(controller);
    try {
      validateVideoReferenceFiles(referencesRef.current.map(item => item.file), maxReferenceImages);
      for (const item of referencesRef.current) {
        if (item.uploaded) continue;
        const uploaded = await videoApi.uploadReference(item.file, controller.signal);
        if (controller.signal.aborted || !mounted.current || getConsoleToken() !== token) return;
        updateReferences(referencesRef.current.map(current => current.key === item.key ? { ...current, uploaded } : current));
      }
    } catch (err) {
      if (!controller.signal.aborted) setError((err instanceof Error ? err.message : "参考图上传失败") + "；上传失败时请联系管理员确认是否已开启参考图存储。");
    } finally { referenceRequests.current.delete(controller); uploadInFlight.current = false; if (mounted.current) setUploading(false); }
  }

  const remember = useCallback((next: VideoAttempt | null) => {
    attemptRef.current = next; setAttempt(next);
  }, []);
  const persist = useCallback((next: VideoAttempt | null): Promise<void> => {
    const write = writes.current.catch(() => {}).then(() => saveVideoAttempt(token, next,sessionStorage));
    writes.current = write;
    return write;
  }, [token]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (token) void loadVideoAttempt(token,sessionStorage).then(saved => {
      if (cancelled) return;
      remember(saved);
      setReady(true);
    }).catch(() => { if (!cancelled) setError("无法读取本页视频提交记录，请核对任务列表后联系管理员；已暂停新提交。"); });
    return () => { cancelled = true; mounted.current = false; for (const controller of requests.current) controller.abort(); };
  }, [token, remember]);
  const acceptTask = useCallback(async (task: VideoTaskView) => {
    setTasks((prev) => mergeVideoTaskHistory(prev, [task], attemptRef.current?.taskId));
    const current = attemptRef.current;
    if (current?.taskId === task.id) {
      const confirmed = confirmVideoAttempt(current, task);
      remember(confirmed);
      await persist(confirmed);
    }
  }, [remember, persist]);

  const refreshList = useCallback(async () => {
    if (!activeRef.current || listInFlight.current) return;
    listInFlight.current = true;
    setLoading(true);
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const next = await videoApi.list(controller.signal);
      if (controller.signal.aborted || !activeRef.current) return;
      setTasks((prev) => mergeVideoTaskHistory(prev, next, attemptRef.current?.taskId));
      const current = attemptRef.current;
      const task = next.find((item) => item.id === current?.taskId);
      if (current && task) {
        const confirmed = confirmVideoAttempt(current, task);
        remember(confirmed);
        await persist(confirmed);
      }
      setError("");
    } catch (err) {
      if (!controller.signal.aborted && activeRef.current) setError(err instanceof Error ? err.message : "读取视频任务失败");
    } finally {
      requests.current.delete(controller);
      listInFlight.current = false;
      setLoading(false);
    }
  }, [remember, persist]);
  useEffect(() => {
    if (active) void refreshList();
    return () => { for (const controller of requests.current) controller.abort(); };
  }, [active, refreshList]);

  const refreshTask = useCallback(async (id: string) => {
    if (!activeRef.current || taskReads.current.has(id)) return;
    const known = tasksRef.current.find(task => task.id === id);
    if ((known && !videoTaskReadDue(known)) || Date.now() < (taskReadAt.current.get(id) ?? 0)) return;
    taskReads.current.add(id);
    taskReadAt.current.set(id, Date.now() + VIDEO_POLL_INTERVAL_MS);
    if (taskReadAt.current.size > VIDEO_TASK_HISTORY_CAP) {
      const oldest = taskReadAt.current.keys().next().value;
      if (oldest !== undefined) taskReadAt.current.delete(oldest);
    }
    setRefreshingIds(new Set(taskReads.current));
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const task = await videoApi.get(id, controller.signal);
      if (!controller.signal.aborted && activeRef.current) { await acceptTask(task); setError(""); }
    } catch (err) {
      if (videoErrorStatus(err) === 429) taskReadAt.current.set(id, err instanceof VideoApiError && err.retryAt ? err.retryAt : Date.now() + 60_000);
      if (!controller.signal.aborted && activeRef.current) setError(err instanceof Error ? err.message : "刷新视频任务失败");
    } finally {
      requests.current.delete(controller);
      taskReads.current.delete(id);
      setRefreshingIds(new Set(taskReads.current));
    }
  }, [acceptTask]);
  const pollTasks = useCallback(async () => {
    if (!activeRef.current || pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const due = tasksRef.current.filter((task) => videoTaskPollDue(task));
      for (let offset=0;offset<due.length;offset+=4) await Promise.all(due.slice(offset,offset+4).map(({ id }) => refreshTask(id)));
    } finally { pollInFlight.current = false; }
  }, [refreshTask]);
  const polling = tasks.some((task) => videoNeedsPolling(task.status) && !task.requires_review);
  useEffect(() => {
    if (!active || !polling) return;
    const timer = setInterval(() => { void pollTasks(); }, VIDEO_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, polling, pollTasks]);

  async function submit() {
    if (!activeRef.current || createInFlight.current) return;
    if (uploadInFlight.current) return;
    if (!ready || !token) return;
    let current = attemptRef.current;
    if (current && !canRetryVideoAttempt(current)) return;
    try {
      if (!current) {
        const refs = referencesRef.current;
        if (refs.length) {
          validateVideoReferenceFiles(refs.map(item => item.file), maxReferenceImages);
          if (refs.some(item => !item.uploaded || videoExpiryTime(item.uploaded.expires_at) <= Date.now())) throw new Error("参考图尚未上传或已过期，请先上传；不会自动创建任务");
        }
        const input = { model: currentModel, prompt, seconds: Number(seconds), size: size.trim(), ...(refs.length ? { reference_image_ids: refs.map(item => item.uploaded!.id) } : {}) };
        validateVideoInput(input, limits);
        current = createVideoAttempt(input);
        remember(current);
      }
    } catch (err) { setError(err instanceof Error ? err.message : "无效视频参数"); return; }
    createInFlight.current = true;
    setSending(true);
    setError("");
    const controller = new AbortController();
    requests.current.add(controller);
    const before = current;
    let postStarted = false;
    try {
      current = await prepareVideoAttemptForPost(current, persist);
      remember(current);
      if (!mounted.current || controller.signal.aborted || getConsoleToken() !== token) return;
      postStarted = true;
      const task = await videoApi.create(current, controller.signal);
      remember(confirmVideoAttempt(current, task));
      await acceptTask(task);
    } catch (err) {
      if (!postStarted && canReleaseUnsentVideoAttempt(before)) {
        remember(null);
        setError("提交前无法保存状态，本次尚未发送；可编辑后重新创建。旧记录若仍存在，请核对后处理。");
      } else if (postStarted && videoDefinitelyNotDispatched(err) && canReleaseRejectedVideoAttempt(before, true)) {
        try {
          await persist(null);
          remember(null);
          setError((err instanceof Error ? err.message : "请求被拒绝") + "；服务端明确未派发，可编辑后重新创建。");
        } catch { setError("服务端明确未派发，但无法清除提交记录；请保留原 key，恢复存储后再重试。"); }
      } else {
        setError((err instanceof Error ? err.message : "提交尚未确认") + "。已保留原参数和幂等 key；仅手动原样重试或联系管理员核对，不要创建新任务。");
      }
    } finally { requests.current.delete(controller); createInFlight.current = false; setSending(false); }
  }

  async function startNew() {
    const current = attemptRef.current;
    if (!current || !canStartNewVideoAttempt(current) || createInFlight.current) return;
    createInFlight.current = true;
    try {
      await persist(null);
      if (mounted.current) { remember(null); clearReferences(); setError(""); }
    } catch { setError("无法清除提交记录；暂不能创建新任务。"); }
    finally { createInFlight.current = false; }
  }

  return <div hidden={!active} className="space-y-4">
    <Card title="视频生成">
      <div className="space-y-3">
        <p className="text-xs text-slate-500">只有成功的任务计费，按提交时的价格结算。</p>
        {!items.length ? <Empty text="当前没有可用的视频模型；仍可刷新已有任务" /> : <>
          <Select aria-label="视频模型" value={currentModel} disabled={!!attempt || sending || uploading} onChange={(event) => { if (attemptRef.current || createInFlight.current || uploadInFlight.current) return; clearReferences(); setModelName(event.target.value); setSize(""); setSeconds(""); }}>
            {items.map((model) => <option key={model.id} value={model.model_name}>{model.display_name || model.model_name}</option>)}
          </Select>
          {limits ? <p className="text-xs text-slate-500">管理员允许：{limits.sizes.join("、")}；{limits.seconds_min ?? 3}–{limits.seconds_max ?? 15} 秒。</p> :
            <p className="text-xs text-amber-700 dark:text-amber-400">该模型未声明可用规格，请填写管理员允许的时长和分辨率。</p>}
          <div className="grid sm:grid-cols-2 gap-2">
            <Input aria-label="视频时长（秒）" type="number" min={limits?.seconds_min ?? 3} max={limits?.seconds_max ?? 15} step="1" placeholder="时长（3–15 秒）" disabled={!!attempt || sending || uploading} value={attempt ? attempt.body.seconds : seconds} onChange={(event) => setSeconds(event.target.value)} />
            {limits ? <Select aria-label="视频分辨率" disabled={!!attempt || sending || uploading} value={attempt?.body.size ?? size} onChange={(event) => setSize(event.target.value)}>
              <option value="">请选择管理员允许的分辨率</option>
              {limits.sizes.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select> : <Input aria-label="视频分辨率" placeholder="宽x高，例如 1280x720" disabled={!!attempt || sending || uploading} value={attempt?.body.size ?? size} onChange={(event) => setSize(event.target.value)} />}
          </div>
          <Textarea aria-label="视频提示词" maxLength={8000} rows={3} placeholder="描述要生成的视频" disabled={!!attempt || sending || uploading} value={attempt?.body.prompt ?? prompt} onChange={(event) => setPrompt(event.target.value)} />
          <VideoReferencePicker maxImages={maxReferenceImages} items={references} locked={!!attempt || sending} uploading={uploading} onSelect={selectReferences} onUpload={() => void uploadReferences()} onRemove={removeReference} onMove={moveReference} />
          {attempt?.body.reference_image_ids ? <p className="text-xs break-all text-slate-500">本次锁定的参考图 ID（按顺序）：{attempt.body.reference_image_ids.join("、")}。刷新页面后不保留文件预览。</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!active || !ready || sending || uploading || (!!attempt && !canRetryVideoAttempt(attempt))} onClick={() => void submit()}>
              {sending ? "正在提交…" : attempt && canRetryVideoAttempt(attempt) ? "使用原 key 和原参数重试未确认提交" : "创建视频任务"}
            </Button>
            {attempt && canStartNewVideoAttempt(attempt) ? <Button variant="secondary" onClick={() => void startNew()}>开始另一个新任务</Button> : null}
          </div>
        </>}
        {attempt ? <p className="text-xs break-all text-slate-500">本次幂等 Key：{attempt.key}。{attempt.taskId ? "任务已确认，仅可查询状态；未完成前不重新创建。" : "提交尚未确认，参数已锁定；同一次重试沿用此 key，不可更换参数或 key。"}</p> : null}
        <p className="text-xs text-slate-500">未确认的提交记录保存在当前标签页，刷新后可恢复。</p>
        {error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : null}
      </div>
    </Card>
    <Card title="视频任务" action={<Button size="sm" variant="ghost" disabled={!active || loading} onClick={() => void refreshList()}>{loading ? "刷新中…" : "刷新任务列表"}</Button>}>
      <p className="mb-3 text-xs text-slate-500">进行中的任务会自动刷新状态。最多显示 {VIDEO_TASK_HISTORY_CAP} 条，更早的记录请联系管理员。</p>
      {attempt?.taskId && !tasks.some(task => task.id === attempt.taskId) ? <Button variant="ghost" disabled={refreshingIds.has(attempt.taskId)} onClick={() => void refreshTask(attempt.taskId!)}>查询已确认任务</Button> : null}
      <div className="space-y-3">{tasks.length ? tasks.map((task) => <VideoTaskCard key={task.id} task={task} refreshing={refreshingIds.has(task.id)} onRefresh={() => void refreshTask(task.id)} />) : <Empty text="暂无视频任务" />}</div>
    </Card>
  </div>;
}
