import { describe, it, expect, vi, beforeEach } from "vitest";
import { pageUrlHash } from "../../../src/services/page-url.js";

/**
 * A source row can exist with no content before anyone submits the document
 * (the Steward records cited URLs as sources). Submitting the document later
 * must fill the row in, or the extraction worker re-fetches a URL the caller
 * already had the text for — which is how a committed blackholes corpus post
 * was lost to an arxiv 403.
 */
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  existing: [] as Row[],
  updates: [] as Row[],
  inserts: [] as Row[],
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => state.existing }) }),
    }),
    update: () => ({
      set: (values: Row) => {
        state.updates.push(values);
        return {
          where: () => ({
            returning: async () => [{ ...(state.existing[0] ?? {}), ...values }],
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: Row) => {
        state.inserts.push(values);
        return { returning: async () => [{ id: "new", ...values }] };
      },
    }),
  }),
}));

import { getOrCreateSource } from "../../../src/services/source-service.js";

beforeEach(() => {
  state.existing = [];
  state.updates = [];
  state.inserts = [];
});

describe("getOrCreateSource", () => {
  it("fills in a content-less existing row when the submission carries content", async () => {
    state.existing = [
      { id: "s1", url: "https://arxiv.org/abs/0806.3381", title: "https://arxiv.org/abs/0806.3381", rawContent: null },
    ];
    const row = await getOrCreateSource({
      url: "https://arxiv.org/abs/0806.3381",
      title: "Astrophysical implications of hypothetical stable TeV-scale black holes",
      content: "# The paper\n…",
    });
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toEqual([
      {
        rawContent: "# The paper\n…",
        title: "Astrophysical implications of hypothetical stable TeV-scale black holes",
      },
    ]);
    expect(row.rawContent).toBe("# The paper\n…");
  });

  it("leaves an existing row with content alone", async () => {
    state.existing = [{ id: "s1", url: "u", title: "Real title", rawContent: "old text" }];
    const row = await getOrCreateSource({ url: "u", title: "Other", content: "new text" });
    expect(state.updates).toHaveLength(0);
    expect(row.rawContent).toBe("old text");
  });

  it("keeps a real title when only content was missing", async () => {
    state.existing = [{ id: "s1", url: "u", title: "Kept", rawContent: null }];
    await getOrCreateSource({ url: "u", title: "Other", content: "text" });
    expect(state.updates).toEqual([{ rawContent: "text" }]);
  });

  it("creates the row when none exists", async () => {
    const row = await getOrCreateSource({ url: "u", title: "T", content: "c" });
    // "u" is no web page, so its page hash is the empty marker.
    expect(state.inserts).toEqual([{ url: "u", title: "T", rawContent: "c", pageUrlHash: "" }]);
    expect(row.id).toBe("new");
  });

  it("gives a new web page's row the hash the extension looks it up by", async () => {
    await getOrCreateSource({ url: "http://www.example.org/post/?utm_source=x#top" });
    expect(state.inserts[0]).toMatchObject({
      pageUrlHash: pageUrlHash("https://example.org/post"),
    });
  });
});
