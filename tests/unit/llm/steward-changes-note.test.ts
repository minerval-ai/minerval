import { describe, it, expect, vi } from "vitest";

/**
 * What a Steward is told about what has changed under the judgment it is
 * revisiting (#566): the facts, the cap on what is listed, and nothing that
 * tells it what to conclude.
 */

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import {
  CHANGES_NAMED_PER_LIST,
  changesSinceJudgedNote,
  loadChangesSinceJudgedNote,
  namedInChangesNote,
} from "../../../src/llm/agents/steward-changes-note.js";
import type { JudgmentInputsView } from "../../../src/services/judgment-inputs-service.js";
import { rawQuery } from "../../../src/db/client.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NO_NAMES = { nodes: new Map<string, string>(), sources: new Map<string, string>() };

function view(over: Partial<JudgmentInputsView> = {}): JudgmentInputsView {
  return {
    node_id: id(1),
    judgment: { kind: "assessment", id: id(2), assessed_at: "2026-10-02T09:30:00.000Z" },
    recorded: true,
    premises: [],
    premises_added: [],
    sources: { recorded: 0, added: [], removed: [], events_since: [] },
    changed: false,
    ...over,
  };
}

describe("the Steward's note on what changed since the judgment", () => {
  it("says nothing for a node with no judgment in force", () => {
    expect(changesSinceJudgedNote("claim", null, NO_NAMES)).toBe("");
    expect(changesSinceJudgedNote("claim", view({ judgment: null, recorded: false, changed: null }), NO_NAMES)).toBe("");
  });

  it("says in one line that a judgment predates the record, and does not call it unchanged", () => {
    const note = changesSinceJudgedNote("claim", view({ recorded: false, changed: null }), NO_NAMES);
    expect(note.split("\n")).toHaveLength(1);
    expect(note).toContain("2026-10-02");
    expect(note).toContain("no record of what has changed");
    expect(note).not.toMatch(/nothing .* has changed/);
  });

  it("says in one line that nothing changed, for each kind of node", () => {
    for (const kind of ["claim", "quantity", "question"] as const) {
      const note = changesSinceJudgedNote(kind, view(), NO_NAMES);
      expect(note.split("\n")).toHaveLength(1);
      expect(note).toContain("Since the current assessment was recorded on 2026-10-02, nothing");
      expect(note).toContain(`the nodes under this ${kind}`);
    }
  });

  it("lists each kind of change by id and text, and only the kinds that happened", () => {
    const v = view({
      changed: true,
      premises: [
        { node_id: id(10), relation: "requires", judged_against: id(90), in_force_now: id(91), state: "rejudged" },
        { node_id: id(11), relation: "supports", judged_against: null, in_force_now: id(92), state: "rejudged" },
        { node_id: id(12), relation: "requires", judged_against: id(93), in_force_now: id(93), state: "unchanged" },
        { node_id: id(13), relation: "contradicts", judged_against: id(94), in_force_now: null, state: "removed" },
      ],
      premises_added: [{ node_id: id(14), relation: "supports", in_force_now: null }],
      sources: {
        recorded: 2,
        added: [id(20)],
        removed: [],
        events_since: [{ source_id: id(21), kind: "expression_of_concern", detected_at: "2026-10-20T00:00:00.000Z" }],
      },
    });
    const note = changesSinceJudgedNote("claim", v, {
      nodes: new Map([
        [id(10), "The trial was randomized"],
        [id(11), "Dropout was balanced across arms"],
        [id(13), "The effect is an artifact"],
        [id(14), "A later trial replicated it"],
      ]),
      sources: new Map([
        [id(20), "A 2026 replication"],
        [id(21), "The original paper"],
      ]),
    });
    expect(note.split("\n")).toEqual([
      "What has changed in the graph under the current assessment since it was recorded on 2026-10-02:",
      "Subclaims judged again (2):",
      `- ${id(10)} "The trial was randomized" (requires)`,
      `- ${id(11)} "Dropout was balanced across arms" (supports, had no judgment then)`,
      "Subclaims added (1):",
      `- ${id(14)} "A later trial replicated it" (supports)`,
      "Subclaims removed (1):",
      `- ${id(13)} "The effect is an artifact" (contradicts)`,
      "Sources added (1):",
      `- ${id(20)} "A 2026 replication"`,
      "Notices recorded on its sources (1):",
      `- expression of concern, 2026-10-20: ${id(21)} "The original paper"`,
      `"Judged again" means the node has a newer judgment than the one this assessment was made against, whether or not its verdict moved.`,
      `Each list names at most ${CHANGES_NAMED_PER_LIST}, to keep this note short; get_claim with include ["judgment_inputs"] gives all of them by id.`,
    ]);
    // The unchanged premise is not listed, and an absent kind of change has no heading.
    expect(note).not.toContain(id(12));
    expect(note).not.toContain("Sources removed");
  });

  it("states the cap, the full count, and the read that has the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      node_id: id(100 + i), relation: "requires", judged_against: id(200 + i), in_force_now: id(300 + i),
      state: "rejudged" as const,
    }));
    const v = view({ changed: true, premises: many });
    const note = changesSinceJudgedNote("question", v, NO_NAMES);
    expect(note).toContain(`Nodes under it judged again (8, the first ${CHANGES_NAMED_PER_LIST} listed):`);
    expect(note.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(CHANGES_NAMED_PER_LIST);
    expect(note).toContain(
      `Each list names at most ${CHANGES_NAMED_PER_LIST}, to keep this note short; get_claim with include ["judgment_inputs"]`
    );
    // Only the ids that will be shown have their texts read.
    expect(namedInChangesNote(v).nodeIds).toEqual(many.slice(0, CHANGES_NAMED_PER_LIST).map((p) => p.node_id));
    // An id with no text on hand is shown bare rather than dropped.
    expect(note).toContain(`- ${id(100)} (requires)`);
  });

  it("reports what changed and leaves the conclusion to the Steward", () => {
    const v = view({
      changed: true,
      sources: { recorded: 1, added: [], removed: [id(20)], events_since: [] },
    });
    for (const note of [
      changesSinceJudgedNote("claim", v, NO_NAMES),
      changesSinceJudgedNote("claim", view(), NO_NAMES),
      changesSinceJudgedNote("claim", view({ recorded: false, changed: null }), NO_NAMES),
    ]) {
      expect(note).not.toMatch(/\b(must|should|need to|reassess|re-assess|stale|out of date)\b/i);
      expect(note).not.toContain("—");
    }
  });

  it("says nothing when the record cannot be read, rather than failing the pass", async () => {
    vi.mocked(rawQuery).mockRejectedValueOnce(new Error("connection reset"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadChangesSinceJudgedNote(id(1), "claim")).toBe("");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
