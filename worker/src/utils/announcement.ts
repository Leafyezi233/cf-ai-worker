
export type AnnouncementLevel = "info" | "warning" | "danger";

export interface AnnouncementConfig {
  enabled: boolean;
  level: AnnouncementLevel;
  title: string;
  message: string;
  updated_at: number | null;
}

export const ANNOUNCEMENT_MAX_TITLE = 120;
export const ANNOUNCEMENT_MAX_MESSAGE = 2000;

export const ANNOUNCEMENT_LEVELS: readonly AnnouncementLevel[] = ["info", "warning", "danger"];

export const ANNOUNCEMENT_SETTING_KEY = "announcement_config";

export const EMPTY_ANNOUNCEMENT: AnnouncementConfig = {
  enabled: false,
  level: "info",
  title: "",
  message: "",
  updated_at: null,
};

export function isAnnouncementLevel(v: unknown): v is AnnouncementLevel {
  return typeof v === "string" && (ANNOUNCEMENT_LEVELS as readonly string[]).includes(v);
}

export function normalizeAnnouncement(raw: unknown): AnnouncementConfig {
  if (!raw || typeof raw !== "object") return { ...EMPTY_ANNOUNCEMENT };
  const cfg = raw as Partial<Record<keyof AnnouncementConfig, unknown>>;
  return {
    enabled: Boolean(cfg.enabled),
    level: isAnnouncementLevel(cfg.level) ? cfg.level : "info",
    title: typeof cfg.title === "string" ? cfg.title : "",
    message: typeof cfg.message === "string" ? cfg.message : "",
    updated_at: typeof cfg.updated_at === "number" && Number.isFinite(cfg.updated_at) ? cfg.updated_at : null,
  };
}
