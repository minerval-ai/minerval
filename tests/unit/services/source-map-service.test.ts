import { describe, it, expect, vi, beforeEach } from "vitest";

// The source map service (#286) over a mocked DB: the mechanical quote
// check and the text reduction it runs on, the validation every write
// performs before it touches a table, the canonical ordering of symmetric
// source relations, and the counts the map row derives. The SQL itself
// runs live in tests/db/provenance-schema.test.ts.

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  getOrCreateSource: vi.fn(),
  fetchPublicUrl: vi.fn(),
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  getDb: () => {
    throw new Error("source-map-service must not use getDb");
  },
}));
vi.mock("../../../src/services/source-service.js", () => ({
  getOrCreateSource: mocks.getOrCreateSource,
}));
vi.mock("../../../src/services/url-guard.js", () => ({
  fetchPublicUrl: mocks.fetchPublicUrl,
}));

import {
  SourceMapError,
  htmlToText,
  looksLikeHtml,
  normalizeForQuoteCheck,
  quoteCheck,
  readSourceContent,
  recordInstanceReading,
  recordProvenanceEdge,
  recordSourceRelationship,
  writeSourceMap,
} from "../../../src/services/source-map-service.js";

const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";
const INSTANCE = "bbbbbbbb-0000-4000-8000-000000000001";
const SOURCE_A = "cccccccc-0000-4000-8000-00000000000a";
const SOURCE_B = "cccccccc-0000-4000-8000-00000000000b";
const SOURCE_C = "cccccccc-0000-4000-8000-00000000000c";

beforeEach(() => {
  mocks.rawQuery.mockReset().mockResolvedValue([]);
  mocks.getOrCreateSource.mockReset();
  mocks.fetchPublicUrl.mockReset();
});

/** Route the service's queries by the table they touch. */
function routeQueries(handlers: Array<[RegExp, (params: unknown[]) => unknown[]]>) {
  mocks.rawQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    return [];
  });
}

const instanceRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: INSTANCE,
  claim_id: CLAIM,
  source_id: SOURCE_A,
  verbatim_text: "Inflation rose 6.5 percent over the year.",
  raw_content: "<html><body><p>Inflation rose 6.5 percent over the year.</p></body></html>",
  ...overrides,
});

describe("htmlToText", () => {
  it("reduces markup to readable text and leaves plain text alone", () => {
    const html = `<!doctype html><html><head><title>T</title><style>p{}</style>
      <script>var x = 1;</script></head><body><h1>Head&amp;line</h1>
      <p>First&nbsp;para<br>with a break.</p><p>Second &#8220;para&#8221;.</p></body></html>`;
    expect(looksLikeHtml(html)).toBe(true);
    expect(htmlToText(html)).toBe("Head&line\n\nFirst para\nwith a break.\n\nSecond “para”.");
    expect(looksLikeHtml("Just some text with 3 < 4 in it.")).toBe(false);
    expect(htmlToText("line one  \r\nline two\r\n")).toBe("line one\nline two");
  });
});

describe("quoteCheck", () => {
  it("is mechanical: verbatim, then normalized, then not found, and never guesses without text", () => {
    expect(quoteCheck("anything", null)).toBe("no_stored_content");
    expect(quoteCheck("anything", "   ")).toBe("no_stored_content");
    expect(quoteCheck("rose 6.5 percent", "Inflation rose 6.5 percent over the year.")).toBe("verbatim");
    // Curly quotes, an em-dash, and doubled spaces do not defeat the check.
    expect(
      quoteCheck("“Inflation rose 6.5 percent”  -  over the year", "Inflation rose 6.5 percent — over the year.")
    ).toBe("normalized_match");
    expect(quoteCheck("rose 7.1 percent", "Inflation rose 6.5 percent over the year.")).toBe("not_found");
    expect(quoteCheck("", "some text")).toBe("not_found");
  });

  it("looks through markup in the stored copy", () => {
    expect(quoteCheck("First para with a break.", "<p>First&nbsp;para<br>with a break.</p>")).toBe(
      "normalized_match"
    );
    expect(quoteCheck("First para", "<p>First para</p>")).toBe("verbatim");
  });

  it("normalizes dashes, quotes, punctuation, case, and whitespace", () => {
    expect(normalizeForQuoteCheck("  “Hello”, — World!  ")).toBe("hello world");
    expect(normalizeForQuoteCheck("Naïve   café")).toBe("naïve café");
  });
});

