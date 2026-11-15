import { Button } from "./ui";
import { videoExpiryTime, type VideoReferenceUpload } from "../utils/videoReferences";

export interface VideoReferenceDraft { key: string; file: File; preview: string; uploaded?: VideoReferenceUpload }
export function VideoReferencePicker({ maxImages, items, locked = false, uploading = false, onSelect, onUpload, onRemove, onMove }: {
  maxImages: number; items: readonly VideoReferenceDraft[]; locked?: boolean; uploading?: boolean;
  onSelect: (files: File[]) => void; onUpload: () => void; onRemove: (key: string) => void; onMove: (index: number, delta: number) => void;
}) {
  if (!maxImages) return null;
  const disabled = locked || uploading;
  return <section aria-label="视频参考图" className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
    <p className="text-sm font-medium">参考图（可选，最多 {maxImages} 张）</p>
    <p className="text-xs text-slate-500">JPEG / PNG / WebP；每张最多 5 MiB，总计最多 15 MiB。按显示顺序提交；上传成功不会自动生成视频。刷新后仅恢复已提交的图片 ID，不保存文件或预览。</p>
    <input aria-label="选择视频参考图" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={disabled || items.length >= maxImages} onChange={event => { onSelect(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    <ol className="space-y-2">{items.map((item, index) => <li key={item.key} className="flex flex-wrap items-center gap-2 text-xs">
      <img src={item.preview} alt={"参考图 " + (index + 1) + "：" + item.file.name} className="h-20 w-24 rounded object-contain" />
      <span className="max-w-xs break-all">{index + 1}. {item.file.name} · {(item.file.size / 1024 / 1024).toFixed(2)} MiB<br />{item.uploaded ? videoExpiryTime(item.uploaded.expires_at) <= Date.now() ? "已过期：请删除后重新选择并上传" : "已上传 · " + item.uploaded.id : "尚未上传"}</span>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onRemove(item.key)}>删除参考图 {index + 1}</Button>
      <Button size="sm" variant="ghost" disabled={disabled || index === 0} onClick={() => onMove(index, -1)}>上移</Button>
      <Button size="sm" variant="ghost" disabled={disabled || index === items.length - 1} onClick={() => onMove(index, 1)}>下移</Button>
    </li>)}</ol>
    {items.some(item => !item.uploaded) ? <Button size="sm" variant="secondary" disabled={disabled} onClick={onUpload}>{uploading ? "正在上传…" : "上传参考图（不创建任务）"}</Button> : null}
  </section>;
}
