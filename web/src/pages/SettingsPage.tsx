import { useCallback, useState, useEffect, useRef, type SetStateAction } from "react";
import { api, fmtTime } from "../api/client";
import type {
  BudgetConfigResponse,
  WebhookConfigResponse,
  IpWhitelistConfig,
  KeyRotationReport,
  ConfigSnapshotItem,
  AuditLogItem,
  AnnouncementConfig,
} from "../types";
import { Badge, Card, Empty, Spinner, CopyButton, Button, Input, Select, Textarea } from "../components/ui";
import {
  IconTerminal,
  IconShield,
  IconZap,
  IconTrash,
  IconDownload,
  IconRefresh,
  IconKey,
  IconFileText,
  IconCamera,
  IconHistory,
  IconAlertTriangle,
} from "../components/icons";
import { recordQuery, recordTimeDefaults, useAdminRecordPage } from "../components/AdminVideoTasks";
import { useAdminFilters } from "../hooks/useAdminFilters";
import { SETTINGS_TABS, settingsTabFor, readTabParam, writeTabParam, type SettingsTabId } from "../components/SettingsLocator";
import UsageRetentionMaintenance from "../components/UsageRetentionMaintenance";
import { useToast } from "../components/Toast";
import { useQuery } from "../hooks/useQuery";

interface SettingsData {
  app_name: string;
  gateway_base_url: string;
  provider_count: number;
  cf_access_configured?: boolean;
  kv_cache_configured?: boolean;
  rate_limiter_configured?: boolean;
  encryption_configured?: boolean;
  providers: Array<{
    id: string;
    name: string;
    type: string;
    enabled: boolean | number;
    api_key_configured?: boolean;
    secret_configured: boolean;
  }>;
}

function useSettingsDraft<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const draft = useRef({ dirty: false, editVersion: 0 });
  const edit = useCallback((next: SetStateAction<T>) => {
    draft.current.dirty = true;
    draft.current.editVersion++;
    setValue(next);
  }, []);
  const hydrate = useCallback((next: SetStateAction<T>) => {
    if (!draft.current.dirty) setValue(next);
  }, []);
  return [value, edit, hydrate, draft] as const;
}

