import { useMemo, useState } from "react";
import { ModelCategoryBadges, ModelCategoryFilter, matchesModelCategory, publicModelCategories, type CategorizedModel } from "./ConsoleModelCategories";
import type { ConsoleModelMarketplace, ConsoleModelMarketplaceItem } from "../api/consoleClient";
import { Badge, Button, Card, CopyButton, Drawer, Empty, Input, Spinner } from "./ui";
import { formatMultiplier, summarizeBands, tzLabel } from "../peakPricing";
import { isEmbeddingModel, isTextModel, isVideoModel } from "../utils/modelType";
import { videoEndpoint, videoQuotes, videoMinimums, videoVariantLabel, videoUnit, videoSortPrice } from "../utils/videoMarketplace";

type ModelItem = ConsoleModelMarketplaceItem & CategorizedModel & { routing_mode?: "auto" | "legacy" | "fixed" | "multi" };
type ModelGroup = { model_name: string; offers: ModelItem[] };
type PriceKind = "input" | "output" | "call" | "cacheRead" | "cacheWrite" | "search";
type Minimum = { price: number; offers: ModelItem[] };

function renderPeakPrice(m: ModelItem, tzOffsetMinutes: number | undefined) {
  const gray = "text-slate-400 dark:text-slate-500";
  if (!m.peak_pricing_enabled) {
    return <span className={gray}>-</span>;
  }
  const bands = m.price_windows || [];
  const tzNote = typeof tzOffsetMinutes === "number" ? `（时段按服务端时区 ${tzLabel(tzOffsetMinutes)} 计算）` : "";
  if (!bands.length) {
    return (
      <span className={gray} title={"已开启峰谷定价，但还没有配置任何时段" + tzNote}>
        未设时段
      </span>
    );
  }
  const schedule = "时段：" + summarizeBands(bands) + tzNote;
  if (m.current_price_window_id) {
    const multiplier = m.current_price_multiplier ?? 1;
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-400"
        title={"当前处于峰时，下一次调用按 " + formatMultiplier(multiplier) + " 计价。" + schedule}
      >
        {formatMultiplier(multiplier)}
        <span className="ml-1 opacity-70">峰时</span>
      </span>
    );
  }
  return (
    <span className="text-emerald-600 dark:text-emerald-400" title={"当前不在任何峰时时段，按标价计价。" + schedule}>
      谷时
    </span>
  );
}

function offerPrice(m: ModelItem, kind: PriceKind): number | null {
  if (isEmbeddingModel(m) && kind !== "input") return null;
  if (isVideoModel(m)) return null;
  if (m.pricing_mode === "unset") return null;
  if (m.pricing_mode === "free") return 0;
  const base = kind === "input" ? m.input_price_per_m
    : kind === "output" ? m.output_price_per_m
    : kind === "call" ? (m.price_per_call ?? 0)
    : kind === "cacheRead" ? (m.cache_read_price_per_m || m.input_price_per_m)
    : kind === "cacheWrite" ? (m.cache_write_price_per_m || m.input_price_per_m)
    : (m.search_price_per_call ?? 0);
  return base * (kind === "search" ? 1 : m.peak_pricing_enabled ? (m.current_price_multiplier ?? 1) : 1);
}

function lowest(offers: ModelItem[], kind: "input" | "output" | "call"): Minimum | null {
  let result: Minimum | null = null;
  for (const m of offers) {
    if (isEmbeddingModel(m) && kind !== "input") continue;
    if ((isVideoModel(m) || m.billing_unit === "call") !== (kind === "call")) continue;
    const price = offerPrice(m, kind);
    if (price === null) continue;
    if (!result || price < result.price) result = { price, offers: [m] };
    else if (price === result.price) result.offers.push(m);
  }
  return result;
}

