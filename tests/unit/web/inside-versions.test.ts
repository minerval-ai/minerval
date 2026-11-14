import { describe, it, expect } from "vitest";
import { assessmentOf, byLabelName, detailAt, detailWithoutJudgment, leftStandingLines, notExaminedLine, whichToOpen } from "../../../web/lib/inside-versions.js";
import { readerEvidenceLine } from "../../../web/lib/coverage.js";
import type { ClaimDetail, NodeVersion } from "../../../web/lib/types.js";

// A node's page inside a private deployment: which of the node's judgments
// the page opens on, and how one of them is put where the ordinary page
// reads its judgment from. The rule that matters most is the one that
// cannot be seen when it is broken: a reader for whom two judgments are in
// force is given both, and nothing chooses between them.

const version = (label: string, over: Partial<NodeVersion> = {}): NodeVersion => ({
  id: `id-${label}`,
  label,
  in_force: true,
  assessed_at: "2026-11-10T00:00:00.000Z",
  made_beside: [],
  versions_since: [],
  made_against_earlier: false,
  status: "supported",
  confidence: 0.8,
  claim_credence: 0.7,
  summary: `the summary at ${label}`,
  reasoning_trace: `the reasoning at ${label}`,
  ...over,
});

const detail = (over: Partial<ClaimDetail> = {}): ClaimDetail =>
  ({
    claim: { id: "node", kind: "claim", text: "A claim" },
    assessment: { id: "id-finance", status: "supported", confidence: 0.8, summary: "s", reasoning_trace: "r", subclaim_summary: {}, assessed_at: "2026-11-10T00:00:00.000Z", funding: { type: "order", label: "an order" } },
    coverage: { examined: true, on: ["evidence_this_reader_can_read"] },
    since_assessed: { changed: true },
    subclaim_count: 0,
    ...over,
  }) as unknown as ClaimDetail;

describe("which judgment a node's page opens on", () => {
  it("opens on the one in force", () => {
    const versions = [version("finance"), version("public", { in_force: false })];
    expect(whichToOpen(versions)).toEqual({ kind: "version", version: versions[0] });
  });

  it("gives both where two are in force, in the order of the labels' names and never by which is newer", () => {
    const newer = version("legal", { assessed_at: "2026-11-12T00:00:00.000Z" });
    const older = version("finance", { assessed_at: "2026-11-01T00:00:00.000Z" });
    for (const versions of [[newer, older, version("public", { in_force: false })], [older, newer]]) {
      const open = whichToOpen(versions);
      expect(open.kind).toBe("several");
      expect(open.kind === "several" && open.versions.map((v) => v.label)).toEqual(["finance", "legal"]);
    }
  });

  it("opens on the one asked for by its label, in force or not, and ignores a label the reader has no judgment at", () => {
    const versions = [version("finance"), version("legal"), version("public", { in_force: false })];
    expect(whichToOpen(versions, "public")).toEqual({ kind: "version", version: versions[2] });
    expect(whichToOpen(versions, "no-such-label").kind).toBe("several");
  });

  it("opens on nothing where the node has no judgment", () => {
    expect(whichToOpen([])).toEqual({ kind: "none" });
  });

  it("puts public last and the rest by name", () => {
    expect([version("public"), version("legal"), version("finance")].sort(byLabelName).map((v) => v.label)).toEqual(["finance", "legal", "public"]);
  });
});