export default function SettingsPage({ view = "settings" }: { view?: "settings" | "audit" } = {}) {
  const toast = useToast();

  const fetchSettings = useCallback(async () => {
    return await api.get<SettingsData>("/api/settings");
  }, []);
  const { data, loading, error } = useQuery("settings-data", fetchSettings);

  const [activeSnippetTab, setActiveSnippetTab] = useState<"openai" | "anthropic" | "gemini" | "curl">("openai");
  const [purging, setPurging] = useState(false);

  const [budgetForm, setBudgetForm, hydrateBudget, budgetDraft] = useSettingsDraft({
    monthly_budget_usd: 0,
    budget_action: "warn" as "warn" | "block",
    alert_threshold_pct: 80,
    spent_this_month_usd: 0,
  });
  const [savingBudget, setSavingBudget] = useState(false);

  const [announcementForm, setAnnouncementForm, hydrateAnnouncement, announcementDraft] = useSettingsDraft<AnnouncementConfig>({
    enabled: false,
    level: "info",
    title: "",
    message: "",
    updated_at: null,
  });
  const [savingAnnouncement, setSavingAnnouncement] = useState(false);

  const [webhookForm, setWebhookForm, hydrateWebhook, webhookDraft] = useSettingsDraft({
    url: "",
    secret: "",
    events: ["budget_exceeded", "provider_error"],
  });
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);

  const [ipForm, setIpForm, hydrateIp, ipDraft] = useSettingsDraft<IpWhitelistConfig>({
    enabled: false,
    allowed_ips: [],
    client_ip: "",
  });
  const [newIpInput, setNewIpInput] = useState("");
  const [savingIp, setSavingIp] = useState(false);

  const [keyRotationData, setKeyRotationData] = useState<KeyRotationReport | null>(null);
  const [loadingKeyRotation, setLoadingKeyRotation] = useState(false);
  const [rotatingProviderId, setRotatingProviderId] = useState<string | null>(null);
  const [newKeyInput, setNewKeyInput] = useState("");

  const [auditDefaults] = useState(() => ({ audit_action: "", audit_actor_type: "", audit_ip: "", audit_target_type: "", audit_target_id: "", ...recordTimeDefaults("audit_") }));
  const [auditFilters, setAuditFilter, resetAuditFilters] = useAdminFilters(auditDefaults);
  const [auditDraft, setAuditDraft] = useState(auditFilters);
  const auditFilterKey = JSON.stringify(auditFilters);
  useEffect(() => setAuditDraft(JSON.parse(auditFilterKey)), [auditFilterKey]);
  let auditQuery = "", auditInvalid = "";
  try { auditQuery = recordQuery(auditFilters, "audit_", ["action", "actor_type", "ip", "target_type", "target_id"]); }
  catch (err) { auditInvalid = (err as Error).message; }
  const auditPage = useAdminRecordPage<AuditLogItem>("/api/audit-logs", auditQuery, auditInvalid);
  const auditLogs = auditPage.items;
  const loadingAudit = auditPage.loading;
  const loadAuditLogs = auditPage.refresh;
  const [exportingAudit, setExportingAudit] = useState(false);

  const [snapshots, setSnapshots] = useState<ConfigSnapshotItem[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [snapshotDesc, setSnapshotDesc] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [viewingSnapshot, setViewingSnapshot] = useState<any | null>(null);

  const fetchBudget = useCallback(async () => {
    return await api.get<BudgetConfigResponse>("/api/settings/budget");
  }, []);
  const fetchWebhook = useCallback(async () => {
    return await api.get<WebhookConfigResponse>("/api/settings/webhook");
  }, []);
  const fetchAnnouncement = useCallback(async () => {
    return await api.get<AnnouncementConfig>("/api/settings/announcement");
  }, []);

  const { data: budgetData, refresh: refreshBudget } = useQuery("budget-data", fetchBudget);
  const { data: webhookData, refresh: refreshWebhook } = useQuery("webhook-data", fetchWebhook);
  const { data: announcementData, refresh: refreshAnnouncement } = useQuery("announcement-data", fetchAnnouncement);

  const loadIpWhitelist = useCallback(async () => {
    try {
      const res = await api.get<IpWhitelistConfig>("/api/settings/ip-whitelist");
      hydrateIp(res);
    } catch {}
  }, []);

  const loadKeyRotation = useCallback(async () => {
    setLoadingKeyRotation(true);
    try {
      const res = await api.get<KeyRotationReport>("/api/settings/key-rotation?days=90");
      setKeyRotationData(res);
    } catch {}
    finally {
      setLoadingKeyRotation(false);
    }
  }, []);

  const loadSnapshots = useCallback(async () => {
    setLoadingSnapshots(true);
    try {
      const res = await api.get<{ items: ConfigSnapshotItem[] }>("/api/settings/snapshots");
      setSnapshots(res.items || []);
    } catch {}
    finally {
      setLoadingSnapshots(false);
    }
  }, []);

  useEffect(() => {
    loadIpWhitelist();
    loadKeyRotation();
    loadSnapshots();
  }, [loadIpWhitelist, loadKeyRotation, loadSnapshots]);

  useEffect(() => {
    if (budgetData) {
      hydrateBudget({
        monthly_budget_usd: budgetData.monthly_budget_usd || 0,
        budget_action: budgetData.budget_action || "warn",
        alert_threshold_pct: budgetData.alert_threshold_pct || 80,
        spent_this_month_usd: budgetData.spent_this_month_usd || 0,
      });
    }
  }, [budgetData]);

  useEffect(() => {
    if (announcementData) {
      hydrateAnnouncement({
        enabled: Boolean(announcementData.enabled),
        level: announcementData.level || "info",
        title: announcementData.title || "",
        message: announcementData.message || "",
        updated_at: announcementData.updated_at ?? null,
      });
    }
  }, [announcementData]);

  useEffect(() => {
    if (webhookData) {
      hydrateWebhook((prev) => ({
        ...prev,
        url: webhookData.url || "",
        events: webhookData.events || ["budget_exceeded", "provider_error"],
      }));
    }
  }, [webhookData]);

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    const submittedVersion = budgetDraft.current.editVersion;
    setSavingBudget(true);
    try {
      await api.put("/api/settings/budget", {
        monthly_budget_usd: Number(budgetForm.monthly_budget_usd) || 0,
        budget_action: budgetForm.budget_action,
        alert_threshold_pct: Number(budgetForm.alert_threshold_pct) || 80,
      });
      toast.success("月度预算配置已保存");
      if (budgetDraft.current.editVersion === submittedVersion) budgetDraft.current.dirty = false;
      await refreshBudget();
      loadAuditLogs();
    } catch (err: any) {
      toast.error(`保存预算失败: ${err.message || "未知错误"}`);
    } finally {
      setSavingBudget(false);
    }
  };

  const handleSaveAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (announcementForm.enabled && !announcementForm.message.trim()) {
      toast.error("发布公告时内容不能为空");
      return;
    }
    const submittedVersion = announcementDraft.current.editVersion;
    setSavingAnnouncement(true);
    try {
      await api.put("/api/settings/announcement", {
        enabled: announcementForm.enabled,
        level: announcementForm.level,
        title: announcementForm.title,
        message: announcementForm.message,
      });
      toast.success(announcementForm.enabled ? "公告已发布到设备控制台" : "公告已保存为未发布");
      if (announcementDraft.current.editVersion === submittedVersion) announcementDraft.current.dirty = false;
      await refreshAnnouncement();
      loadAuditLogs();
    } catch (err: any) {
      toast.error(`保存公告失败: ${err.message || "未知错误"}`);
    } finally {
      setSavingAnnouncement(false);
    }
  };

  const handleSaveWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    const submittedVersion = webhookDraft.current.editVersion;
    setSavingWebhook(true);
    try {
      await api.put("/api/settings/webhook", {
        url: webhookForm.url,
        secret: webhookForm.secret || undefined,
        events: webhookForm.events,
      });
      toast.success("Webhook 告警配置已保存");
      if (webhookDraft.current.editVersion === submittedVersion) webhookDraft.current.dirty = false;
      await refreshWebhook();
      loadAuditLogs();
    } catch (err: any) {
      toast.error(`保存 Webhook 失败: ${err.message || "未知错误"}`);
    } finally {
      setSavingWebhook(false);
    }
  };

  const handleTestWebhook = async () => {
    if (!webhookForm.url && !webhookData?.url) {
      toast.error("请先输入 Webhook 目标 URL");
      return;
    }
    setTestingWebhook(true);
    try {
      const res = await api.post<{ ok: boolean; status?: number; error?: string }>("/api/settings/test-webhook", {
        url: webhookForm.url || undefined,
        secret: webhookForm.secret || undefined,
      });
      if (res.ok) {
        toast.success(`测试消息已成功发送至 Webhook (HTTP ${res.status || 200})`);
      } else {
        toast.error(`测试发送失败: ${res.error || "未知异常"}`);
      }
    } catch (err: any) {
      toast.error(`发送失败: ${err.message || "网络请求超时"}`);
    } finally {
      setTestingWebhook(false);
    }
  };

  const handleSaveIpWhitelist = async (e: React.FormEvent) => {
    e.preventDefault();
    const submittedVersion = ipDraft.current.editVersion;
    setSavingIp(true);
    try {
      const res = await api.put<IpWhitelistConfig>("/api/settings/ip-whitelist", {
        enabled: ipForm.enabled,
        allowed_ips: ipForm.allowed_ips,
      });
      if (ipDraft.current.editVersion === submittedVersion) ipDraft.current.dirty = false;
      hydrateIp(res);
      toast.success("IP 白名单控制已保存");
      loadAuditLogs();
    } catch (err: any) {
      toast.error(err.message || "保存 IP 白名单失败");
    } finally {
      setSavingIp(false);
    }
  };

  const handleAddIp = () => {
    const ip = newIpInput.trim();
    if (!ip) return;
    if (ipForm.allowed_ips.includes(ip)) {
      toast.error("该 IP 或网段已存在于列表中");
      return;
    }
    setIpForm({ ...ipForm, allowed_ips: [...ipForm.allowed_ips, ip] });
    setNewIpInput("");
  };

  const handleAddCurrentIp = () => {
    if (ipForm.client_ip && !ipForm.allowed_ips.includes(ipForm.client_ip)) {
      setIpForm({ ...ipForm, allowed_ips: [...ipForm.allowed_ips, ipForm.client_ip] });
      toast.success(`已添加当前客户端 IP: ${ipForm.client_ip}`);
    }
  };

  const handleRemoveIp = (ipToRemove: string) => {
    setIpForm({
      ...ipForm,
      allowed_ips: ipForm.allowed_ips.filter((ip) => ip !== ipToRemove),
    });
  };

  const handleRotateKeySubmit = async (providerId: string) => {
    if (!newKeyInput.trim()) {
      toast.error("请输入新的 API Key");
      return;
    }
    try {
      await api.post(`/api/providers/${providerId}/rotate-key`, {
        api_key: newKeyInput.trim(),
      });
      toast.success("Provider API Key 已成功轮换");
      setRotatingProviderId(null);
      setNewKeyInput("");
      loadKeyRotation();
      loadAuditLogs();
    } catch (err: any) {
      toast.error(err.message || "轮换 Key 失败");
    }
  };

  const handleCreateSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingSnapshot(true);
    try {
      await api.post("/api/settings/snapshots", {
        name: snapshotName.trim() || undefined,
        description: snapshotDesc.trim() || undefined,
      });
      toast.success("配置快照已成功创建");
      setShowCreateModal(false);
      setSnapshotName("");
      setSnapshotDesc("");
      loadSnapshots();
      loadAuditLogs();
    } catch (err: any) {
      toast.error(err.message || "创建快照失败");
    } finally {
      setCreatingSnapshot(false);
    }
  };

  const handleRollbackSnapshot = async (id: string, name: string) => {
    if (!confirm(`⚠️ 确定要将系统配置回滚至快照「${name}」吗？\n\n回滚前系统将自动生成一份当前配置的安全备份快照。`)) return;
    try {
      const res = await api.post<{ success: boolean; message: string }>(`/api/settings/snapshots/${id}/rollback`, {});
      toast.success(res.message || "系统配置已成功回滚");
      loadSnapshots();
      loadAuditLogs();
    } catch (err: any) {
      toast.error(err.message || "回滚快照失败");
    }
  };

  const handleDeleteSnapshot = async (id: string) => {
    if (!confirm("确定要删除此快照吗？")) return;
    try {
      await api.del(`/api/settings/snapshots/${id}`);
      toast.success("快照已删除");
      loadSnapshots();
      loadAuditLogs();
    } catch (err: any) {
      toast.error(err.message || "删除快照失败");
    }
  };

  const handlePurgeCache = async () => {
    if (!confirm("确定要清空所有网关缓存吗？此操作将重置内存与 KV 缓存。")) return;
    setPurging(true);
    try {
      const res = await api.post<{ ok: boolean; cleared: number }>("/api/cache/purge", {});
      toast.success(`网关缓存已清空，共清除 ${res.cleared ?? 0} 个缓存条目`);
      loadAuditLogs();
    } catch (err: any) {
      toast.error(`清空缓存失败: ${err.message || "未知错误"}`);
    } finally {
      setPurging(false);
    }
  };

  const handleExportAuditLogs = async () => {
    setExportingAudit(true);
    try {
      const exported = await api.download("/api/audit-logs/export?" + auditQuery + "&limit=1000", `audit-logs-${Date.now()}.csv`);
      if (exported?.truncated) {
        toast.error(`审计日志 CSV 仅导出前 ${exported.limit ?? 1000} 条，结果不完整；请缩小时间范围后重新导出。`);
      } else {
        toast.success("审计日志 CSV 导出成功");
      }
    } catch (err: any) {
      toast.error(err.message || "导出审计日志失败");
    } finally {
      setExportingAudit(false);
    }
  };

  if (loading && !data) return <Spinner text="正在加载系统设置…" />;
  if (error && !data) return <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 p-4 rounded-xl">{error.message}</div>;

  const baseUrl = data?.gateway_base_url || window.location.origin;

  const openaiCode = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="YOUR_TOKEN" # 用户在控制台创建的子 Token
)

