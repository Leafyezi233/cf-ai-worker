import { useCallback, useState, type FormEvent } from "react";
import { api, ApiError, fmtTime } from "../api/client";
import type { DeviceItem, DeviceModelScopeResponse, ModelScope } from "../types";
import { Badge, Button, Card, Drawer, Empty, Input, Modal, Spinner } from "../components/ui";
import { IconPlus, IconEdit, IconDevices, IconShield, IconCopy } from "../components/icons";
import { useToast } from "../components/Toast";
import { useQuery } from "../hooks/useQuery";
import { VideoDiagnosticControls } from "../components/VideoDiagnosticControls";

interface CreateResponse {
  item: DeviceItem;
  token: string;
}

interface SubTokenView {
  id: string;
  name: string;
  enabled: boolean;
  revoked: boolean;
  last_used_at: number | null;
  created_at: number;
}

const SCOPE_LABELS: Record<ModelScope, string> = {
  all: "全部模型",
  list: "仅白名单",
  all_and_list: "全部 + 白名单",
};

const SCOPE_HINTS: Record<ModelScope, string> = {
  all: "该设备可以调用所有已启用的模型（同时受设备月额、余额与限流约束）。",
  list: "该设备只能调用下方勾选的模型，其余模型一律返回 403。",
  all_and_list: "与「全部模型」相同，勾选项仅用于记录，不额外收窄权限。",
};

type TopupMode = "add" | "subtract" | "set";

function callsAllowed(d: DeviceItem): boolean {
  return d.calls_enabled === undefined || d.calls_enabled === null ? true : Boolean(d.calls_enabled);
}

