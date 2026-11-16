/**
 * The Steward's note of what the layer below changed (changes-below-note.ts):
 * one note, a section for each layer, the public graph's worded as it was
 * before there was any other.
 */
import { describe, it, expect } from "vitest";
import { changesBelowNote, type ChangeBelow } from "../../../src/llm/agents/changes-below-note.js";

const change = (over: Partial<ChangeBelow>): ChangeBelow => ({
  claim_id: "n1",
  at: null,
  own: true,
  change: "reworded",
  detail: { was: "Old words.", now: "New words." },
  cut_at: "2030-02-03T04:05:06Z",
  text: "New words.",
  ...over,
});

describe("what the layer below changed", () => {
  it("says nothing where nothing changed", () => {
    expect(changesBelowNote("finance", "2030-01-01T00:00:00Z", [])).toBe("");
    // A kind of change the note has no list for is not a section of its own.
    expect(changesBelowNote("finance", "2030-01-01T00:00:00Z", [change({ change: "merged", own: true })])).toBe("");
  });

  it("words the public graph's changes as the mirror's note always did", () => {
    expect(changesBelowNote("internal", "2030-01-01T00:00:00Z", [change({}), change({ own: false, claim_id: "n2", change: "withdrawn", detail: {}, text: "A premise." })])).toBe(
      [
        "What the public graph has changed, as the mirror brought it, since the version at `internal` was recorded on 2030-01-01:",
        "This node was reworded (1):",
        '- 2030-02-03. It read: "Old words." It now reads: "New words."',
        "Nodes under it withdrawn by the public graph (1):",
        '- n2 "A premise.", 2030-02-03',
        "The version at `internal` was made of the node, and of the nodes under it, as they were worded then. Each list names at most 5, to keep this note short; get_claim gives each node as it now stands.",
      ].join("\n")
    );
  });

  it("gives each layer its own section, the public graph first, and names the label a change was made at", () => {
    const note = changesBelowNote("finance", "2030-01-01T00:00:00Z", [
      change({ at: "company", change: "kind_corrected", detail: { was: "question", now: "claim" } }),
      change({ at: "company", own: false, claim_id: "n3", change: "withdrawn", detail: {}, text: "Another premise." }),
      change({ at: "company", change: "argument_retired", detail: { argument_id: "a1", name: "From the ledger", reason: "superseded" } }),
      change({}),
    ]);
    expect(note).toBe(
      [
        "What the public graph has changed, as the mirror brought it, since the version at `finance` was recorded on 2030-01-01:",
        "This node was reworded (1):",
        '- 2030-02-03. It read: "Old words." It now reads: "New words."',
        "What work at `company` has changed, since the version at `finance` was recorded on 2030-01-01:",
        "This node's kind was corrected (1):",
        "- 2030-02-03. It was a question and is now a claim.",
        "Arguments on this node (1):",
        '- a1 "From the ledger" was retired (superseded), 2030-02-03',
        "Nodes under it withdrawn (1):",
        '- n3 "Another premise.", 2030-02-03',
        "The version at `finance` was made of the node, and of the nodes under it, as they were worded then. Each list names at most 5, to keep this note short; get_claim gives each node as it now stands.",
      ].join("\n")
    );
  });

  it("dates from the examination where the label left the judgment it read standing", () => {
    const note = changesBelowNote("finance", "2030-01-01T00:00:00Z", [change({ at: "company" })], { leftStanding: true });
    expect(note.split("\n")[0]).toBe(
      "What work at `company` has changed, since a run at `finance` examined this node and left the judgment it read standing on 2030-01-01:"
    );
    expect(note.split("\n").at(-1)).toBe(
      "The run at `finance` examined the node, and the nodes under it, as they were worded then. Each list names at most 5, to keep this note short; get_claim gives each node as it now stands."
    );
  });
});
