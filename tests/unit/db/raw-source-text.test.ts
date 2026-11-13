/**
 * Where a source's stored text can leave (src/raw-sources.ts).
 *
 * Opening raw sources is a permission of its own, and the database cannot
 * hold it: the text is a column of the source's own row. It is held at each
 * place the text is returned to a person, so the list of those places has
 * to stay whole. These checks read the code for every reader of the stored
 * text and fail when one appears that nobody has looked at:
 *
 *  - no read-only SQL view selects it;
 *  - no route and no MCP tool reads it for itself: they go through the
 *    services, which are the reviewed list below;
 *  - every agent tool that returns it is named in
 *    TOOLS_RETURNING_SOURCE_TEXT, so a run's log withholds it from a reader
 *    who may not open sources.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_INPUTS,
  AGENTS_GIVEN_SOURCE_TEXT,
  TOOL_READS,
  TOOLS_RETURNING_SOURCE_TEXT,
  returnsSourceText,
} from "../../../src/llm/run-visibility.js";
import { withholdSourceText } from "../../../src/services/run-view-service.js";
import { mayOpenRawSources, withheldRunSourceText, withheldSourceText } from "../../../src/raw-sources.js";

const SRC = join(__dirname, "../../../src");
const STORED_TEXT = /raw_content|rawContent\b|readSourceContent|getExaminationOutline|getSourceDocument/;

function filesUnder(dir: string): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => `${dir}/${e.name}`)
    .sort();
}

const mentioning = (dir: string, pattern: RegExp) =>
  filesUnder(dir).filter((file) => pattern.test(readFileSync(join(SRC, file), "utf8")));

describe("a source's stored text", () => {
  it("is in no read-only SQL view", () => {
    const migrations = readdirSync(join(SRC, "db/migrations")).filter((f) => f.endsWith(".sql"));
    const offenders: string[] = [];
    for (const file of migrations) {
      const sql = readFileSync(join(SRC, "db/migrations", file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (/VIEW\s+"?public_read"?\./i.test(statement) && /raw_content/i.test(statement)) offenders.push(file);
      }
    }
    expect(
      offenders,
      "a public_read view that returns a source's text must withhold it from a reader without read_sources (src/raw-sources.ts)"
    ).toEqual([]);
  });

  it("is read by the reviewed services and by no route or MCP module directly", () => {
    // Each of these was read for what it does with the text. Returned to a
    // person: source-segment-service (the document view, which withholds).
    // Used and not returned: the rest (facts parsed from the page, a quote
    // checked against it, its length, whether there is any). Two belong to
    // the showing of a page: release-gate-service writes the page as shown
    // into a new source's text and returns none, and showing-service hands a
    // Redactor a window of a source its page drew on, through a tool named
    // below. published-page-service writes a published page's text into a
    // new source when its package is admitted, and returns none.
    // reading-service writes a kept reading's text into a new source and
    // returns none of it: a run reads a reading's stored result through
    // open_reading, named below. analysis-service does the same for a kept
    // analysis and a kept file: the output a run reads comes through
    // run_command and open_output, named below.
    expect(mentioning("services", /raw_content|rawContent\b/)).toEqual([
      "services/analysis-service.ts",
      "services/examination-service.ts",
      "services/published-page-service.ts",
      "services/reading-service.ts",
      "services/release-gate-service.ts",
      "services/showing-service.ts",
      "services/source-content.ts",
      "services/source-context-service.ts",
      "services/source-facts-service.ts",
      "services/source-map-service.ts",
      "services/source-segment-service.ts",
      "services/source-service.ts",
    ]);
    expect(mentioning("mcp", STORED_TEXT)).toEqual([]);
    // The one route that serves a document, and it passes the reader's permission.
    expect(mentioning("routes", STORED_TEXT)).toEqual(["routes/sources.ts"]);
    expect(readFileSync(join(SRC, "routes/sources.ts"), "utf8")).toMatch(
      /getSourceDocument\(request\.params\.source_id, \{\s*rawSourceLabels: rawSourceLabelsOf\(request\.auth\)/
    );
  });

  it("is returned to agents by tools that are all named, so a run's log can withhold it", () => {
    // The tool files that read stored text, and the tools in them that hand it back.
    expect(mentioning("llm/tools", STORED_TEXT)).toEqual(["llm/tools/governance-tools.ts", "llm/tools/provenance-tools.ts"]);
    for (const tool of Object.keys(TOOLS_RETURNING_SOURCE_TEXT)) expect(tool in TOOL_READS, tool).toBe(true);
    for (const agent of Object.keys(AGENTS_GIVEN_SOURCE_TEXT)) expect(agent in AGENT_INPUTS, agent).toBe(true);
    expect(Object.keys(TOOLS_RETURNING_SOURCE_TEXT).sort()).toEqual([
      "examination_outline",
      "get_contribution_details",
      "get_page_to_redact",
      "open_output",
      "open_reading",
      "provenance_read_source",
      "run_command",
    ]);
    // A connection's own tools are named by an administrator's prefix and a
    // server, so they are known by the shape of the name.
    expect(returnsSourceText("warehouse__run_query")).toBe(true);
    expect(returnsSourceText("open_reading")).toBe(true);
    expect(returnsSourceText("keep_reading")).toBe(false);
    expect(returnsSourceText("search_claims")).toBe(false);
    const notice = withheldRunSourceText("internal", ["internal"]);
    expect(
      withholdSourceText("claim_steward", "tool_results", [
        { name: "warehouse__run_query", output: "rows" },
        { name: "keep_reading", output: "kept" },
      ], notice)
    ).toEqual([
      { name: "warehouse__run_query", output: notice },
      { name: "keep_reading", output: "kept" },
    ]);
  });
});

describe("the permission", () => {
  it("opens public sources to everyone, and another label's only to a holder at that label", () => {
    expect(mayOpenRawSources(null, "internal")).toBe(true);
    expect(mayOpenRawSources(["public"], "public")).toBe(true);
    expect(mayOpenRawSources(["public"], "internal")).toBe(false);
    expect(mayOpenRawSources(["public", "internal"], "internal")).toBe(true);
    expect(mayOpenRawSources(["public", "restricted"], "internal")).toBe(false);
  });

  it("says what is withheld and which permission opens it", () => {
    expect(withheldSourceText("internal")).toEqual({
      withheld: "source_text",
      permission: "read_sources",
      labels: ["internal"],
      message:
        'The text of this source is withheld. Opening it takes the permission to open raw sources at the label "internal", ' +
        "which this account does not hold. An administrator of this deployment grants it. What the agents recorded from " +
        "the source is shown: the passages they quoted and how they read them.",
    });
    expect(withheldRunSourceText("restricted", ["internal", "restricted"]).message).toBe(
      'This part of the run\'s log holds text taken from sources, and it is withheld. The run worked at the label "restricted" ' +
        "and could open sources at every label that one reads, so reading this takes the permission to open raw sources at " +
        'each of them. This account does not hold it at "internal" and "restricted". An administrator of this deployment ' +
        "grants it. The rest of the log is shown, and the step's hash is the hash of the step as it was recorded."
    );
  });
});

describe("a step of a run's log, for a reader who may not open sources", () => {
  const notice = withheldRunSourceText("internal", ["internal"]);

  it("withholds the output of a tool that returns source text and nothing else in the step", () => {
    const step = [
      { name: "provenance_read_source", input: { source_id: "s" }, output: "the document" },
      { name: "get_claim", input: { claim_id: "c" }, output: "the claim" },
    ];
    expect(withholdSourceText("steward", "tool_results", step, notice)).toEqual([
      { name: "provenance_read_source", input: { source_id: "s" }, output: notice },
      { name: "get_claim", input: { claim_id: "c" }, output: "the claim" },
    ]);
  });

  it("withholds the opening message of an agent that is handed a document, and keeps its setup", () => {
    const prompt = { model: "m", tools: [{ name: "record_claims" }], setup: { parts: [] }, initialMessages: [{ role: "user", content: "the document" }] };
    expect(withholdSourceText("extractor", "prompt", prompt, notice)).toEqual({ ...prompt, initialMessages: notice });
    const completion = { model: "m", messages: [{ role: "user", content: "the document" }], output: "domains" };
    expect(withholdSourceText("extractor", "completion", completion, notice)).toEqual({ ...completion, messages: notice });
    // Another agent's prompt holds no document.
    expect(withholdSourceText("steward", "prompt", prompt, notice)).toBe(prompt);
  });

  it("leaves what the agent wrote as it was", () => {
    const said = { content: [{ type: "text", text: "The memo says 4,112 units." }], stopReason: "end_turn" };
    expect(withholdSourceText("extractor", "assistant", said, notice)).toBe(said);
  });
});
