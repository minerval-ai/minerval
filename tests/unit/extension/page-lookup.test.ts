import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The page lookup asks one prefix bucket and fetches only what it lists for
 * this page: another reader's shared analysis, the graph's own record of a
 * page it read as a source, both, or (for nearly every page) nothing, so the
 * server never hears the page's full hash unless it already holds the page.
 */

vi.mock("../../../extension/lib/settings", () => ({
  getSettings: async () => ({ apiBaseUrl: "https://api.example", apiKey: "secret" }),
  isCustomApiBaseUrl: () => true,
}));

const hashOf = (prefix: string, fill: string) => prefix + fill.repeat(64 - prefix.length);

function serve(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const path = url.replace("https://api.example", "");
    return path in routes
      ? new Response(JSON.stringify(routes[path]), { status: 200 })
      : new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("lookupPage", () => {
  it("fetches the graph's record of a page it read, with no analysis and no API key", async () => {
    const hash = hashOf("ab12", "c");
    const recorded = { sources: [], passages: [{ verbatim_text: "A passage." }], total: 1 };
    const fetchMock = serve({
      "/extension/shared?prefix=ab12": { hashes: [], recorded: [hash] },
      [`/extension/recorded/${hash}`]: recorded,
    });
    const { lookupPage } = await import("../../../extension/lib/api");

    expect(await lookupPage(hash)).toEqual({ analysis: null, recorded });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://api.example/extension/shared?prefix=ab12",
      `https://api.example/extension/recorded/${hash}`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.stringify(init ?? {})).not.toContain("secret");
    }
  });

  it("fetches both when the page was shared and read, and nothing past the bucket otherwise", async () => {
    const both = hashOf("cd34", "e");
    const neither = hashOf("cd34", "f");
    const fetchMock = serve({
      "/extension/shared?prefix=cd34": { hashes: [both], recorded: [both] },
      [`/extension/shared/${both}`]: { shared: true, annotations: [] },
      [`/extension/recorded/${both}`]: { sources: [], passages: [], total: 0 },
    });
    const { lookupPage } = await import("../../../extension/lib/api");

    const found = await lookupPage(both);
    expect(found.analysis).toMatchObject({ shared: true });
    expect(found.recorded).not.toBeNull();

    fetchMock.mockClear();
    // The bucket is remembered, so a page it does not list costs no request.
    expect(await lookupPage(neither)).toEqual({ analysis: null, recorded: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads an older API's bucket, which lists no recorded pages", async () => {
    const hash = hashOf("ef56", "0");
    serve({ "/extension/shared?prefix=ef56": { hashes: [] } });
    const { lookupPage } = await import("../../../extension/lib/api");
    expect(await lookupPage(hash)).toEqual({ analysis: null, recorded: null });
  });
});