function groupLabel(m: ModelItem) {
  if (!m.is_current) return m.service_group_name;
  if (m.routing_mode === "legacy") return "旧版默认路由";
  return m.routing_mode === "fixed" ? "令牌固定选择：" + m.service_group_name : m.service_group_name;
}
function routingSummary(routing: ConsoleModelMarketplace["routing"]) {
  if (!routing) return "路由状态暂不可用。";
  if (routing.mode === "fixed") return "此 Token 固定使用「" + (routing.fixed_group_name || "指定服务组") + "」分组。";
  if (routing.mode === "legacy") return "此 Token 使用默认路由。";
  if (routing.mode === "multi") return "此 Token 按模型使用多个分组，实际分组由路由策略决定。";
  const order = routing.selection === "input_price" ? "按输入价优先排序（按次模型按次价比较）" : routing.selection === "ordered" ? "按策略配置顺序选择候选" : "候选顺序由令牌路由策略决定";
  const fallback = routing.failure_fallback ? "失败时自动切换分组。" : "";
  return "此 Token 使用自动路由，" + order + "。" + fallback;
}
function money(price: number | null) {
  return price === null ? "未定价" : "¥" + price;
}
function offerKey(m: ModelItem) {
  return JSON.stringify([m.service_group_id, m.id]);
}