describe("one judgment in the place the page reads its judgment from", () => {
  it("carries the judgment's own verdict, words, date and model", () => {
    const at = detailAt(detail(), version("legal", { status: "doubtful", confidence: 0.6, claim_credence: null, model: "a-model", run_id: "run" }));
    expect(at.assessment).toMatchObject({ id: "id-legal", status: "doubtful", confidence: 0.6, claim_credence: null, summary: "the summary at legal", reasoning_trace: "the reasoning at legal", model: "a-model", run_id: "run" });
  });

  it("keeps what the API said beside a judgment (who paid) with that judgment and no other", () => {
    expect((detailAt(detail(), version("finance")).assessment as { funding?: unknown }).funding).toBeDefined();
    expect((detailAt(detail(), version("legal")).assessment as { funding?: unknown }).funding).toBeUndefined();
  });

  it("shows each judgment's own coverage and changes, and none where the API gave it none", () => {
    const own = { examined: true, on: ["evidence_this_reader_can_read", "evidence_this_reader_cannot_read"] };
    const withOwn = detailAt(detail(), version("legal", { coverage: own, since_assessed: null }));
    expect(withOwn.coverage).toEqual(own);
    const without = detailAt(detail(), version("legal"));
    expect(without.coverage).toBeUndefined();
    expect(without.since_assessed).toBeUndefined();
    // The judgment the API named keeps what the API said of it.
    expect(detailAt(detail(), version("finance")).coverage).toEqual({ examined: true, on: ["evidence_this_reader_can_read"] });
  });

  it("gives null for a version that carries no status", () => {
    expect(assessmentOf(version("finance", { status: undefined }), null)).toBeNull();
  });

  it("leaves the page with no judgment of its own where both stand above it", () => {
    const bare = detailWithoutJudgment(detail());
    expect(bare.assessment).toBeNull();
    expect(bare.coverage).toBeUndefined();
    expect(bare.since_assessed).toBeUndefined();
  });
});

describe("what a judgment was made on, said to its reader", () => {
  it("says nothing in the ordinary case and on the public graph", () => {
    expect(readerEvidenceLine({ examined: true, on: ["public_evidence"] })).toBeNull();
    expect(readerEvidenceLine({ examined: true, on: ["evidence_this_reader_can_read"] })).toBeNull();
    expect(readerEvidenceLine({ examined: false, on: [] })).toBeNull();
    expect(readerEvidenceLine(null)).toBeNull();
  });

  it("says when it rests on evidence the reader cannot read, in part or wholly", () => {
    expect(readerEvidenceLine({ examined: true, on: ["evidence_this_reader_can_read", "evidence_this_reader_cannot_read"] })).toMatch(/^This assessment was made partly on evidence you can read and partly on evidence you cannot/);
    expect(readerEvidenceLine({ examined: true, on: ["evidence_this_reader_cannot_read"] }, "estimate")).toMatch(/^This estimate was made on evidence you cannot read/);
  });
});

describe("a node examined at the reader's label, with another label's assessment left standing", () => {
  const entry = {
    label: "internal",
    examined_at: "2026-11-12T09:00:00.000Z",
    run_id: null,
    reasoning: "Queried the order book.",
    judgments: [{ label: "public", replaced: false }],
    open_again: false,
  };

  it("is said in ordinary words, with the date, and as standing while the other assessment stands", () => {
    expect(leftStandingLines(entry, "12 November 2026")).toEqual({
      examined:
        "This node was examined at internal on 12 November 2026, and the public assessment was left standing: its Steward at internal made no separate assessment.",
      since: "That assessment still stands.",
    });
  });

  it("says the question is open again once that assessment has been replaced", () => {
    const lines = leftStandingLines({ ...entry, judgments: [{ label: "public", replaced: true }], open_again: true }, "12 November 2026");
    expect(lines.since).toBe(
      "That assessment has been replaced since, so the newer one has not been looked at from internal. The deployment opens a fresh look at internal when that happens, and it runs when someone pays for it."
    );
  });

  it("is a different sentence from never having been examined there, which is not a finding", () => {
    expect(notExaminedLine([])).toBeNull();
    expect(notExaminedLine(["internal"])).toBe(
      "This node has not been examined at internal: no assessment has been made there, and no Steward there has looked and left another standing. " +
        "That is not a finding that nothing filed at that label bears on it."
    );
    expect(notExaminedLine(["internal", "restricted"])).toContain("at internal and restricted");
  });
});