describe("recordInstanceReading", () => {
  it("refuses an instance of another claim, an unknown support, and worth_reading without a reason", async () => {
    routeQueries([[/FROM claim_instances ci/, () => [instanceRow({ claim_id: "other" })]]]);
    await expect(
      recordInstanceReading({ claimId: CLAIM, instanceId: INSTANCE, support: "supports", createdBy: "claim_steward" })
    ).rejects.toThrow(/belongs to another claim/);

    routeQueries([[/FROM claim_instances ci/, () => [instanceRow()]]]);
    await expect(
      recordInstanceReading({ claimId: CLAIM, instanceId: INSTANCE, support: "true", createdBy: "claim_steward" })
    ).rejects.toThrow(/support must be one of/);
    await expect(
      recordInstanceReading({
        claimId: CLAIM,
        instanceId: INSTANCE,
        support: "supports",
        worthReading: true,
        createdBy: "claim_steward",
      })
    ).rejects.toThrow(/worth_reading_reason is required/);
    await expect(
      recordInstanceReading({ claimId: CLAIM, instanceId: "nope", support: "supports", createdBy: "claim_steward" })
    ).rejects.toThrow(SourceMapError);
  });

  it("computes the quote check from the stored text and upserts one reading per instance", async () => {
    const inserts: unknown[][] = [];
    routeQueries([
      [/FROM claim_instances ci/, () => [instanceRow()]],
      [
        /INSERT INTO claim_instance_readings/,
        (params) => {
          inserts.push(params);
          return [{ id: "reading-1", inserted: false }];
        },
      ],
    ]);
    const result = await recordInstanceReading({
      claimId: CLAIM,
      instanceId: INSTANCE,
      support: "overstates",
      deployment: "  background  ",
      note: "The report restates the release.",
      sourceRead: true,
      model: "m",
      createdBy: "claim_steward",
    });
    expect(result).toEqual({ id: "reading-1", quote_check: "verbatim", replaced: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual([
      INSTANCE,
      "overstates",
      "background",
      "The report restates the release.",
      "verbatim",
      false,
      null,
      true,
      "m",
      "claim_steward",
    ]);
  });

  it("reports no_stored_content when the graph holds no text for the source", async () => {
    routeQueries([
      [/FROM claim_instances ci/, () => [instanceRow({ raw_content: null })]],
      [/INSERT INTO claim_instance_readings/, () => [{ id: "r", inserted: true }]],
    ]);
    const result = await recordInstanceReading({
      claimId: CLAIM,
      instanceId: INSTANCE,
      support: "unclear",
      createdBy: "claim_steward",
    });
    expect(result.quote_check).toBe("no_stored_content");
    expect(result.replaced).toBe(false);
  });
});

describe("recordProvenanceEdge", () => {
  const base = {
    claimId: CLAIM,
    fromInstanceId: INSTANCE,
    relationType: "derives_from",
    fidelity: "strengthened",
    evidence: "“as the study found” (para 3)",
    reasoning: "It reports the study's finding without its qualification.",
    createdBy: "claim_steward",
  };

  it("requires the located passage, a known relation and fidelity, and a target", async () => {
    routeQueries([[/FROM claim_instances ci/, () => [instanceRow()]]]);
    await expect(recordProvenanceEdge({ ...base, toSourceId: SOURCE_B, evidence: " " })).rejects.toThrow(
      /evidence is required/
    );
    await expect(
      recordProvenanceEdge({ ...base, toSourceId: SOURCE_B, relationType: "cites" })
    ).rejects.toThrow(/relation_type must be one of/);
    await expect(
      recordProvenanceEdge({ ...base, toSourceId: SOURCE_B, fidelity: "true" })
    ).rejects.toThrow(/fidelity must be one of/);
    await expect(recordProvenanceEdge({ ...base })).rejects.toThrow(/to_source_id .* or to_source_url/);
    await expect(recordProvenanceEdge({ ...base, toSourceId: SOURCE_B, confidence: 3 })).rejects.toThrow(
      /between 0 and 1/
    );
    await expect(recordProvenanceEdge({ ...base, toSourceUrl: "ftp://x" })).rejects.toThrow(/http\(s\)/);
  });

  it("refuses a target that is the asserting source itself, or a source id that does not exist", async () => {
    routeQueries([
      [/FROM claim_instances ci/, () => [instanceRow()]],
      [/SELECT id FROM sources WHERE id = \$1/, (params) => (params[0] === SOURCE_A ? [{ id: SOURCE_A }] : [])],
    ]);
    await expect(recordProvenanceEdge({ ...base, toSourceId: SOURCE_A })).rejects.toThrow(/its own document/);
    await expect(recordProvenanceEdge({ ...base, toSourceId: SOURCE_B })).rejects.toThrow(/No source .* exists/);
  });

  it("links the upstream instance when the target also asserts the claim, and upserts on the unique key", async () => {
    const inserts: unknown[][] = [];
    routeQueries([
      [/FROM claim_instances ci/, () => [instanceRow()]],
      [/SELECT id FROM sources WHERE id = \$1/, () => [{ id: SOURCE_B }]],
      [/SELECT id FROM claim_instances WHERE claim_id = \$1 AND source_id = \$2/, () => [{ id: "inst-up" }]],
      [
        /INSERT INTO claim_provenance_edges/,
        (params) => {
          inserts.push(params);
          return [{ id: "edge-1", inserted: true }];
        },
      ],
    ]);
    const result = await recordProvenanceEdge({ ...base, toSourceId: SOURCE_B, confidence: 0.8, targetRead: true });
    expect(result).toEqual({ id: "edge-1", to_source_id: SOURCE_B, to_instance_id: "inst-up", replaced: false });
    expect(inserts[0]).toEqual([
      INSTANCE,
      SOURCE_B,
      "inst-up",
      "derives_from",
      "strengthened",
      base.evidence,
      base.reasoning,
      0.8,
      true,
      "claim_steward",
    ]);
  });

  it("creates the target source from a URL without enqueueing extraction, and defaults fidelity to unclear", async () => {
    mocks.getOrCreateSource.mockResolvedValue({ id: SOURCE_C, url: "https://x.example/study", title: "Study" });
    const inserts: unknown[][] = [];
    routeQueries([
      [/FROM claim_instances ci/, () => [instanceRow()]],
      [
        /INSERT INTO claim_provenance_edges/,
        (params) => {
          inserts.push(params);
          return [{ id: "edge-2", inserted: true }];
        },
      ],
    ]);
    const result = await recordProvenanceEdge({
      ...base,
      fidelity: null,
      toSourceUrl: "https://x.example/study",
      toSourceTitle: "Study",
    });
    expect(mocks.getOrCreateSource).toHaveBeenCalledWith({ url: "https://x.example/study", title: "Study" });
    expect(result.to_source_id).toBe(SOURCE_C);
    expect(result.to_instance_id).toBeNull();
    expect(inserts[0]![4]).toBe("unclear");
    expect(inserts[0]![8]).toBe(false);
  });
});

describe("recordSourceRelationship", () => {
  it("stores a symmetric relation with the smaller id first, and refuses self-relations and unknown sources", async () => {
    const inserts: unknown[][] = [];
    routeQueries([
      [/SELECT id FROM sources WHERE id = \$1 OR id = \$2/, () => [{ id: SOURCE_A }, { id: SOURCE_B }]],
      [
        /INSERT INTO source_relationships/,
        (params) => {
          inserts.push(params);
          return [{ id: "rel-1", inserted: true }];
        },
      ],
    ]);
    const result = await recordSourceRelationship({
      parentSourceId: SOURCE_B,
      childSourceId: SOURCE_A,
      relationType: "shares_authorship",
      reasoning: "Same byline.",
      createdBy: "claim_steward",
    });
    expect(result.parent_source_id).toBe(SOURCE_A);
    expect(result.child_source_id).toBe(SOURCE_B);
    expect(inserts[0]!.slice(0, 3)).toEqual([SOURCE_A, SOURCE_B, "shares_authorship"]);

    // A directed relation keeps the order it was given.
    inserts.length = 0;
    await recordSourceRelationship({
      parentSourceId: SOURCE_B,
      childSourceId: SOURCE_A,
      relationType: "version_of",
      reasoning: "Published version of the preprint.",
      createdBy: "claim_steward",
    });
    expect(inserts[0]!.slice(0, 2)).toEqual([SOURCE_B, SOURCE_A]);

    await expect(
      recordSourceRelationship({
        parentSourceId: SOURCE_A,
        childSourceId: SOURCE_A,
        relationType: "republishes",
        reasoning: "x",
        createdBy: "claim_steward",
      })
    ).rejects.toThrow(/related to itself/);

    routeQueries([[/SELECT id FROM sources WHERE id = \$1 OR id = \$2/, () => [{ id: SOURCE_A }]]]);
    await expect(
      recordSourceRelationship({
        parentSourceId: SOURCE_A,
        childSourceId: SOURCE_B,
        relationType: "republishes",
        reasoning: "x",
        createdBy: "claim_steward",
      })
    ).rejects.toThrow(/must already exist/);
  });
});

describe("writeSourceMap", () => {
  it("holds the summary to the graph's voice and derives the counts from the tables", async () => {
    await expect(
      writeSourceMap({ claimId: CLAIM, summary: "One source — restated.", material: true, mappedBy: "claim_steward" })
    ).rejects.toThrow(/no em-dashes/);
    await expect(
      writeSourceMap({ claimId: CLAIM, summary: `See ${SOURCE_A}.`, material: true, mappedBy: "claim_steward" })
    ).rejects.toThrow(/never by identifier/);
    await expect(
      writeSourceMap({ claimId: CLAIM, summary: "", material: false, mappedBy: "claim_steward" })
    ).rejects.toThrow(/summary is required/);

    const inserts: unknown[][] = [];
    routeQueries([
      [/AS sources_considered/, () => [{ sources_considered: "4", sources_read: "2", edges_recorded: "3" }]],
      [
        /INSERT INTO claim_source_maps/,
        (params) => {
          inserts.push(params);
          return [{ id: "map-1", inserted: false }];
        },
      ],
    ]);
    const result = await writeSourceMap({
      claimId: CLAIM,
      summary: "Much of the support traces to one reanalysis.",
      material: true,
      model: "m",
      mappedBy: "claim_steward",
    });
    expect(result).toEqual({ id: "map-1", sources_considered: 4, sources_read: 2, edges_recorded: 3, replaced: true });
    expect(inserts[0]).toEqual([
      CLAIM,
      "Much of the support traces to one reanalysis.",
      true,
      4,
      2,
      3,
      "m",
      "claim_steward",
    ]);
  });
});

describe("readSourceContent", () => {
  const stored = {
    id: SOURCE_A,
    url: "https://x.example/a",
    title: "A",
    source_type: "unknown",
    raw_content: "<p>" + "word ".repeat(30) + "</p>",
  };

  it("windows the stored text and says how to continue", async () => {
    routeQueries([[/FROM sources WHERE id = \$1/, () => [stored]]]);
    const first = await readSourceContent({ sourceId: SOURCE_A, maxChars: 50 });
    expect(first.origin).toBe("stored");
    expect(first.content).toHaveLength(50);
    expect(first.truncated).toBe(true);
    expect(first.total_chars).toBe(149);
    const rest = await readSourceContent({ sourceId: SOURCE_A, offset: 50, maxChars: 500 });
    expect(rest.offset).toBe(50);
    expect(rest.truncated).toBe(false);
    expect(first.content + rest.content).toBe("word ".repeat(30).trim());
    expect(mocks.fetchPublicUrl).not.toHaveBeenCalled();
  });

  it("fetches and stores a copy when the graph holds none, and creates a source for a new URL", async () => {
    const updates: unknown[][] = [];
    routeQueries([
      [/FROM sources WHERE url = \$1/, () => []],
      [
        /UPDATE sources SET raw_content/,
        (params) => {
          updates.push(params);
          return [];
        },
      ],
    ]);
    mocks.getOrCreateSource.mockResolvedValue({
      id: SOURCE_C,
      url: "https://x.example/new",
      title: "https://x.example/new",
      sourceType: "unknown",
      rawContent: null,
    });
    mocks.fetchPublicUrl.mockResolvedValue("<html><body><p>Fresh text.</p></body></html>");
    const result = await readSourceContent({ url: "https://x.example/new" });
    expect(mocks.getOrCreateSource).toHaveBeenCalledWith({ url: "https://x.example/new" });
    expect(result.origin).toBe("fetched");
    expect(result.content).toBe("Fresh text.");
    expect(updates[0]).toEqual([SOURCE_C, "<html><body><p>Fresh text.</p></body></html>"]);
  });

  it("refuses an unknown source id and a source with neither text nor URL", async () => {
    routeQueries([[/FROM sources WHERE id = \$1/, () => []]]);
    await expect(readSourceContent({ sourceId: SOURCE_A })).rejects.toThrow(/No source .* exists/);
    routeQueries([[/FROM sources WHERE id = \$1/, () => [{ ...stored, url: null, raw_content: null }]]]);
    await expect(readSourceContent({ sourceId: SOURCE_A })).rejects.toThrow(/no stored text and no URL/);
    await expect(readSourceContent({})).rejects.toThrow(/source_id or a url/);
  });
});