const FILTERS = [
  { key: "all", label: "全部" }, { key: "chat", label: "对话" },
  { key: "embedding", label: "向量" }, { key: "image", label: "图像" }, { key: "video", label: "视频" }, { key: "reasoning", label: "推理" }, { key: "call", label: "按次" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const SORTS = [
  { key: "name", label: "名称" }, { key: "input", label: "输入价" },
  { key: "output", label: "输出价" }, { key: "call", label: "按次价" },
] as const;
type SortKey = (typeof SORTS)[number]["key"] | "video";
export function matchesFilter(m: ModelItem, f: FilterKey) {
  const embedding = isEmbeddingModel(m);
  const video = isVideoModel(m);
  const image = !embedding && !video && (m.model_type === "image" || m.chat_endpoint === "/v1/images/generations");
  return f === "all" || (f === "embedding" && embedding) || (f === "video" && video) || (f === "image" && image) || (f === "chat" && isTextModel(m))
    || (f === "reasoning" && !embedding && !video && m.supports_reasoning) || (f === "call" && !embedding && (video || m.billing_unit === "call"));
}

export function matchesCategorySquareFilters(group: ModelGroup, filters: { q: string; filter: FilterKey; capability: "all" | "reasoning" | "vision"; billing: "all" | "token" | "call" }) {
  const needle = filters.q.trim().toLowerCase();
  const categorySearch = publicModelCategories(group.offers).some(c => [c.name, c.description].some(s => s?.toLowerCase().includes(needle)));
  return (categorySearch || group.offers.some(m => [m.model_name, m.display_name, m.alias, m.description, m.service_group_name].some(s => s?.toLowerCase().includes(needle))))
    && group.offers.some(m => matchesFilter(m, filters.filter)
      && (filters.capability === "all" || (filters.capability === "reasoning" && matchesFilter(m, "reasoning")) || (filters.capability === "vision" && (m.input_modalities ?? []).includes("image")))
      && (filters.billing === "all" || (filters.billing === "call" ? matchesFilter(m, "call") : !isVideoModel(m) && m.billing_unit !== "call")));
}

function MinimumPrice({ group, kind, label }: { group: ModelGroup; kind: "input" | "output" | "call"; label: string }) {
  const min = lowest(group.offers, kind);
  return <div className="min-w-0">
    <div className="text-xs text-slate-500 dark:text-slate-400">{label}最低</div>
    <div className="font-mono font-semibold text-slate-800 dark:text-slate-100">
      {money(min?.price ?? null)}{min ? <span className="ml-1 text-xs font-normal">{kind === "call" ? (min.offers.every(isVideoModel) ? "/成功任务次" : "/次") : "/M token"}</span> : null}
    </div>
    {min ? <div className="text-xs text-slate-500 dark:text-slate-400 break-words">{min.offers.map(groupLabel).join("、")}</div> : null}
  </div>;
}

function VideoOfferPrices({m}: {m:ModelItem}) {
  const quotes=videoQuotes(m);
  return quotes.length ? <div className="space-y-1 text-xs font-mono">{quotes.map((q,i)=><div key={i}>{videoVariantLabel(q)} {money(q.price)}{videoUnit(q)} · 成功任务结算{q.resolution === null ? <span className="ml-1">（元 / 成功任务次，不按秒计费）</span> : null}</div>)}</div> : <div className="text-amber-600">未定价（缺少有效规格报价，不参与最低价比较）</div>;
}
function VideoMinimumPrices({offers}: {offers:ModelItem[]}) {
  const minima=videoMinimums(offers);
  return minima.length ? <div className="space-y-2">{minima.map(v=><div key={v.key}><div className="text-xs text-slate-500">{videoVariantLabel(v.quote)}最低</div><div className="font-mono font-semibold">{money(v.quote.price)}{videoUnit(v.quote)} · 成功任务结算</div><div className="text-xs text-slate-500">{v.offers.map(groupLabel).join("、")}</div></div>)}</div> : <div className="text-xs text-amber-600">{offers.every(m=>videoEndpoint(m)==="/v1/video/generations") ? "成功任务次价最低未定价" : "视频未定价（缺少有效规格报价）"}</div>;
}

function ModelCard({ group, onOpen }: { group: ModelGroup; onOpen: (name: string) => void }) {
  const token = group.offers.some(m => !isVideoModel(m) && m.billing_unit !== "call");
  const call = group.offers.some(m => !isEmbeddingModel(m) && (isVideoModel(m) || m.billing_unit === "call"));
  const output = group.offers.some(m => !isEmbeddingModel(m) && !isVideoModel(m) && m.billing_unit !== "call");
  const embedding = group.offers.some(isEmbeddingModel);
  const video = group.offers.some(isVideoModel);
  const endpointSets = group.offers.map(m => isEmbeddingModel(m) ? ["/v1/embeddings"] : isVideoModel(m) ? [videoEndpoint(m)] : m.protocol_capabilities?.supported_endpoints ?? [m.chat_endpoint]);
  const endpoints = [...new Set(endpointSets.flat())];
  const sameEndpoints = endpointSets.every(set => [...set].sort().join("|") === [...endpointSets[0]].sort().join("|"));
  const descriptions = [...new Set(group.offers.map(m => m.description || ""))];
  const displayNames = [...new Set(group.offers.map(m => m.display_name || ""))];
  const displayName = displayNames.length === 1 && displayNames[0] && displayNames[0] !== group.model_name ? displayNames[0] : null;
  return <div role="button" tabIndex={0} onClick={() => onOpen(group.model_name)}
    onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(group.model_name); } }}
    className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-brand-300 hover:shadow-sm dark:hover:border-brand-800 transition cursor-pointer p-4 flex flex-col gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0"><div className="font-medium break-all">{group.model_name}</div>{displayName ? <div className="text-xs text-slate-500 dark:text-slate-400 break-words">{displayName}</div> : null}</div>
      <span onClick={e => e.stopPropagation()}><CopyButton text={group.model_name} /></span>
    </div>
    <div className="flex flex-wrap gap-1.5">
      {sameEndpoints ? endpoints.map(endpoint => <Badge key={endpoint} tone="blue">{endpoint.replace("/v1/", "")}</Badge>) : <Badge tone="slate">入站接口因组而异</Badge>}
      {group.offers.every(m => !isVideoModel(m) && m.supports_reasoning) ? <Badge tone="green">推理</Badge>
        : group.offers.some(m => !isVideoModel(m) && m.supports_reasoning) ? <Badge tone="slate">部分组支持推理</Badge> : null}
      {call ? <Badge tone="amber">{video && !token ? "按视频规格报价 · 成功任务结算" : token ? "含按次报价" : "按次计费"}</Badge> : null}
    </div>
    <ModelCategoryBadges offers={group.offers} />
    {descriptions.length === 1 && descriptions[0] ? <div className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{descriptions[0]}</div> : null}
    <div className="flex flex-wrap gap-1.5">{group.offers.map(m => <Badge key={offerKey(m)} tone={m.is_current ? "blue" : "slate"}>{groupLabel(m)}</Badge>)}</div>
    {token ? <div className="grid grid-cols-2 gap-3"><MinimumPrice group={group} kind="input" label="输入" />{output ? <MinimumPrice group={group} kind="output" label="输出" /> : null}</div> : null}
    {embedding ? <div className="text-xs text-slate-500 dark:text-slate-400">向量仅收输入 Token，不收输出费用；无响应缓存。</div> : null}
    {video ? <VideoMinimumPrices offers={group.offers.filter(isVideoModel)} /> : null}
    {group.offers.some(m=>!isVideoModel(m)&&m.billing_unit==="call") ? <MinimumPrice group={group} kind="call" label="按次" /> : null}
    <div className="text-xs text-brand-600 dark:text-brand-400 mt-auto">{group.offers.length} 个授权组报价 · 查看各组完整价格与能力 →</div>
  </div>;
}

