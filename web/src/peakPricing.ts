
export const DAY_LABELS: Record<string, string> = {
  mon: "周一",
  tue: "周二",
  wed: "周三",
  thu: "周四",
  fri: "周五",
  sat: "周六",
  sun: "周日",
  weekday: "工作日",
  weekend: "周末",
};

export function minuteToHHMM(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  const h = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return h + ":" + mm;
}

export function tzLabel(tzOffsetMinutes: number): string {
  const sign = tzOffsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(tzOffsetMinutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return "UTC" + sign + h + ":" + m;
}

export function formatMultiplier(multiplier: number): string {
  if (!Number.isFinite(multiplier)) return "×1";
  if (multiplier === 0) return "免费";
  return "×" + String(Number(multiplier.toFixed(2)));
}

export interface BandLike {
  day_type: string;
  start_minute: number;
  end_minute: number;
  multiplier: number;
}

export function describeBand(band: BandLike): string {
  const day = DAY_LABELS[band.day_type] || band.day_type;
  const start = minuteToHHMM(band.start_minute);
  const end = band.end_minute >= 1440 ? "24:00" : minuteToHHMM(band.end_minute);
  return `${day} ${start}-${end} ${formatMultiplier(band.multiplier)}`;
}

export function summarizeBands(bands: BandLike[] | null | undefined): string {
  if (!bands || !bands.length) return "未配置任何时段";
  return bands.map(describeBand).join("；");
}
