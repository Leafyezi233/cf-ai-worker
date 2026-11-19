import { useMemo, useState } from "react";
import { Input } from "./ui";
export const SETTINGS_SECTIONS = [
  ["announcement", "控制台公告"], ["access", "IP 白名单 访问控制"], ["keys", "API Key 轮转 密钥"],
  ["audit", "审计日志"], ["tasks", "视频任务"], ["openapi", "OpenAPI 规范文档"],
  ["snapshots", "配置快照 回滚"], ["budget", "月度预算"], ["webhook", "Webhook 告警"],
  ["retention", "用量保留 维护"], ["cache", "响应缓存"], ["sdk", "SDK 客户端接入"],
] as const;
export function SettingsLocator() {
  const [keyword, setKeyword] = useState("");
  const matches = useMemo(() => SETTINGS_SECTIONS.filter(([, label]) => label.toLowerCase().includes(keyword.trim().toLowerCase())), [keyword]);
  return <nav aria-label="设置项定位" className="space-y-2">
    <Input aria-label="搜索设置分区" placeholder="搜索设置分区，仅定位，不隐藏或重置草稿" value={keyword} onChange={e => setKeyword(e.target.value)} />
    <div className="flex flex-wrap gap-2">{matches.map(([id, label]) => <a key={id} className="text-xs text-blue-600 underline" href={"#settings-" + id}>{label}</a>)}</div>
    {!matches.length ? <p className="text-xs text-slate-500">没有匹配的设置分区；表单仍完整保留。</p> : null}
  </nav>;
}
