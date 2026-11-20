const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "刚刚", "5 分钟前", "3 小时前", "2 天前", or the date for anything older than 30 days. */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return Math.floor(diff / MINUTE) + " 分钟前";
  if (diff < DAY) return Math.floor(diff / HOUR) + " 小时前";
  if (diff < 30 * DAY) return Math.floor(diff / DAY) + " 天前";
  return new Date(ms).toLocaleDateString();
}
