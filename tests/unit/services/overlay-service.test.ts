/**
 * A graph with one label has one layer, and nothing of a label's overlay is
 * asked there (src/services/overlay-service.ts): the SQL another module
 * builds with these fragments is the text it was, no query is made, and
 * the Steward's tools are the list they were.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rawQuery, enforcement } = vi.hoisted(() => ({
  rawQuery: vi.fn(async () => {
    throw new Error("a graph with one label asks nothing of its overlays");
  }),
  enforcement: { on: false as boolean | null },
}));
vi.mock("../../../src/db/client.js", () => ({ rawQuery, getDb: vi.fn(), withTransaction: vi.fn() }));

vi.mock("../../../src/db/clearance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/clearance.js")>()),
  enforcementLastKnown: () => enforcement.on,
}));

import {
  contestationSql,
  importanceSql,
  layersOf,
  nodeValueOverlays,
  notSetAsideSql,
  overlaid,
  overlaysEndedBelow,
  setAsideSql,
  setAsides,
  takeBackOverlay,
  valuesByLabelOf,
  withLayer,
  withSetAside,
} from "../../../src/services/overlay-service.js";
import { getStewardStructureToolDefinitions, setAsideMessage, STEWARD_STRUCTURE_TOOL_NAMES } from "../../../src/llm/tools/steward-structure-tools.js";
import { endedOverlaysNote } from "../../../src/llm/agents/changes-below-note.js";

beforeEach(() => {
  enforcement.on = false;
  rawQuery.mockClear();
});

describe("on a graph with one label", () => {
  it("every fragment is the column or the constant it stands for", () => {
    expect(overlaid()).toBe(false);
    expect(importanceSql("c")).toBe("c.importance");
    expect(importanceSql("cl", "a.sensitivity_label")).toBe("cl.importance");
    expect(contestationSql("c")).toBe("c.contestation");
    expect(setAsideSql("claim_relationships", "r.id")).toBe("FALSE");
    expect(notSetAsideSql("arguments", "a.id")).toBe("");
  });

  it("no read asks the database anything, and rows come back as they were given", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(await withLayer("arguments", rows, (r) => r.id)).toBe(rows);
    expect(await withSetAside("arguments", rows, (r) => r.id)).toBe(rows);
    expect((await layersOf("arguments", ["a"])).size).toBe(0);
    expect((await setAsides("claim_relationships", ["a"])).size).toBe(0);
    expect(await nodeValueOverlays("a", { importance: 0.5, contestation: null })).toBeNull();
    expect(await overlaysEndedBelow("a", null)).toEqual([]);
    expect(await takeBackOverlay("claims", "a", "importance")).toBe(false);
    expect(rawQuery).not.toHaveBeenCalled();
    expect(valuesByLabelOf({ id: "a" })).toEqual({});
  });

  it("the Steward's structure tools are the five they were", () => {
    expect(getStewardStructureToolDefinitions().map((t) => t.name)).toEqual([...STEWARD_STRUCTURE_TOOL_NAMES]);
  });
});

describe("on a graph with more than one label", () => {
  it("importance is the nearest layer's value where a label holds one, else the node's", () => {
    enforcement.on = true;
    expect(importanceSql("c")).toBe(
      "COALESCE((SELECT o.value FROM overlays o WHERE o.target_table = 'claims' AND o.target_id = c.id AND o.kind = 'importance' " +
        "AND o.ended_at IS NULL ORDER BY minerval_layer_depth(o.sensitivity_label) DESC, o.created_at DESC, o.id LIMIT 1), c.importance)"
    );
    // A sweep over rows at every label names the label whose value it wants.
    expect(importanceSql("c", "a.sensitivity_label")).toContain(
      "AND o.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[a.sensitivity_label]::text[]))"
    );
    expect(getStewardStructureToolDefinitions().map((t) => t.name)).toEqual([...STEWARD_STRUCTURE_TOOL_NAMES, "restore_below"]);
  });

  it("refuses a name that is not a column's", () => {
    enforcement.on = true;
    expect(() => importanceSql("c; DROP TABLE claims")).toThrow();
  });
});

describe("what a Steward is told", () => {
  it("when what it removes is at a label below", () => {
    expect(setAsideMessage(`argument "From the audit"`, "finance", "company")).toBe(
      'Set aside at `finance`: argument "From the audit". It is at `company`, which this run reads and does not change, and readers there see no ' +
        "difference. At `finance` it is shown as set aside with your reason, and the judgment at `finance` does not rest on it. restore_below takes this back."
    );
    expect(setAsideMessage("the requires edge", "company", "the public graph")).toContain("It is at the public graph, which this run reads");
  });

  it("when what its label held over a row below ended because the row changed", () => {
    const at = new Date("2030-02-03T04:05:06Z");
    const note = endedOverlaysNote(
      "finance",
      [
        {
          kind: "set_aside", target_table: "claim_relationships", target_id: "e1", claim_id: "n1", value: 1, reason: "Unrelated.",
          ended_at: at, ended_because: "removed_below", ended_detail: { child_claim_id: "c1", relation_type: "supports" },
        },
        {
          kind: "set_aside", target_table: "claim_relationships", target_id: "e2", claim_id: "n1", value: 1, reason: null,
          ended_at: at, ended_because: "retyped_below", ended_detail: { child_claim_id: "c2", relation_type: "requires", now: "supports" },
        },
        {
          kind: "set_aside", target_table: "arguments", target_id: "a1", claim_id: "n1", value: 1, reason: "No such audit.",
          ended_at: at, ended_because: "retired_below", ended_detail: { argument_id: "a1", name: "From the audit", reason: "Withdrawn." },
        },
        {
          kind: "importance", target_table: "claims", target_id: "n0", claim_id: "n0", value: 0.9, reason: null,
          ended_at: at, ended_because: "merged_below", ended_detail: { merged_into: "n1" },
        },
      ],
      new Map([["c1", "A premise"], ["n0", "The node folded away"]])
    );
    expect(note).toBe(
      [
        "What `finance` held over rows at the labels below it, ended because the row was changed there:",
        '- The supports edge to c1 "A premise", which `finance` had set aside ("Unrelated."), was removed on 2030-02-03.',
        "- The requires edge to c2, which `finance` had set aside, was changed to supports on 2030-02-03.",
        '- Argument a1 "From the audit", which `finance` had set aside ("No such audit."), was retired on 2030-02-03 (Withdrawn.).',
        '- `finance` held its own importance (0.9) for n0 "The node folded away", which was merged into n1 on 2030-02-03.',
        "Each ended when its row changed, and nothing else at `finance` was changed. Where one still holds of the row as it now is, " +
          "the tool that recorded it records it again.",
      ].join("\n")
    );
    expect(endedOverlaysNote("finance", [], new Map())).toBe("");
  });
});
