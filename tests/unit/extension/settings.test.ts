import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Users never see or set the API base URL: it is the hosted API unless a
 * developer overrides it. Only an override is stored, so a default saved
 * alongside other settings can't freeze in, and the old localhost default
 * that pre-v2 installs saved is dropped on read.
 */

let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(store, items),
        remove: async (key: string) => void delete store[key],
        onChanged: { addListener: () => {} },
      },
    },
  });
});

const { getSettings, saveSettings } = await import("../../../extension/lib/settings");
const HOSTED = "https://api.claimgraph.io";

describe("extension API base URL", () => {
  it("defaults to the hosted API", async () => {
    expect((await getSettings()).apiBaseUrl).toBe(HOSTED);
  });

  it("does not store the default when other settings are saved", async () => {
    await saveSettings({ apiKey: "epk_x" });
    expect(store["minerval-settings"]).not.toHaveProperty("apiBaseUrl");
    expect((await getSettings()).apiBaseUrl).toBe(HOSTED);
  });

  it("keeps a developer's override, localhost included", async () => {
    await saveSettings({ apiBaseUrl: "http://localhost:3000" });
    expect((await getSettings()).apiBaseUrl).toBe("http://localhost:3000");
  });

  it("goes back to the hosted API when the override is cleared", async () => {
    await saveSettings({ apiBaseUrl: "http://localhost:3000" });
    await saveSettings({ apiBaseUrl: "" });
    expect((await getSettings()).apiBaseUrl).toBe(HOSTED);
  });

  it("drops the old localhost default saved by pre-v2 installs", async () => {
    store["minerval-settings"] = { apiBaseUrl: "http://localhost:3000", apiKey: "epk_x" };
    const s = await getSettings();
    expect(s.apiBaseUrl).toBe(HOSTED);
    expect(s.apiKey).toBe("epk_x");
  });
});
