import type { ReactNode } from "react";
import { Button, Input, Select } from "./ui";

export interface AdminListToolbarProps {
  filters: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onReset: () => void;
  total: number;
  count: number;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  children?: ReactNode;
  searchPlaceholder?: string;
}

export function AdminListToolbar({ filters, onChange, onReset, total, count, loading, error, onRefresh, children, searchPlaceholder = "搜索名称…" }: AdminListToolbarProps) {
  return <div className="space-y-2" aria-label="列表筛选">
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="关键词" className="sm:!w-64" placeholder={searchPlaceholder} value={filters.q || ""} onChange={e => onChange("q", e.target.value)} />
      <Select aria-label="启用状态" className="!w-auto" value={filters.enabled || ""} onChange={e => onChange("enabled", e.target.value)}>
        <option value="">全部状态</option><option value="1">启用</option><option value="0">停用</option>
      </Select>
      {children}
      <Select aria-label="名称排序" className="!w-auto" value={filters.sort || ""} onChange={e => onChange("sort", e.target.value)}>
        <option value="">默认排序</option><option value="name">名称升序</option><option value="name-desc">名称降序</option>
      </Select>
      <Button type="button" size="sm" variant="ghost" onClick={onReset}>清空筛选</Button>
      {onRefresh ? <Button type="button" size="sm" variant="outline" disabled={loading} onClick={onRefresh}>{loading ? "刷新中…" : "刷新"}</Button> : null}
      <span role="status" className="text-xs text-slate-500">显示 {count} / {total} 项{loading ? " · 加载中…" : ""}</span>
    </div>
    {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
  </div>;
}
