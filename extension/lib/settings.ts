import {
  DEFAULT_API_BASE_URL,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_API_BASE_URL,
  type Settings,
  type SitePolicy,
} from "./types";

const KEY = "minerval-settings";
// The pre-rebrand storage key (#311). Read when KEY is absent so an existing
// install keeps its API key and site policies; the first save moves them over.
const LEGACY_KEY = "episteme-settings";

/**
 * Storage version. v1 (unmarked) saved every field, the API base URL
 * included, so a default was frozen in on the first save. v2 stores the base
 * URL only when a developer overrode it.
 */
const VERSION = 2;

type Stored = Partial<Settings> & { v?: number };

/** Stored settings over the defaults, with a stale or blank base URL dropped. */
function fromStored(stored: Stored | undefined): Settings {
  const { v, ...rest } = stored ?? {};
  const base = rest.apiBaseUrl?.trim();
  if (!base || (v === undefined && base === LEGACY_DEFAULT_API_BASE_URL)) {
    delete rest.apiBaseUrl;
  }
  return { ...DEFAULT_SETTINGS, ...rest };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get([KEY, LEGACY_KEY]);
  return fromStored((stored[KEY] ?? stored[LEGACY_KEY]) as Stored | undefined);
}

/** True when the base URL is a developer's override, not the hosted API. */
export function isCustomApiBaseUrl(settings: Settings): boolean {
  return settings.apiBaseUrl.replace(/\/$/, "") !== DEFAULT_API_BASE_URL;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = fromStored({ ...current, ...patch, v: VERSION });
  const { apiBaseUrl, ...rest } = next;
  await chrome.storage.sync.set({
    [KEY]: {
      ...rest,
      ...(isCustomApiBaseUrl(next) ? { apiBaseUrl } : {}),
      v: VERSION,
    },
  });
  await chrome.storage.sync.remove(LEGACY_KEY);
  return next;
}

export function onSettingsChanged(fn: (s: Settings) => void): void {
  chrome.storage.sync.onChanged.addListener((changes) => {
    if (changes[KEY]) {
      fn(fromStored(changes[KEY].newValue as Stored | undefined));
    }
  });
}
export async function setSitePolicy(
  host: string,
  policy: SitePolicy
): Promise<Settings> {
  const current = await getSettings();
  const overrides = { ...current.siteOverrides };
  if (policy === "default") delete overrides[host];
  else overrides[host] = policy;
  return saveSettings({ siteOverrides: overrides });
}

/** Effective behavior for a host, resolving "default" to the global setting. */
export function resolveSitePolicy(
  settings: Settings,
  host: string
): "auto" | "manual" | "disabled" {
  const override = settings.siteOverrides[host] ?? "default";
  if (override !== "default") return override;
  return settings.autoAnalyze ? "auto" : "manual";
}