const TOPUP_MODES: { id: TopupMode; label: string; hint: string; variant: "success" | "warning" | "secondary" }[] = [
  { id: "add", label: "充值", hint: "在当前余额上增加一笔", variant: "success" },
  { id: "subtract", label: "扣减", hint: "从当前余额里扣掉一笔", variant: "warning" },
  { id: "set", label: "设为余额", hint: "直接把余额设成我填的数字", variant: "secondary" },
];
export default function DevicesPage() {
  const toast = useToast();
  const [showRevoked, setShowRevoked] = useState(false);
  const fetchDevices = useCallback(async () => {
    const path = showRevoked ? "/api/devices?include_revoked=1" : "/api/devices";
    const res = await api.get<{ items: DeviceItem[] }>(path);
    return res.items || [];
  }, [showRevoked]);

  const { data: items = [], loading, refresh } = useQuery(
    showRevoked ? "devices-list:with-revoked" : "devices-list",
    fetchDevices
  );
  const [error, setError] = useState("");
  const [diagnosticDevice, setDiagnosticDevice] = useState<DeviceItem | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [rateLimitRpm, setRateLimitRpm] = useState<string>("0");
  const [costLimitMonthly, setCostLimitMonthly] = useState<string>("0");
  const [created, setCreated] = useState<CreateResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [editingDevice, setEditingDevice] = useState<DeviceItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editRpm, setEditRpm] = useState("0");
  const [editCostLimit, setEditCostLimit] = useState("0");
  const [initialBalance, setInitialBalance] = useState("");

  const [topupDevice, setTopupDevice] = useState<DeviceItem | null>(null);
  const [topupMode, setTopupMode] = useState<TopupMode>("add");
  const [topupAmount, setTopupAmount] = useState("");
  const [topupNote, setTopupNote] = useState("");

  const [subTokensDevice, setSubTokensDevice] = useState<DeviceItem | null>(null);
  const [subTokens, setSubTokens] = useState<SubTokenView[]>([]);
  const [subTokensLoading, setSubTokensLoading] = useState(false);
  const [subTokensError, setSubTokensError] = useState("");
  const [subTokensShowRevoked, setSubTokensShowRevoked] = useState(false);

  const [scopeDevice, setScopeDevice] = useState<DeviceItem | null>(null);
  const [scopeValue, setScopeValue] = useState<ModelScope>("all");
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [scopeRpms, setScopeRpms] = useState<Record<string, number>>({});
  const [scopeOptions, setScopeOptions] = useState<DeviceModelScopeResponse["models"]>([]);
  const [scopeGroups, setScopeGroups] = useState<NonNullable<DeviceModelScopeResponse["groups"]>>([]);
  const [scopeGroupIds, setScopeGroupIds] = useState<string[]>([]);
  const [scopeGroupRpms, setScopeGroupRpms] = useState<Record<string, number>>({});
  const [scopeFilter, setScopeFilter] = useState("");
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [scopeError, setScopeError] = useState("");

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await api.post<CreateResponse>("/api/devices", {
        name: name.trim(),
        rate_limit_rpm: parseInt(rateLimitRpm, 10) || 0,
        cost_limit_monthly: parseFloat(costLimitMonthly) || 0,
        balance_usd: initialBalance.trim() === "" ? undefined : parseFloat(initialBalance) || 0,
      });
      setCreated(res);
      setName("");
      setRateLimitRpm("0");
      setCostLimitMonthly("0");
      setInitialBalance("");
      setShowCreate(false);
      await refresh();
      toast.success(`已成功创建设备「${res.item.name}」`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  function openEdit(d: DeviceItem) {
    setEditingDevice(d);
    setEditName(d.name);
    setEditRpm(String(d.rate_limit_rpm || 0));
    setEditCostLimit(String(d.cost_limit_monthly || 0));
    setError("");
  }

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingDevice) return;
    setSubmitting(true);
    try {
      await api.put(`/api/devices/${editingDevice.id}`, {
        name: editName.trim(),
        rate_limit_rpm: parseInt(editRpm, 10) || 0,
        cost_limit_monthly: parseFloat(editCostLimit) || 0,
      });
      setEditingDevice(null);
      await refresh();
      toast.success(`设备「${editName}」已更新`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "更新失败");
    } finally {
      setSubmitting(false);
    }
  }

  function openTopup(d: DeviceItem) {
    setTopupDevice(d);
    setTopupMode("add");
    setTopupAmount("");
    setTopupNote("");
    setError("");
  }

  async function onTopup(e: FormEvent) {
    e.preventDefault();
    if (!topupDevice) return;
    const raw = parseFloat(topupAmount);
    if (!Number.isFinite(raw)) {
      setError(TOPUP_MODES.find((m) => m.id === topupMode)?.hint + "：请填写数字");
      return;
    }
    const amount = Math.round(raw * 1e6) / 1e6;
    if (topupMode !== "set" && amount <= 0) {
      setError(topupMode === "add" ? "充值金额必须大于 0" : "扣减金额必须大于 0");
      return;
    }
    setSubmitting(true);
    try {
      const body = topupMode === "set"
        ? { mode: "set", target_balance_usd: amount, note: topupNote.trim() || null }
        : {
            mode: "delta",
            amount_usd: topupMode === "subtract" ? -Math.abs(amount) : amount,
            note: topupNote.trim() || null,
          };
      await api.post(`/api/devices/${topupDevice.id}/topup`, body);
      setTopupDevice(null);
      await refresh();
      const verb = topupMode === "set" ? "余额已设为" : topupMode === "add" ? "已充值" : "已扣减";
      toast.success(`设备「${topupDevice.name}」${verb} ¥${amount.toFixed(4)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }
  async function onToggle(d: DeviceItem) {
    try {
      await api.put(`/api/devices/${d.id}`, { enabled: !d.enabled });
      await refresh();
      toast.success(`设备「${d.name}」已${d.enabled ? "禁用" : "启用"}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "操作失败");
    }
  }

  async function onToggleCalls(d: DeviceItem) {
    const allowed = callsAllowed(d);
    if (allowed && !confirm(`确认禁止设备「${d.name}」调用模型？该主 Token 的新请求会被拒绝（403 calls_disabled），其名下子 Token 不受影响，控制台仍可登录。`)) return;
    try {
      await api.post(`/api/devices/${d.id}/calls`, { enabled: !allowed });
      await refresh();
      toast.success(`设备「${d.name}」已${allowed ? "禁止" : "恢复"}调用`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "操作失败");
    }
  }

  async function onResetPassword(d: DeviceItem) {
    if (
      !confirm(
        `确认重置设备「${d.name}」的控制台密码？该设备当前密码立即作废，持有人下次打开控制台时需要重新设置密码。管理员不会看到任何明文密码。`
      )
    )
      return;
    try {
      await api.post(`/api/devices/${d.id}/reset-password`);
      toast.success(`设备「${d.name}」的密码已重置，持有人下次进入控制台需重新设置`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "重置失败");
    }
  }

  async function loadSubTokens(d: DeviceItem, includeRevoked: boolean) {
    setSubTokens([]);
    setSubTokensError("");
    setSubTokensLoading(true);
    try {
      const path =
        "/api/devices/" + d.id + "/sub-tokens" + (includeRevoked ? "?include_revoked=1" : "");
      const res = await api.get<{ items: SubTokenView[] }>(path);
      setSubTokens(res.items || []);
    } catch (err) {
      setSubTokensError(err instanceof ApiError ? err.message : "加载子 Token 失败");
    } finally {
      setSubTokensLoading(false);
    }
  }

  async function openSubTokens(d: DeviceItem) {
    setSubTokensDevice(d);
    setSubTokensShowRevoked(false);
    await loadSubTokens(d, false);
  }
  async function onRevoke(d: DeviceItem) {
    if (!confirm(`确认永久撤销设备「${d.name}」？撤销后该 Token 将立即失效，无法恢复。`)) return;
    try {
      await api.post(`/api/devices/${d.id}/revoke`);
      await refresh();
      toast.success(`设备「${d.name}」Token 已成功撤销`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "操作失败");
    }
  }

  async function openScope(d: DeviceItem) {
    setScopeDevice(d);
    setScopeValue(d.model_scope || "all");
    setScopeFilter("");
    setScopeError("");
    setScopeOptions([]);
    setScopeRpms({});
    setScopeGroups([]);
    setScopeGroupIds([]);
    setScopeGroupRpms({});
    setScopeLoading(true);
    try {
      const res = await api.get<DeviceModelScopeResponse>(`/api/devices/${d.id}/model-scope`);
      setScopeOptions(res.models || []);
      setScopeGroups(res.groups || []);
      setScopeValue(res.item.model_scope || "all");
      setScopeIds(res.item.model_ids || []);
      setScopeRpms(res.item.rpm_limits || {});
      setScopeGroupIds(res.item.group_ids || []);
      setScopeGroupRpms(res.item.group_rpms || {});
    } catch (err) {
      setScopeError(err instanceof ApiError ? err.message : "加载模型白名单失败");
    } finally {
      setScopeLoading(false);
    }
  }

  async function onSaveScope(e: FormEvent) {
    e.preventDefault();
    if (!scopeDevice) return;
    if (scopeValue !== "all" && scopeIds.length === 0 && scopeGroupIds.length === 0) {
      setScopeError("白名单模式至少要选择一个模型或分组，否则该设备将无法调用任何模型");
      return;
    }
    setScopeSaving(true);
    setScopeError("");
    try {
      const modelRpms: Record<string, number> = {};
      for (const id of scopeIds) {
        const rpm = scopeRpms[id];
        if (typeof rpm === "number" && rpm > 0) modelRpms[id] = Math.floor(rpm);
      }
      const groupRpms: Record<string, number> = {};
      for (const id of scopeGroupIds) {
        const rpm = scopeGroupRpms[id];
        if (typeof rpm === "number" && rpm > 0) groupRpms[id] = Math.floor(rpm);
      }
      await api.put(`/api/devices/${scopeDevice.id}/model-scope`, {
        model_scope: scopeValue,
        model_ids: scopeIds,
        model_rpms: modelRpms,
        group_ids: scopeGroupIds,
        group_rpms: groupRpms,
      });
      setScopeDevice(null);
      await refresh();
      toast.success(`设备「${scopeDevice.name}」的模型范围已更新`);
    } catch (err) {
      setScopeError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setScopeSaving(false);
    }
  }

  function toggleScopeId(id: string) {
    setScopeIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

  function toggleScopeGroupId(id: string) {
    setScopeGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function setScopeGroupRpm(id: string, raw: string) {
    const parsed = parseInt(raw, 10);
    setScopeGroupRpms((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(parsed) || parsed <= 0) delete next[id];
      else next[id] = parsed;
      return next;
    });
  }

  function setScopeRpm(id: string, raw: string) {
    const parsed = parseInt(raw, 10);
    setScopeRpms((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(parsed) || parsed <= 0) delete next[id];
      else next[id] = parsed;
      return next;
    });
  }

  if (loading && !items.length) return <Spinner text="正在加载设备 Token 列表…" />;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">设备与客户端 Token</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            为不同客户端（如 Cursor、VS Code 插件、本地脚本、手机）签发独立的鉴权 Token 与速率限制
          </p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>显示已撤销</span>
          </label>
          <Button
            onClick={() => {
              setError("");
              setName("");
              setRateLimitRpm("0");
              setInitialBalance("");
              setShowCreate(true);
            }}
            className="shadow-sm w-full sm:w-auto"
          >
            <IconPlus />
            <span>签发新设备 Token</span>
          </Button>
        </div>
      </div>

      <Card>
        {items.length ? (
          <div className="overflow-x-auto -mx-4 -my-4 sm:mx-0 sm:my-0">
            <table className="w-full text-left text-xs sm:text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500 font-medium">
                  <th className="pb-3 px-3 whitespace-nowrap">设备名称</th>
                  <th className="pb-3 px-2 whitespace-nowrap">当前状态</th>
                  <th className="pb-3 px-2 whitespace-nowrap">每分钟限流 (RPM)</th>
                  <th className="pb-3 px-2 whitespace-nowrap">本月消费 / 限额</th>
                  <th className="pb-3 px-2 whitespace-nowrap">可用余额</th>
                  <th className="pb-3 px-2 whitespace-nowrap">最近活跃时间</th>
                  <th className="pb-3 px-2 whitespace-nowrap">创建时间</th>
                  <th className="pb-3 px-2 whitespace-nowrap">模型范围</th>
                  <th className="pb-3 px-3 text-right whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((d) => {
                  const spend = d.current_month_cost || 0;
                  const limit = d.cost_limit_monthly || 0;
                  const isBlocked = limit > 0 && spend >= limit;
                  const pct = limit > 0 ? Math.min(100, Math.round((spend / limit) * 100)) : 0;
                  return (
                    <tr key={d.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="py-3 px-3">
                        <div className="font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">{d.name}</div>
                        <div className="font-mono text-[11px] text-slate-400 dark:text-slate-500">ID: {d.id}</div>
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        {d.revoked_at ? (
                          <Badge tone="red" dot>
                            已撤销
                          </Badge>
                        ) : isBlocked ? (
                          <Badge tone="red" dot>
                            已超额熔断
                          </Badge>
                        ) : d.enabled ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge tone="green" dot>
                              正常
                            </Badge>
                            {callsAllowed(d) ? null : <Badge tone="amber">禁止调用</Badge>}
                          </div>
                        ) : (
                          <Badge tone="slate" dot>
                            已暂停
                          </Badge>
                        )}
                      </td>
                      <td className="py-3 px-2 font-mono text-xs whitespace-nowrap">
                        {d.rate_limit_rpm ? (
                          <Badge tone="blue">{d.rate_limit_rpm} 次/分</Badge>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">无限制</span>
                        )}
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        {limit > 0 ? (
                          <div className="space-y-1 min-w-[130px]">
                            <div className="flex items-center justify-between text-xs font-mono">
                              <span className={isBlocked ? "text-rose-600 font-bold" : "text-slate-700 dark:text-slate-300"}>
                                ¥{spend.toFixed(2)}
                              </span>
                              <span className="text-slate-400">/ ¥{limit.toFixed(2)}</span>
                            </div>
                            <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  pct >= 100
                                    ? "bg-rose-500"
                                    : pct >= 80
                                    ? "bg-amber-500"
                                    : "bg-emerald-500"
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs font-mono text-slate-600 dark:text-slate-400">
                            ¥{spend.toFixed(2)} <span className="text-slate-400 font-sans text-[11px]">(不设限)</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        {(() => {
                          const bal = d.balance_usd ?? 0;
                          const reserved = d.reserved_usd ?? 0;
                          const avail = bal - reserved;
                          return (
                            <div className="min-w-[90px]">
                              <div
                                className={
                                  "text-xs font-mono " +
                                  (avail < 0
                                    ? "text-rose-600 dark:text-rose-400"
                                    : "text-slate-700 dark:text-slate-300")
                                }
                                title={avail < 0 ? "余额为负：已透支，需充值结清" : undefined}
                              >
                                {avail < 0 ? "-" : ""}¥{Math.abs(avail).toFixed(4)}
                              </div>
                              {reserved > 0 ? (
                                <div className="text-[11px] font-mono text-amber-600 dark:text-amber-400">预占 ¥{reserved.toFixed(4)}</div>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-2 text-slate-600 dark:text-slate-400 text-xs whitespace-nowrap">{fmtTime(d.last_used_at)}</td>
                      <td className="py-3 px-2 text-slate-400 dark:text-slate-500 text-xs whitespace-nowrap">{fmtTime(d.created_at)}</td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        <Badge tone={(d.model_scope || "all") === "all" ? "slate" : "blue"}>
                          {SCOPE_LABELS[d.model_scope || "all"]}
                        </Badge>
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        {!d.revoked_at ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => openEdit(d)}>
                              <IconEdit />
                              <span>编辑</span>
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openTopup(d)}>
                              <span>充值</span>
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => void openScope(d)}>
                              <IconShield />
                              <span>模型范围</span>
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => onToggle(d)}>
                              {d.enabled ? "暂停" : "恢复"}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => void onToggleCalls(d)}>
                              {callsAllowed(d) ? "禁止调用" : "恢复调用"}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => void openSubTokens(d)}>
                              子 Token
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setDiagnosticDevice(d)}>
                              视频采样
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => void onResetPassword(d)}>
                              重置密码
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                              onClick={() => onRevoke(d)}
                            >
                              撤销
                            </Button>
                          </div>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500 text-xs italic">不可用</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="尚未签发任何设备 Token" icon={<IconDevices className="w-8 h-8" />} />
        )}
      </Card>

      <Modal open={Boolean(diagnosticDevice)} onClose={() => { if (!diagnosticBusy) setDiagnosticDevice(null); }} title="视频诊断采样">
        {diagnosticDevice ? <VideoDiagnosticControls key={diagnosticDevice.id} deviceId={diagnosticDevice.id} deviceName={diagnosticDevice.name} onBusyChange={setDiagnosticBusy} /> : null}
      </Modal>

      { }
      <Drawer
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="签发新设备 Token"
      >
        <form onSubmit={onCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">设备/应用名称</label>
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：MacBook Cursor / 本地工作站 / iOS 快捷指令"
              autoFocus
            />
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
              建议为每台设备分配专属名称，便于在用量记录中审计来源与精准撤销。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                每分钟限流 (RPM) <span className="text-slate-400 dark:text-slate-500 font-normal">（0为不限）</span>
              </label>
              <Input
                type="number"
                min="0"
                value={rateLimitRpm}
                onChange={(e) => setRateLimitRpm(e.target.value)}
                placeholder="0"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                月度费用限额 ($) <span className="text-slate-400 dark:text-slate-500 font-normal">（0为不限）</span>
              </label>
              <Input
                type="number"
                step="0.1"
                min="0"
                value={costLimitMonthly}
                onChange={(e) => setCostLimitMonthly(e.target.value)}
                placeholder="0"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                初始余额 ($) <span className="text-slate-400 dark:text-slate-500 font-normal">（留空则沿用月度费用限额）</span>
              </label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                value={initialBalance}
                onChange={(e) => setInitialBalance(e.target.value)}
                placeholder="留空 = 沿用月度限额"
              />
            </div>
          </div>

          {error ? <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">{error}</div> : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "正在生成…" : "确认签发"}
            </Button>
          </div>
        </form>
      </Drawer>

      { }
      <Drawer
        open={Boolean(editingDevice)}
        onClose={() => setEditingDevice(null)}
        title="编辑设备配置"
      >
        <form onSubmit={onSaveEdit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">设备/应用名称</label>
            <Input
              required
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="设备名称"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                每分钟限流 (RPM) <span className="text-slate-400 dark:text-slate-500 font-normal">（0为不限）</span>
              </label>
              <Input
                type="number"
                min="0"
                value={editRpm}
                onChange={(e) => setEditRpm(e.target.value)}
                placeholder="0"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                月度费用限额 ($) <span className="text-slate-400 dark:text-slate-500 font-normal">（0为不限）</span>
              </label>
              <Input
                type="number"
                step="0.1"
                min="0"
                value={editCostLimit}
                onChange={(e) => setEditCostLimit(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          {error ? <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">{error}</div> : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setEditingDevice(null)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "正在保存…" : "保存修改"}
            </Button>
          </div>
        </form>
      </Drawer>

      { }
      <Drawer
        open={Boolean(scopeDevice)}
        onClose={() => setScopeDevice(null)}
        title={"模型范围 — " + (scopeDevice?.name || "")}
        width="max-w-2xl"
      >
        <form onSubmit={onSaveScope} className="space-y-4">
          <div className="space-y-2">
            {(Object.keys(SCOPE_LABELS) as ModelScope[]).map((s) => (
              <label
                key={s}
                className="flex items-start gap-2.5 cursor-pointer"
              >
                <input
                  type="radio"
                  name="model-scope"
                  className="mt-0.5"
                  checked={scopeValue === s}
                  onChange={() => setScopeValue(s)}
                />
                <span>
                  <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {SCOPE_LABELS[s]}
                  </span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                    {SCOPE_HINTS[s]}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                可用模型（已启用）
              </label>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                已选 {scopeIds.length} / {scopeOptions.length}
              </span>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <Input
                className="flex-1"
                value={scopeFilter}
                onChange={(ev) => setScopeFilter(ev.target.value)}
                placeholder="按模型名或显示名过滤…"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={scopeLoading}
                onClick={() => {
                  setScopeIds(scopeOptions.map((m) => m.id));
                  setScopeFilter("");
                }}
              >
                全选
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={scopeLoading} onClick={() => setScopeIds([])}>
                清空
              </Button>
            </div>
            {scopeLoading ? (
              <Spinner text="正在加载模型…" />
            ) : scopeOptions.length === 0 ? (
              <Empty text="还没有已启用的模型" />
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                {scopeOptions
                  .filter((m) => {
                    const q = scopeFilter.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      m.model_name.toLowerCase().includes(q) ||
                      (m.display_name || "").toLowerCase().includes(q) ||
                      m.id.toLowerCase().includes(q)
                    );
                  })
                  .map((m) => {
                    const rpm = scopeRpms[m.id] ? String(scopeRpms[m.id]) : "";
                    return (
                      <div
                        key={m.id}
                        className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 shrink-0 cursor-pointer"
                          checked={scopeIds.includes(m.id)}
                          onChange={() => toggleScopeId(m.id)}
                        />
                        <label className="min-w-0 flex-1 cursor-pointer">
                          <span className="block text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                            {m.display_name || m.model_name}
                          </span>
                          <span className="block text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate">
                            {m.model_name}
                          </span>
                        </label>

                        <input
                          type="number"
                          min={0}
                          step={1}
                          placeholder="不限"
                          disabled={!scopeIds.includes(m.id)}
                          value={rpm}
                          onChange={(ev) => setScopeRpm(m.id, ev.target.value)}
                          className="w-24 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-800 dark:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">可用分组</label>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                已选 {scopeGroupIds.length} / {scopeGroups.length}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2">
              分组与模型分开授权：勾选一个分组只代表这台设备可以调用那个组名，组里有哪些成员是分组自己的事，
              不会顺带把成员也加进白名单。
            </p>
            {scopeLoading ? (
              <Spinner text="正在加载分组…" />
            ) : scopeGroups.length === 0 ? (
              <Empty text="还没有分组（在「模型分组」页创建）" />
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                {scopeGroups.map((g) => {
                  const rpm = scopeGroupRpms[g.id] ? String(scopeGroupRpms[g.id]) : "";
                  return (
                    <div key={g.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <input
                        type="checkbox"
                        className="mt-0.5 shrink-0 cursor-pointer"
                        checked={scopeGroupIds.includes(g.id)}
                        onChange={() => toggleScopeGroupId(g.id)}
                      />
                      <label className="min-w-0 flex-1 cursor-pointer">
                        <span className="flex items-center gap-1.5">
                          <span className="block text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                            {g.display_name || g.name}
                          </span>
                          <Badge tone="purple">分组</Badge>
                          {g.enabled ? null : <Badge tone="slate">停用</Badge>}
                        </span>
                        <span className="block text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate">{g.name}</span>
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        placeholder="不限"
                        disabled={!scopeGroupIds.includes(g.id)}
                        value={rpm}
                        onChange={(ev) => setScopeGroupRpm(g.id, ev.target.value)}
                        className="w-24 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-800 dark:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {scopeError ? (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">
              {scopeError}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setScopeDevice(null)}>
              取消
            </Button>
            <Button type="submit" disabled={scopeSaving || scopeLoading}>
              {scopeSaving ? "正在保存…" : "保存模型范围"}
            </Button>
          </div>
        </form>
      </Drawer>
      { }
      <Drawer
        open={Boolean(topupDevice)}
        onClose={() => setTopupDevice(null)}
        title={topupMode === "set" ? "设备余额 — 设为目标值" : topupMode === "add" ? "设备余额 — 充值" : "设备余额 — 扣减"}
      >
        <form onSubmit={onTopup} className="space-y-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            设备「<span className="font-semibold text-slate-700 dark:text-slate-200">{topupDevice?.name}</span>」当前余额 
            <span className="font-mono">¥{(topupDevice?.balance_usd ?? 0).toFixed(4)}</span>
            {topupDevice?.reserved_usd ? <>，其中已预占 <span className="font-mono">¥{topupDevice.reserved_usd.toFixed(4)}</span></> : null}
            {topupMode === "set" && (topupDevice?.reserved_usd ?? 0) > 0 ? <>（设为目标值按总余额计算，预占部分照旧）</> : null}
            。
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              {TOPUP_MODES.map((m) => (
                <Button
                  key={m.id}
                  type="button"
                  variant={topupMode === m.id ? m.variant : "outline"}
                  onClick={() => {
                    setTopupMode(m.id);
                    setTopupAmount("");
                    setError("");
                  }}
                  className="flex-1"
                >
                  {m.label}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {TOPUP_MODES.find((m) => m.id === topupMode)?.hint}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              {topupMode === "set" ? "目标余额 ($)" : topupMode === "add" ? "充值金额 ($)" : "扣减金额 ($)"}
            </label>
            <Input
              required
              type="number"
              step="0.0001"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              placeholder={topupMode === "set" ? "例如 20" : topupMode === "add" ? "例如 5" : "例如 1.5"}
              autoFocus
            />
            {topupMode === "set" ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                提交后余额会正好变成这个数字（差额自动计算）。允许填负数，用于结清或刻意设定欠款。
              </p>
            ) : null}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">备注（可选）</label>
            <Input
              value={topupNote}
              onChange={(e) => setTopupNote(e.target.value)}
              placeholder="例如：8 月订阅续费"
            />
          </div>

          {error ? <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/50 p-2.5 rounded-lg">{error}</div> : null}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button type="button" variant="secondary" onClick={() => setTopupDevice(null)}>
              取消
            </Button>
            <Button type="submit" variant={topupMode === "subtract" ? "danger" : "primary"} disabled={submitting}>
              {submitting
                ? "正在提交…"
                : topupMode === "set"
                ? "设为该余额"
                : topupMode === "add"
                ? "确认充值"
                : "确认扣减"}
            </Button>
          </div>
        </form>
      </Drawer>
      { }
      <Modal open={Boolean(created)} onClose={() => setCreated(null)} title="设备 Token 签发成功">
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 text-amber-900 dark:text-amber-200 text-xs">
            <IconShield className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div>
              <span className="font-semibold">请妥善保存此 Token！</span>
              <p className="mt-0.5 text-amber-800 dark:text-amber-300">
                该 Token 仅在此处展示一次，关闭窗口后将无法再次查看完整密钥。
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">Bearer Token 密钥</div>
            <div className="rounded-xl bg-slate-900 dark:bg-slate-950 p-3.5 font-mono text-xs break-all text-emerald-300 select-all border border-slate-800 flex items-center justify-between gap-2">
              <span>{created?.token}</span>
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3 text-xs text-slate-600 dark:text-slate-300 space-y-1 font-mono">
            <div className="text-slate-400 dark:text-slate-500 font-sans text-[11px] font-semibold">请求头使用示例：</div>
            <div>Authorization: Bearer {created?.token?.slice(0, 16)}...</div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button
              variant="secondary"
              onClick={() => {
                if (created) void navigator.clipboard?.writeText(created.token);
              }}
            >
              <IconCopy />
              <span>复制 Token</span>
            </Button>
            <Button onClick={() => setCreated(null)}>我已保存，完成</Button>
          </div>
        </div>
      </Modal>
      { 
}
      <Drawer
        open={Boolean(subTokensDevice)}
        onClose={() => setSubTokensDevice(null)}
        title="子 Token"
      >
        <div className="space-y-3">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            设备「{subTokensDevice?.name}」名下的子 Token。子 Token 只能调用模型，不能登录控制台；其花费记在主 Token 的账上。
            每个主 Token 最多 5 个，持有者可在控制台自行新建、启用、禁用与撤销。
          </div>
          <label className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={subTokensShowRevoked}
              onChange={(e) => {
                const next = e.target.checked;
                setSubTokensShowRevoked(next);
                if (subTokensDevice) void loadSubTokens(subTokensDevice, next);
              }}
              className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>显示已撤销</span>
          </label>
          {subTokensLoading ? (
            <Spinner text="正在加载子 Token…" />
          ) : subTokensError ? (
            <div className="text-sm text-rose-600 dark:text-rose-400">{subTokensError}</div>
          ) : subTokens.length === 0 ? (
            <Empty text="该设备还没有子 Token" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-2 pr-3 font-medium">名称</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 font-medium">最近使用</th>
                    <th className="py-2 font-medium">创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {subTokens.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-2 pr-3">
                        <div className="text-slate-800 dark:text-slate-200">{t.name}</div>
                        <div className="font-mono text-[11px] text-slate-400 dark:text-slate-500">{t.id}</div>
                      </td>
                      <td className="py-2 pr-3">
                        {t.revoked ? (
                          <Badge tone="red">已撤销</Badge>
                        ) : t.enabled ? (
                          <Badge tone="green">启用中</Badge>
                        ) : (
                          <Badge tone="slate">已禁用</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        {fmtTime(t.last_used_at)}
                      </td>
                      <td className="py-2 text-xs text-slate-400 dark:text-slate-500 whitespace-nowrap">
                        {fmtTime(t.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
            <Button variant="secondary" onClick={() => setSubTokensDevice(null)}>
              关闭
            </Button>
          </div>
        </div>
      </Drawer>
    </div>
  );
}

