export const SETTINGS_TABS = [
  { id: "general", label: "公告与预算", sections: ["announcement", "budget", "webhook"] },
  { id: "security", label: "安全", sections: ["access", "keys"] },
  { id: "data", label: "备份与维护", sections: ["snapshots", "retention", "cache"] },
  { id: "developer", label: "接入资料", sections: ["openapi", "sdk"] },
] as const satisfies readonly { id: string; label: string; sections: readonly string[] }[];

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

export function settingsTabFor(value: string | null): SettingsTabId {
  return SETTINGS_TABS.find(t => t.id === value)?.id ?? SETTINGS_TABS[0].id;
}

export function readTabParam(): string | null {
  try { return new URLSearchParams(window.location.search).get("tab"); } catch { return null; }
}

export function writeTabParam(id: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("tab", id); else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch { /* non-browser render */ }
}