response = client.chat.completions.create(
    model="gpt-4o", # 或使用自定义别名
    messages=[{"role": "user", "content": "Hello via CPG Gateway!"}]
)
print(response.choices[0].message.content)`;

  const anthropicCode = `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${baseUrl}",
  apiKey: "YOUR_DEVICE_TOKEN",
});

const message = await client.messages.create({
  model: "claude-3-5-sonnet",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello from TypeScript!" }],
});
console.log(message.content);`;

  const geminiCode = `curl "${baseUrl}/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_DEVICE_TOKEN" \\
  -d '{
    "model": "gemini-1.5-pro",
    "messages": [{"role": "user", "content": "Hello Gemini!"}]
  }'`;

  const curlCode = `curl -X POST "${baseUrl}/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_DEVICE_TOKEN" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Ping"}],
    "stream": false
  }'`;

  const [tab, setTab] = useState<SettingsTabId>(() => settingsTabFor(readTabParam()));
  const show = (section: string) => view === "audit" ? section === "audit" : (SETTINGS_TABS.find(t => t.id === tab)!.sections as readonly string[]).includes(section);
  const selectTab = (id: SettingsTabId) => { setTab(id); writeTabParam(id === SETTINGS_TABS[0].id ? null : id); };

  return (
    <div className="space-y-6">
      { }
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">
          {view === "audit" ? "审计日志" : "系统设置"}
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          {view === "audit" ? "管理员和用户的每一次配置改动都记录在这里。" : "公告、预算告警、安全、备份与接入资料。"}
        </p>
      </div>

      {view === "settings" ? (
        <div role="tablist" aria-label="设置分类" className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800/60">
          {SETTINGS_TABS.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={"rounded-lg px-3 py-1.5 text-sm font-medium transition-colors " + (tab === t.id
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")}>
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      { }
      {show("announcement") ? <>
      <Card id="settings-announcement"
        title="用户控制台公告"
        action={
          announcementForm.updated_at ? (
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              上次保存 {fmtTime(announcementForm.updated_at)}
            </span>
          ) : null
        }
      >
        <form onSubmit={handleSaveAnnouncement} className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div>
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                在用户控制台顶部显示一条公告
              </span>
              <p className="text-[11px] text-slate-400 mt-0.5">
                只有登录的用户能看到。关闭后内容会保留在这里。
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={announcementForm.enabled}
                onChange={(e) => setAnnouncementForm({ ...announcementForm, enabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-slate-600 peer-checked:bg-brand-600"></div>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                公告标题（可留空）
              </label>
              <Input
                value={announcementForm.title}
                maxLength={120}
                onChange={(e) => setAnnouncementForm({ ...announcementForm, title: e.target.value })}
                placeholder="例如：本周六 02:00 计划维护"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                提示级别
              </label>
              <Select
                value={announcementForm.level}
                onChange={(e) =>
                  setAnnouncementForm({
                    ...announcementForm,
                    level: e.target.value as AnnouncementConfig["level"],
                  })
                }
              >
                <option value="info">信息（蓝色）</option>
                <option value="warning">提醒（琥珀色）</option>
                <option value="danger">重要（红色）</option>
              </Select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">公告内容</label>
              <span className="text-[11px] text-slate-400">
                {announcementForm.message.length} / 2000
              </span>
            </div>
            <Textarea
              rows={4}
              className="font-sans"
              maxLength={2000}
              value={announcementForm.message}
              onChange={(e) => setAnnouncementForm({ ...announcementForm, message: e.target.value })}
              placeholder="显示在用户控制台顶部，支持换行。"
            />
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button size="sm" type="submit" disabled={savingAnnouncement}>
              {savingAnnouncement ? "保存中…" : announcementForm.enabled ? "保存并发布公告" : "保存公告"}
            </Button>
          </div>
        </form>
      </Card>

      { }
      </> : null}
      {show("access") ? <>
      <Card id="settings-access" title="后台访问白名单">
        <form onSubmit={handleSaveIpWhitelist} className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div>
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                只允许这些 IP 或网段打开管理后台
              </span>
              <p className="text-[11px] text-slate-400 mt-0.5">
                开启后，其他 IP 访问后台会被拒绝。先把你自己当前的 IP 加进去。
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={ipForm.enabled}
                onChange={(e) => setIpForm({ ...ipForm, enabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-slate-600 peer-checked:bg-brand-600"></div>
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                允许的 IP / CIDR 网段列表
              </label>
              {ipForm.client_ip && (
                <button
                  type="button"
                  onClick={handleAddCurrentIp}
                  className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-1"
                >
                  <span>📍 添加当前 IP ({ipForm.client_ip})</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Input
                placeholder="例如: 192.168.1.100 或 10.0.0.0/24"
                value={newIpInput}
                onChange={(e) => setNewIpInput(e.target.value)}
                className="text-xs font-mono"
              />
              <Button type="button" variant="outline" size="sm" onClick={handleAddIp}>
                添加 IP
              </Button>
            </div>

            <div className="flex flex-wrap gap-1.5 pt-2">
              {ipForm.allowed_ips.length > 0 ? (
                ipForm.allowed_ips.map((ip) => (
                  <span
                    key={ip}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 font-mono text-xs border border-slate-200/80 dark:border-slate-700/80"
                  >
                    <span>{ip}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveIp(ip)}
                      className="text-slate-400 hover:text-rose-500 transition-colors ml-1"
                    >
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-xs text-slate-400 italic">尚未配置任何 IP（白名单为空）</span>
              )}
            </div>
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button size="sm" type="submit" disabled={savingIp}>
              {savingIp ? "保存中…" : "保存 IP 白名单配置"}
            </Button>
          </div>
        </form>
      </Card>

      { }
      </> : null}
      {show("keys") ? <>
      <Card id="settings-keys" title="密钥轮换">
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              建议每 90 天更换一次上游密钥和账户 Token。
            </p>
            <Button variant="outline" size="sm" onClick={() => loadKeyRotation()} disabled={loadingKeyRotation}>
              <IconRefresh />
              <span>刷新密钥状态</span>
            </Button>
          </div>

          {loadingKeyRotation ? (
            <Spinner text="正在检查密钥生命周期…" />
          ) : keyRotationData ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/40">
                  <div className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">健康正常 (&lt;60 天)</div>
                  <div className="text-xl font-bold text-emerald-900 dark:text-emerald-100 mt-0.5">
                    {keyRotationData.fresh_count} <span className="text-xs font-normal">个密钥</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-amber-50/60 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/40">
                  <div className="text-xs text-amber-700 dark:text-amber-300 font-medium">接近轮转期 (60~90 天)</div>
                  <div className="text-xl font-bold text-amber-900 dark:text-amber-100 mt-0.5">
                    {keyRotationData.expiring_soon_count} <span className="text-xs font-normal">个密钥</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-rose-50/60 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/40">
                  <div className="text-xs text-rose-700 dark:text-rose-300 font-medium">超期建议轮转 (&gt;90 天)</div>
                  <div className="text-xl font-bold text-rose-900 dark:text-rose-100 mt-0.5">
                    {keyRotationData.expired_count} <span className="text-xs font-normal">个密钥</span>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto -mx-4 -my-2 sm:mx-0 sm:my-0">
                <table className="w-full text-left text-xs min-w-[620px]">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-medium">
                      <th className="pb-2.5 px-3">名称 / 对象</th>
                      <th className="pb-2.5 px-2">类型</th>
                      <th className="pb-2.5 px-2">已使用天数</th>
                      <th className="pb-2.5 px-2">安全状态</th>
                      <th className="pb-2.5 px-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {keyRotationData.items.map((item) => (
                      <tr key={`${item.type}-${item.id}`} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                        <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100">
                          {item.name}
                        </td>
                        <td className="py-2.5 px-2 font-mono text-slate-500">
                          {item.type === "provider" ? "上游密钥" : "账户 Token"}
                        </td>
                        <td className="py-2.5 px-2 font-mono font-medium text-slate-700 dark:text-slate-300">
                          {item.age_days} 天
                        </td>
                        <td className="py-2.5 px-2">
                          <Badge
                            tone={
                              item.status === "expired"
                                ? "red"
                                : item.status === "expiring_soon"
                                ? "amber"
                                : "green"
                            }
                            dot
                          >
                            {item.status === "expired"
                              ? "建议立即轮换"
                              : item.status === "expiring_soon"
                              ? "近期计划轮换"
                              : "状态良好"}
                          </Badge>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {item.type === "provider" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setRotatingProviderId(item.id);
                                setNewKeyInput("");
                              }}
                            >
                              一键轮换
                            </Button>
                          ) : (
                            <span className="text-[11px] text-slate-400">在「用户账户」里撤销后重新创建</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <Empty text="暂无密钥轮转信息" />
          )}

          { }
          {rotatingProviderId && (
            <div className="p-4 rounded-xl bg-brand-50/60 dark:bg-brand-950/40 border border-brand-200 dark:border-brand-800 space-y-3">
              <div className="text-xs font-bold text-brand-900 dark:text-brand-200">
                🔑 输入新的 API Key 立即替换
              </div>
              <Input
                type="password"
                placeholder="sk-..."
                value={newKeyInput}
                onChange={(e) => setNewKeyInput(e.target.value)}
                className="text-xs font-mono"
              />
              <div className="flex items-center gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setRotatingProviderId(null)}>
                  取消
                </Button>
                <Button size="sm" onClick={() => handleRotateKeySubmit(rotatingProviderId)}>
                  确认替换
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      { }
      </> : null}
      {show("audit") ? <>
      <Card id="settings-audit" title="操作记录">
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              已加载 {auditLogs.length} 条
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExportAuditLogs} disabled={exportingAudit || !!auditInvalid}>
                <IconDownload />
                <span>{exportingAudit ? "导出中…" : "导出审计 CSV"}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => loadAuditLogs()} disabled={loadingAudit}>
                <IconRefresh />
                <span>刷新</span>
              </Button>
            </div>
          </div>

          <form className="grid gap-2 sm:grid-cols-3" onSubmit={event => {
            event.preventDefault();
            for (const key of Object.keys(auditDefaults)) setAuditFilter(key, auditDraft[key]);
            if (Object.keys(auditDefaults).every(key => auditFilters[key] === auditDraft[key])) void loadAuditLogs();
          }}>
            {[["action", "审计动作（精确）"], ["actor_type", "操作人类型（精确）"], ["ip", "操作人 IP（精确）"], ["target_type", "对象类型（精确）"], ["target_id", "对象 ID（精确）"], ["from", "审计开始时间"], ["to", "审计结束时间"]].map(([field, label]) => <label key={field}>{label}
              <Input aria-label={label} maxLength={256} type={field === "from" || field === "to" ? "datetime-local" : "text"}
                value={auditDraft["audit_" + field]} onChange={e => setAuditDraft({ ...auditDraft, ["audit_" + field]: e.target.value })} />
            </label>)}
            <div className="flex flex-wrap gap-2"><Button type="submit">查询审计</Button><Button type="button" variant="ghost" onClick={() => { setAuditDraft(auditDefaults); resetAuditFilters(); }}>清空审计筛选</Button></div>
          </form>
          <p className="text-xs text-slate-500">默认显示最近 30 天。改完条件点「查询审计」；导出最多 1000 条。</p>
          {auditPage.error && <div role="alert">{auditPage.error}（保留上次成功结果） <Button onClick={() => void auditPage.retry()} disabled={loadingAudit}>重试审计</Button></div>}
          {auditPage.stale && <p role="status">下方为旧筛选结果，等待新查询成功。</p>}
          {loadingAudit && <Spinner text="正在获取审计日志…" />}
          {auditLogs.length > 0 ? (
            <div className="overflow-x-auto -mx-4 -my-2 sm:mx-0 sm:my-0">
              <table className="w-full text-left text-xs min-w-[700px]">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-medium">
                    <th className="pb-2.5 px-3">时间</th>
                    <th className="pb-2.5 px-2">动作</th>
                    <th className="pb-2.5 px-2">对象类型</th>
                    <th className="pb-2.5 px-2">描述摘要</th>
                    <th className="pb-2.5 px-3 text-right">客户端 IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 whitespace-nowrap text-slate-500">
                        {fmtTime(log.created_at)}
                      </td>
                      <td className="py-2.5 px-2 whitespace-nowrap">
                        <Badge
                          tone={
                            log.action.includes("delete") || log.action.includes("rollback")
                              ? "red"
                              : log.action.includes("create")
                              ? "green"
                              : "blue"
                          }
                        >
                          {log.action}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-2 font-mono text-slate-600 dark:text-slate-400">
                        {log.target_type}
                      </td>
                      <td className="py-2.5 px-2 font-medium text-slate-900 dark:text-slate-100">
                        {log.summary}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-slate-500 whitespace-nowrap">
                        {log.ip || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !loadingAudit && !auditPage.error && <Empty text="暂无审计操作日志记录" />
          )}
        </div>
      </Card>

      {auditPage.capped && !auditPage.stale && <p role="status">已展示 1000 条审计记录。为控制页面开销，请缩小筛选范围，或使用导出（最多 1000 条，截断时会提示）；这不是全部匹配记录。</p>}
      {auditPage.cursor && !auditPage.capped && !auditPage.stale && <Button disabled={loadingAudit || !!auditPage.error} onClick={() => void auditPage.more()}>加载更多审计</Button>}
      </> : null}
      {show("openapi") ? <>
      <Card id="settings-openapi" title="OpenAPI 文档">
        <div className="space-y-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            根据已启用的模型自动生成，可以导入 Postman、Apifox 等调试工具。
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <a
              href={`${baseUrl}/v1/openapi.json`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-50 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-900/60 hover:bg-brand-100 transition-colors"
            >
              <IconFileText />
              <span>查看 openapi.json</span>
            </a>
            <CopyButton
              text={`${baseUrl}/v1/openapi.json`}
              label="复制 OpenAPI 链接"
              className="border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-lg text-xs"
            />
          </div>
        </div>
      </Card>

      { }
      </> : null}
      {show("snapshots") ? <>
      <Card id="settings-snapshots" title="配置快照">
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              备份上游、模型和系统设置，出问题时可以一键恢复。
            </p>
            <Button size="sm" onClick={() => setShowCreateModal(true)}>
              <IconCamera />
              <span>创建配置快照</span>
            </Button>
          </div>

          {loadingSnapshots ? (
            <Spinner text="正在获取快照列表…" />
          ) : snapshots.length > 0 ? (
            <div className="overflow-x-auto -mx-4 -my-2 sm:mx-0 sm:my-0">
              <table className="w-full text-left text-xs min-w-[650px]">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-medium">
                    <th className="pb-2.5 px-3">快照名称</th>
                    <th className="pb-2.5 px-2">描述</th>
                    <th className="pb-2.5 px-2">创建时间</th>
                    <th className="pb-2.5 px-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {snapshots.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-slate-100">
                        {s.name}
                      </td>
                      <td className="py-2.5 px-2 text-slate-500 max-w-[220px] truncate">
                        {s.description || "-"}
                      </td>
                      <td className="py-2.5 px-2 whitespace-nowrap text-slate-500">
                        {fmtTime(s.created_at)}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRollbackSnapshot(s.id, s.name)}
                            title="恢复并回滚至此版本"
                          >
                            ⏪ 回滚
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteSnapshot(s.id)}
                            className="text-rose-600 hover:text-rose-700"
                          >
                            <IconTrash />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty text="尚未创建任何配置快照" />
          )}

          { }
          {showCreateModal && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 space-y-3">
              <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">📸 创建新的系统配置快照</h4>
              <Input
                placeholder="快照名称 (如: 升级 DeepSeek 路由前的备份)"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                className="text-xs"
              />
              <Input
                placeholder="快照备注描述 (可选)"
                value={snapshotDesc}
                onChange={(e) => setSnapshotDesc(e.target.value)}
                className="text-xs"
              />
              <div className="flex items-center gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowCreateModal(false)}>
                  取消
                </Button>
                <Button size="sm" onClick={handleCreateSnapshot} disabled={creatingSnapshot}>
                  {creatingSnapshot ? "保存中…" : "立即保存快照"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      { }
      </> : null}
      {show("budget") ? <>
      <Card id="settings-budget" title="全站月度预算">
        <form onSubmit={handleSaveBudget} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                月度费用预算 (¥)
              </label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={budgetForm.monthly_budget_usd}
                onChange={(e) => setBudgetForm({ ...budgetForm, monthly_budget_usd: parseFloat(e.target.value) || 0 })}
                placeholder="0 为不限制"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                超额触发动作
              </label>
              <Select
                value={budgetForm.budget_action}
                onChange={(e) => setBudgetForm({ ...budgetForm, budget_action: e.target.value as "warn" | "block" })}
              >
                <option value="warn">仅发送 Webhook 告警通知</option>
                <option value="block">立即熔断拦截所有代理请求 (429)</option>
              </Select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                预警阈值比例 (%)
              </label>
              <Input
                type="number"
                min="10"
                max="100"
                value={budgetForm.alert_threshold_pct}
                onChange={(e) => setBudgetForm({ ...budgetForm, alert_threshold_pct: parseInt(e.target.value, 10) || 80 })}
              />
            </div>
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button size="sm" type="submit" disabled={savingBudget}>
              {savingBudget ? "保存中…" : "保存预算配置"}
            </Button>
          </div>
        </form>
      </Card>

      { }
      </> : null}
      {show("webhook") ? <>
      <Card id="settings-webhook" title="Webhook 告警">
        <form onSubmit={handleSaveWebhook} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Webhook URL (支持 飞书 / 钉钉 / 企业微信 / Slack / Discord)
            </label>
            <Input
              type="url"
              value={webhookForm.url}
              onChange={(e) => setWebhookForm({ ...webhookForm, url: e.target.value })}
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestWebhook}
              disabled={testingWebhook || !webhookForm.url}
            >
              {testingWebhook ? "测试中…" : "🧪 测试发送消息"}
            </Button>

            <Button size="sm" type="submit" disabled={savingWebhook}>
              {savingWebhook ? "保存中…" : "保存 Webhook 配置"}
            </Button>
          </div>
        </form>
      </Card>

      </> : null}
      {show("retention") ? <>
      <div id="settings-retention"><UsageRetentionMaintenance /></div>

      { }
      </> : null}
      {show("cache") ? <>
      <Card id="settings-cache" title="响应缓存">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                L1 内存 LRU 缓存 + L2 Cloudflare KV 持久化
              </span>
              <Badge tone="green" dot>已启用</Badge>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              高频重复请求优先命中内存（&lt;1ms 延迟），支持跨流式/非流式语义归一化复用。
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Badge tone={data?.kv_cache_configured ? "green" : "slate"} dot>
                L2 KV {data?.kv_cache_configured ? "已绑定" : "未绑定"}
              </Badge>
              <Badge tone={data?.rate_limiter_configured ? "green" : "amber"} dot>
                Durable Object 限流 {data?.rate_limiter_configured ? "已启用" : "降级为单 isolate 近似"}
              </Badge>
              <Badge tone={data?.encryption_configured ? "green" : "amber"} dot>
                密钥静态加密 {data?.encryption_configured ? "已启用" : "未启用（明文存储）"}
              </Badge>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePurgeCache}
            disabled={purging}
            className="text-rose-600 hover:text-rose-700 self-start sm:self-auto"
          >
            <IconTrash />
            <span>{purging ? "清理中…" : "一键清空网关缓存"}</span>
          </Button>
        </div>
      </Card>

      { }
      </> : null}
      {show("sdk") ? <>
      <Card id="settings-sdk" title="客户端示例代码">
        <div className="space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3 overflow-x-auto whitespace-nowrap">
            <button
              onClick={() => setActiveSnippetTab("openai")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0 ${
                activeSnippetTab === "openai" ? "bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-400" : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              OpenAI SDK (Python)
            </button>
            <button
              onClick={() => setActiveSnippetTab("anthropic")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0 ${
                activeSnippetTab === "anthropic" ? "bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-400" : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              Anthropic SDK (TypeScript)
            </button>
            <button
              onClick={() => setActiveSnippetTab("gemini")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0 ${
                activeSnippetTab === "gemini" ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400" : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              Gemini (via Gateway)
            </button>
            <button
              onClick={() => setActiveSnippetTab("curl")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0 ${
                activeSnippetTab === "curl" ? "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200" : "text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
              }`}
            >
              cURL 请求
            </button>
          </div>

          <div className="rounded-xl bg-slate-900 dark:bg-slate-950 border border-slate-800 p-3.5 sm:p-4 text-xs font-mono text-slate-200">
            <div className="flex items-center justify-end mb-2">
              <CopyButton
                text={
                  activeSnippetTab === "openai"
                    ? openaiCode
                    : activeSnippetTab === "anthropic"
                    ? anthropicCode
                    : activeSnippetTab === "gemini"
                    ? geminiCode
                    : curlCode
                }
                label="复制代码"
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 px-2.5 py-1 rounded-lg text-xs"
              />
            </div>
            <pre className="whitespace-pre overflow-x-auto leading-relaxed">
              {activeSnippetTab === "openai"
                ? openaiCode
                : activeSnippetTab === "anthropic"
                ? anthropicCode
                : activeSnippetTab === "gemini"
                ? geminiCode
                : curlCode}
            </pre>
          </div>
        </div>
      </Card>
      </> : null}
    </div>
  );
}