import type { ConsoleModelMarketplaceItem } from "../api/consoleClient";
type Offer = ConsoleModelMarketplaceItem;
export type VideoQuote = NonNullable<Offer["video_pricing"]>["quotes"][number];
export function videoEndpoint(m: Offer): string {
  return m.video_pricing?.endpoint ?? (m.chat_endpoint === "/v1/videos" || m.video?.resolutions ? "/v1/videos" : "/v1/video/generations");
}
export function videoQuotes(m: Offer): VideoQuote[] {
  if (m.pricing_mode !== "priced" && m.pricing_mode !== "free") return [];
  if (m.pricing_mode === "free" && m.video_pricing?.quotes.some(q=>q.price!==0)) return [];
  if (m.video_pricing) return m.video_pricing.quotes.filter(q=>Number.isFinite(q.price)&&q.price>=0 && (m.pricing_mode!=="free"||q.price===0));
  if (videoEndpoint(m) === "/v1/videos") return [];
  const price=m.pricing_mode === "free" ? 0 : (m.price_per_call ?? 0)*(m.peak_pricing_enabled ? m.current_price_multiplier ?? 1 : 1);
  return Number.isFinite(price)&&price>=0 ? [{resolution:null,has_reference_video:null,unit:"call",price}] : [];
}
export function videoVariantKey(m: Offer, q: VideoQuote): string {
  return JSON.stringify([videoEndpoint(m),q.resolution,q.has_reference_video,q.unit]);
}
export function videoVariantLabel(q: VideoQuote): string {
  return q.resolution === null ? "成功任务次价" : q.resolution + (q.has_reference_video ? " · 有参考视频" : " · 无参考视频") + (q.unit === "second" ? " · 每秒" : " · 每次");
}
export function videoUnit(q: VideoQuote): string { return q.unit === "second" ? "/秒" : "/成功任务次"; }
export function videoMinimums(offers: Offer[]) {
  const values = new Map<string,{key:string;quote:VideoQuote;offers:Offer[]}>();
  for (const m of offers) for (const q of videoQuotes(m)) {
    const key=videoVariantKey(m,q), old=values.get(key);
    if (!old || q.price<old.quote.price) values.set(key,{key,quote:q,offers:[m]});
    else if (q.price===old.quote.price) old.offers.push(m);
  }
  return [...values.values()].sort((a,b)=>a.key.localeCompare(b.key));
}
export function videoSortPrice(offers: Offer[], variant: string): number | undefined {
  return videoMinimums(offers).find(v=>v.key===variant)?.quote.price;
}