function ProtocolDetails({ m }: { m: ModelItem }) {
  if (isEmbeddingModel(m)) return <div><dt className="text-slate-500 dark:text-slate-400">向量请求接口</dt><dd className="font-mono">/v1/embeddings</dd><dd>input: string | string[]；encoding_format: float / base64；支持 dimensions、user。不支持响应缓存与在线对话。</dd></div>;
  if (isVideoModel(m)) { const endpoint=videoEndpoint(m); return <div><dt className="text-slate-500 dark:text-slate-400">视频任务接口</dt><dd className="font-mono">POST {endpoint} · GET {endpoint} · GET {endpoint}/:id</dd><dd>提交必带 Idempotency-Key；按视频报价单位计价，成功任务结算。提交结果未知时使用相同 key 与请求体恢复，不要重新创建任务。</dd></div>; }
  const endpoints = m.protocol_capabilities?.supported_endpoints ?? [m.chat_endpoint];
  return <div><dt className="text-slate-500 dark:text-slate-400">支持的请求接口</dt><dd className="mt-1 break-all font-mono">{endpoints.join(" · ") || "暂无可用请求接口"}</dd></div>;
}

export function OfferPrices({ m }: { m: ModelItem }) {
  if (m.pricing_mode === "unset" || (isVideoModel(m) && m.pricing_mode !== "priced" && m.pricing_mode !== "free")) return <div className="text-amber-600 dark:text-amber-400">未定价（不参与最低价比较）</div>;
  if (isVideoModel(m)) return <VideoOfferPrices m={m} />;
  if (isEmbeddingModel(m)) return <div className="space-y-1 text-xs font-mono"><div>输入 {money(offerPrice(m, "input"))} / M token</div><div>仅输入计费 · 无响应缓存</div></div>;
  return <div className="space-y-1 text-xs font-mono">
    {m.pricing_mode === "free" ? <div className="text-emerald-600 dark:text-emerald-400">免费</div> : null}
    {m.billing_unit === "call" ? <div>调用 {money(offerPrice(m, "call"))} / 次</div> : <>
      <div>输入 {money(offerPrice(m, "input"))} / M token</div>
      <div>输出 {money(offerPrice(m, "output"))} / M token</div>
      <div>缓存读 {money(offerPrice(m, "cacheRead"))} / M token{m.pricing_mode === "priced" && !m.cache_read_price_per_m ? " *" : ""}</div>
      <div>缓存写 {money(offerPrice(m, "cacheWrite"))} / M token{m.pricing_mode === "priced" && !m.cache_write_price_per_m ? " *" : ""}</div>
    </>}
    <div>联网搜索 {money(offerPrice(m, "search"))} / 次（不乘峰谷倍率）</div>
  </div>;
}

function PriceTile({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return <div className="min-w-0 rounded-md bg-slate-50 p-3 dark:bg-slate-800/70">
    <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
    <dd className="mt-1 break-words text-xl font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-50">{money(value)}</dd>
    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{unit}</div>
  </div>;
}

export function ModelOfferCard({ m, tzOffsetMinutes }: { m: ModelItem; tzOffsetMinutes?: number }) {
  const video = isVideoModel(m);
  const priced = m.pricing_mode !== "unset" && (!video || videoQuotes(m).length > 0);
  const embedding = isEmbeddingModel(m);
  const byCall = !embedding && (video || m.billing_unit === "call");
  const cacheFallback = m.pricing_mode === "priced" && (!m.cache_read_price_per_m || !m.cache_write_price_per_m);
  return <section aria-label={m.service_group_name + "组报价"} className={"min-w-0 overflow-hidden rounded-lg border bg-white dark:bg-slate-900 " + (m.is_current ? "border-brand-200 dark:border-brand-800" : "border-slate-200 dark:border-slate-800")}>
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 break-words font-semibold text-slate-900 dark:text-slate-100">{m.service_group_name}</h4>
        {m.is_current ? <Badge tone="blue">{m.routing_mode === "legacy" ? "旧版默认路由" : "此 Token 固定选择"}</Badge> : null}
        {m.pricing_mode !== "priced" ? <Badge tone={m.pricing_mode === "free" && priced ? "green" : "amber"}>{m.pricing_mode === "free" && priced ? "免费" : "未定价"}</Badge> : null}
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{video ? "按视频规格报价 · 成功任务结算" : embedding ? "仅输入 Token 计费" : byCall ? "按次计费" : "按 Token 计费"}</span>
      </div>
      {m.description ? <p className="break-words text-xs leading-relaxed text-slate-600 dark:text-slate-400">{m.description}</p> : null}
      {priced ? <>
        {video ? <VideoOfferPrices m={m} /> : <dl className={byCall ? "grid grid-cols-1 gap-2" : "grid grid-cols-2 gap-2"}>
          {byCall ? <PriceTile label={video ? "成功任务单价" : "单次调用"} value={offerPrice(m, "call")} unit={video ? "元 / 成功任务次" : "元 / 次"} /> : <>
            <PriceTile label="输入" value={offerPrice(m, "input")} unit="元 / 百万 Token" />
            {!embedding ? <PriceTile label="输出" value={offerPrice(m, "output")} unit="元 / 百万 Token" /> : null}
          </>}
        </dl>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {!byCall && !embedding ? <>
            <div className="min-w-0"><dt className="text-slate-500 dark:text-slate-400">缓存读取</dt><dd className="mt-1 break-words font-medium tabular-nums">{money(offerPrice(m, "cacheRead"))}<span className="ml-1 font-normal text-slate-500 dark:text-slate-400">/ 百万 Token</span></dd></div>
            <div className="min-w-0"><dt className="text-slate-500 dark:text-slate-400">缓存写入</dt><dd className="mt-1 break-words font-medium tabular-nums">{money(offerPrice(m, "cacheWrite"))}<span className="ml-1 font-normal text-slate-500 dark:text-slate-400">/ 百万 Token</span></dd></div>
          </> : null}
          {!embedding && !video ? <div className="col-span-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-t border-slate-100 pt-2 dark:border-slate-800"><dt className="text-slate-500 dark:text-slate-400">联网搜索</dt><dd className="font-medium tabular-nums">{money(offerPrice(m, "search"))}<span className="ml-1 font-normal text-slate-500 dark:text-slate-400">/ 次 · 不乘峰谷倍率</span></dd></div> : null}
        </dl>
        {cacheFallback && !byCall && !embedding ? <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">未单独配置的缓存价格按输入价计费。</p> : null}
      </> : <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">尚未定价，不参与最低价比较。</p>}
      {video ? <p className="text-xs text-slate-500 dark:text-slate-400">只有 succeeded 的任务计费；submitting、submission_unknown、pending 和 failed 都不扣费。</p> : null}
      {embedding ? <p className="text-xs text-slate-500 dark:text-slate-400">向量仅收输入费用，不收输出费用。</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {!video ? <Badge tone={m.supports_reasoning ? "green" : "slate"}>{m.supports_reasoning ? "支持推理" : "不支持推理"}</Badge> : null}
        {!video && m.supports_reasoning && m.default_reasoning_level ? <span className="text-slate-500 dark:text-slate-400">默认 {m.default_reasoning_level}</span> : null}
        {m.peak_pricing_enabled ? <span className="ml-auto">当前峰谷：{renderPeakPrice(m, tzOffsetMinutes)}</span> : null}
      </div>
    </div>
    <details className="group border-t border-slate-100 dark:border-slate-800">
      <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-brand-500 dark:text-slate-300 dark:hover:bg-slate-800/50">接口与计价详情<span className="ml-2 font-normal text-slate-400">推理档位、标价与时段</span></summary>
      <div className="space-y-4 px-4 pb-4 text-xs leading-relaxed">
        <dl className="space-y-2">
          {m.display_name && m.display_name !== m.model_name ? <div><dt className="text-slate-500 dark:text-slate-400">展示名称</dt><dd className="break-words">{m.display_name}</dd></div> : null}
          {m.alias ? <div><dt className="text-slate-500 dark:text-slate-400">别名</dt><dd className="break-all">{m.alias}</dd></div> : null}
          <ProtocolDetails m={m} />
        </dl>
        {!video && m.supports_reasoning && m.supported_reasoning_levels?.length ? <div>
          <div className="mb-2 font-medium">推理档位</div>
          <dl className="space-y-2">{m.supported_reasoning_levels.map(level => <div key={level.effort} className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/60">
            <dt className="flex flex-wrap items-center gap-2 font-medium">{level.effort}{level.effort === m.default_reasoning_level ? <Badge tone="blue">默认</Badge> : null}</dt>
            {level.description ? <dd className="mt-1 break-words text-slate-500 dark:text-slate-400">{level.description}</dd> : null}
          </div>)}</dl>
        </div> : null}
        {!video && m.pricing_mode === "priced" ? <div><div className="mb-1 font-medium">基础标价（未乘峰谷倍率）</div><div className="break-words text-slate-500 dark:text-slate-400">{embedding ? "输入 " + money(m.input_price_per_m) + " / 百万 Token（仅输入）" : byCall ? money(m.price_per_call ?? 0) + (video ? " / 成功任务次" : " / 次") : "输入 " + money(m.input_price_per_m) + " · 输出 " + money(m.output_price_per_m) + " · 缓存读 " + money(m.cache_read_price_per_m || m.input_price_per_m) + " · 缓存写 " + money(m.cache_write_price_per_m || m.input_price_per_m) + " / 百万 Token"}</div></div> : null}
        {m.peak_pricing_enabled && m.price_windows?.length ? <div className="text-slate-500 dark:text-slate-400">时段：{summarizeBands(m.price_windows)}{typeof tzOffsetMinutes === "number" ? "（" + tzLabel(tzOffsetMinutes) + "）" : ""}</div> : null}
      </div>
    </details>
  </section>;
}

function ModelDetail({ group, routing, tzOffsetMinutes, onClose }: { group: ModelGroup; routing: ConsoleModelMarketplace["routing"]; tzOffsetMinutes: number | undefined; onClose: () => void }) {
  return <Drawer open onClose={onClose} title={group.model_name} width="max-w-lg">
    <div className="space-y-4 text-sm">
      <ModelCategoryBadges offers={group.offers} all />
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
        <p className="font-medium text-slate-800 dark:text-slate-200">{group.offers.length} 个分组报价</p>
        <p className="mt-1">{routingSummary(routing)}</p>
      </div>
      {group.offers.map(m => <ModelOfferCard key={offerKey(m)} m={m} tzOffsetMinutes={tzOffsetMinutes} />)}
      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">价格单位为人民币，已计入当前峰谷倍率。</p>
    </div>
  </Drawer>;
}

export function ModelTable({ groups, tzOffsetMinutes, onOpen }: { groups: ModelGroup[]; tzOffsetMinutes: number | undefined; onOpen: (name: string) => void }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500 dark:text-slate-400">
    <th className="p-2">模型</th><th className="p-2">服务组</th><th className="p-2">当前价格</th><th className="p-2">峰谷</th>
  </tr></thead><tbody>{groups.flatMap(group => group.offers.map(m => <tr key={offerKey(m)} className="border-t border-slate-100 dark:border-slate-800">
    <td className="p-2"><button className="text-left hover:underline break-all" onClick={() => onOpen(group.model_name)}>{group.model_name}</button><ModelCategoryBadges offers={group.offers} /></td>
    <td className="p-2">{groupLabel(m)}</td><td className="p-2"><OfferPrices m={m} /></td><td className="p-2">{renderPeakPrice(m, tzOffsetMinutes)}</td>
  </tr>))}</tbody></table></div>;
}

export function ConsoleModelsSquare({ models, loading, error }: {
  models: ConsoleModelMarketplace | null | undefined; loading: boolean; error: Error | null | undefined;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [category, setCategory] = useState("");
  const [capability, setCapability] = useState<"all" | "reasoning" | "vision">("all");
  const [billing, setBilling] = useState<"all" | "token" | "call">("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [videoVariant, setVideoVariant] = useState("");
  const [view, setView] = useState<"grid" | "table">("grid");
  const [detail, setDetail] = useState<string | null>(null);
  const groups = useMemo(() => {
    const byName = new Map<string, ModelGroup>();
    const routingMode = models?.routing?.mode ?? "legacy";
    for (const item of models?.items || []) {
      const m: ModelItem = { ...item, routing_mode: routingMode };
      const group = byName.get(m.model_name);
      if (group) group.offers.push(m);
      else byName.set(m.model_name, { model_name: m.model_name, offers: [m] });
    }
    return [...byName.values()];
  }, [models]);
  const videoVariants = useMemo(()=>videoMinimums((models?.items || []).filter(isVideoModel)),[models]);
  const categoryCandidates = useMemo(() => groups.filter(g => matchesCategorySquareFilters(g, { q, filter, capability, billing })), [groups, q, filter, capability, billing]);
  const filtered = useMemo(() => {
    const list = categoryCandidates.filter(g => matchesModelCategory(g.offers, category));
    list.sort((a, b) => {
      if (sort !== "name") {
        const ap = sort === "video" ? videoSortPrice(a.offers.filter(isVideoModel), videoVariant) : lowest(a.offers, sort)?.price;
        const bp = sort === "video" ? videoSortPrice(b.offers.filter(isVideoModel), videoVariant) : lowest(b.offers, sort)?.price;
        if (ap === undefined && bp !== undefined) return 1;
        if (bp === undefined && ap !== undefined) return -1;
        if (ap !== undefined && bp !== undefined && ap !== bp) return ap - bp;
      }
      return a.model_name.localeCompare(b.model_name);
    });
    return list;
  }, [categoryCandidates, category, sort, videoVariant]);
  const selected = groups.find(g => g.model_name === detail);
  const tzOffsetMinutes = models?.peak_pricing_tz_offset_minutes;
  return <Card title="可用模型" action={<span className="text-xs text-slate-500 dark:text-slate-400">显示 {filtered.length} / {groups.length} 个模型 · {models?.items.length || 0} 个分组报价</span>}>
    {loading ? <Spinner text="正在加载模型…" /> : error ? <div className="text-sm text-rose-600 dark:text-rose-400">{error.message}</div> : !groups.length ? <Empty text="当前没有授权模型，请联系网关所有者" /> : <div className="space-y-4">
      <details className="group rounded-lg border border-slate-200 bg-slate-50 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <span>{routingSummary(models?.routing)}</span>
          <span className="shrink-0 font-medium text-brand-600 group-open:hidden dark:text-brand-400">计价说明</span>
          <span className="hidden shrink-0 font-medium text-brand-600 group-open:inline dark:text-brand-400">收起</span>
        </summary>
        <ul className="list-disc space-y-1 border-t border-slate-200 px-3 py-2 pl-7 dark:border-slate-800">
          <li>价格单位为人民币，已计入当前峰谷倍率。</li>
          <li>输入价与输出价的最低报价可能来自不同分组。</li>
          <li>缓存未单独定价时按输入价计费。视频只有成功的任务计费。</li>
        </ul>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索模型 / 别名 / 服务组 / 分类" className="w-full sm:w-60" />
        <div role="group" aria-label="模型类型" className="flex gap-1 overflow-x-auto">{FILTERS.filter(f => f.key !== "reasoning" && f.key !== "call").map(f => <Button key={f.key} size="sm" variant={filter === f.key ? "primary" : "ghost"} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Button>)}</div>
        <div className="flex flex-wrap gap-1 sm:ml-auto">{SORTS.map(s => <Button key={s.key} size="sm" variant={sort === s.key ? "secondary" : "ghost"} onClick={() => setSort(s.key)}>{s.label}</Button>)}
          {videoVariants.length ? <select aria-label="视频同规格最低价排序" value={sort === "video" ? videoVariant : ""} onChange={e=>{setVideoVariant(e.target.value);setSort(e.target.value ? "video" : "name");}} className="rounded border bg-transparent p-1 text-xs"><option value="">视频同规格最低价排序</option>{videoVariants.map(v=><option key={v.key} value={v.key}>{videoVariantLabel(v.quote)}（{v.offers[0].video_pricing?.endpoint ?? videoEndpoint(v.offers[0])}）</option>)}</select> : null}
          <Button size="sm" variant={view === "grid" ? "secondary" : "ghost"} onClick={() => setView("grid")}>卡片</Button>
          <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} onClick={() => setView("table")}>表格</Button>
        </div>
      </div>
      <ModelCategoryFilter groups={categoryCandidates} selected={category} onChange={setCategory} />
      <details className="text-sm"><summary className="cursor-pointer">更多能力与计费条件</summary><div className="space-y-2 pt-2">
        <div role="group" aria-label="能力筛选" className="flex flex-wrap gap-1">{([{ key: "all", label: "全部能力" }, { key: "reasoning", label: "推理" }, { key: "vision", label: "视觉" }] as const).map(c => <Button key={c.key} size="sm" variant={capability === c.key ? "primary" : "ghost"} aria-pressed={capability === c.key} onClick={() => setCapability(c.key)}>{c.label}</Button>)}</div>
        <div role="group" aria-label="计费筛选" className="flex gap-1">{([{ key: "all", label: "全部计费" }, { key: "token", label: "按 Token" }, { key: "call", label: "按次 / 视频" }] as const).map(c => <Button key={c.key} size="sm" variant={billing === c.key ? "primary" : "ghost"} aria-pressed={billing === c.key} onClick={() => setBilling(c.key)}>{c.label}</Button>)}</div>
      </div></details>
      {q || filter !== "all" || category || capability !== "all" || billing !== "all" ? <Button size="sm" variant="ghost" onClick={() => { setQ(""); setFilter("all"); setCategory(""); setCapability("all"); setBilling("all"); }}>清除筛选</Button> : null}
      {!filtered.length ? <Empty text="没有符合筛选条件的模型" /> : view === "grid" ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{filtered.map(group => <ModelCard key={group.model_name} group={group} onOpen={setDetail} />)}</div>
        : <ModelTable groups={filtered} tzOffsetMinutes={tzOffsetMinutes} onOpen={setDetail} />}
    </div>}
    {!loading && !error && selected ? <ModelDetail group={selected} routing={models?.routing} tzOffsetMinutes={tzOffsetMinutes} onClose={() => setDetail(null)} /> : null}
  </Card>;
}
