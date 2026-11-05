/**
 * The pure parts of the change stream and of Correspondents (#562, #563):
 * how a pass is classified against the one before it, cursors that round
 * trip and compare as strings, an update's items checked against its run's
 * window, the "not covered" account the mechanism writes, and the feed.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import {
  classifyChange,
  decodeChangeCursor,
  encodeChangeCursor,
  statusSteps,
  toMicroIso,
  type GraphChange,
} from "../../../src/services/graph-change-service.js";
import {
  computeNotCovered,
  correspondentAtom,
  cursorAt,
  renderUpdateText,
  validateUpdateItems,
  type CorrespondentUpdateRow,
} from "../../../src/services/correspondent-service.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function change(id: string, claimId: string): GraphChange {
  return {
    change_id: id,
    at: "2026-11-05T10:00:00.000000Z",
    claim_id: claimId,
    claim_text: "x",
    kind: "status_moved",
    status: "doubtful",
    prev_status: "supported",
    confidence: 0.7,
    credence: 0.3,
    prev_credence: 0.7,
    credence_delta: -0.4,
    status_steps: 2,
    trigger: null,
    page_url: "",
    cursor: "",
  };
}

describe("classifyChange", () => {
  const row = (o: Partial<Parameters<typeof classifyChange>[0]>) => ({
    status: "supported",
    prev_status: "supported",
    credence: 0.7,
    prev_credence: 0.7,
    has_prev: true,
    ...o,
  });
  it("names a first assessment, a status move, and a credence move at the threshold", () => {
    expect(classifyChange(row({ has_prev: false, prev_status: null }), 0.1, true)).toBe("first_assessment");
    expect(classifyChange(row({ status: "doubtful" }), 0.1, true)).toBe("status_moved");
    expect(classifyChange(row({ credence: 0.3, prev_credence: 0.2 }), 0.1, true)).toBe("credence_moved");
    expect(classifyChange(row({ credence: null }), 0.1, true)).toBe("credence_moved");
  });
  it("skips a minor pass unless every pass is wanted; a threshold of 0 counts any move", () => {
    expect(classifyChange(row({ credence: 0.75 }), 0.1, true)).toBeNull();
    expect(classifyChange(row({ credence: 0.75 }), 0.1, false)).toBe("reassessed");
    expect(classifyChange(row({ credence: 0.71 }), 0, true)).toBe("credence_moved");
    expect(classifyChange(row({}), 0, true)).toBeNull();
  });
  it("counts rungs on the ladder, and none off it", () => {
    expect(statusSteps("verified", "contradicted")).toBe(4);
    expect(statusSteps("doubtful", "supported")).toBe(-2);
    expect(statusSteps("unknown", "supported")).toBeNull();
    expect(statusSteps(null, "supported")).toBeNull();
  });
});

describe("cursors", () => {
  it("round-trip, and reject anything else", () => {
    const c = encodeChangeCursor("2026-11-05T10:00:00.123456Z", A);
    expect(decodeChangeCursor(c)).toEqual({ at: "2026-11-05T10:00:00.123456Z", id: A });
    expect(decodeChangeCursor("not-a-cursor")).toBeNull();
  });
  it("write times in the stream's microsecond form, so positions compare as strings", () => {
    expect(toMicroIso("2026-11-05T10:00:00.123Z")).toBe("2026-11-05T10:00:00.123000Z");
    expect(toMicroIso("2026-11-05T10:00:00Z")).toBe("2026-11-05T10:00:00.000000Z");
    const at = decodeChangeCursor(cursorAt(new Date("2026-11-05T10:00:00.123Z")))!.at;
    expect(at < "2026-11-05T10:00:00.123456Z").toBe(true);
  });
});

describe("an update's items", () => {
  const window = new Set(["c1", "c2"]);
  const known = new Set([A]);
  it("are checked against the run's window and the graph", () => {
    expect(validateUpdateItems([{ claim_id: A, reason: "It moved to doubtful.", change_ids: ["c1"] }], window, known)).toEqual({
      items: [{ claim_id: A, reason: "It moved to doubtful.", change_ids: ["c1"] }],
    });
    expect(validateUpdateItems([{ claim_id: B, reason: "It moved to doubtful." }], window, known)).toHaveProperty("problem");
    expect(validateUpdateItems([{ claim_id: A, reason: "It moved.", change_ids: ["c9"] }], window, known)).toHaveProperty("problem");
    expect(validateUpdateItems([{ claim_id: A, reason: "?" }], window, known)).toHaveProperty("problem");
  });
  it("leave every change they do not cite, by id or by node, listed as not covered", () => {
    const nc = computeNotCovered(
      [change("c1", A), change("c2", B), change("c3", A)],
      [{ claim_id: A, reason: "moved", change_ids: ["c1"] }],
      true,
      "  The arguments under B were not read.  "
    );
    expect(nc.changes.map((c) => c.change_id)).toEqual(["c2"]);
    expect(nc.changes_total).toBe(1);
    expect(nc.more_after_window).toBe(true);
    expect(nc.unexamined).toBe("The arguments under B were not read.");
  });
});

describe("the feed", () => {
  const update: CorrespondentUpdateRow = {
    id: B,
    correspondent_id: A,
    grant_id: A,
    title: "A <move> & more",
    body: "The claim moved to doubtful.",
    items: [],
    not_covered: { changes: [], changes_total: 2, more_after_window: false, unexamined: "Subclaims of X." },
    changes_from: null,
    changes_to: null,
    created_at: new Date("2026-11-05T12:00:00Z"),
  };
  const mandate = { title: "Following X", url: "https://minerval.ai/mandates/x" };
  it("renders what was left out and who paid with every update", () => {
    const text = renderUpdateText(update, mandate);
    expect(text).toContain("2 material changes in scope since the last update are not mentioned above.");
    expect(text).toContain("- Subclaims of X.");
    expect(text).toContain('Funded by the mandate "Following X"');
  });
  it("is valid Atom with escaped text", () => {
    const xml = correspondentAtom(
      { id: A, title: "X digest", audience: "people following X", updated_at: new Date() },
      [update],
      { apiBase: "https://api.example", mandate }
    );
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<title>A &lt;move&gt; &amp; more</title>");
    expect(xml).toContain(`<link rel="self" href="https://api.example/correspondents/${A}/feed"/>`);
    expect(xml).toContain("<updated>2026-11-05T12:00:00.000Z</updated>");
  });
});

describe("the Correspondent's prompt", () => {
  it("carries the constitution, as every role the graph runs does, and its role", async () => {
    const { getCorrespondentSystemPrompt } = await import("../../../src/llm/prompts/correspondent.js");
    const prompt = getCorrespondentSystemPrompt();
    expect(prompt).toContain("# The Epistemic Graph Administrator Constitution");
    expect(prompt).toContain("# Your Role: Correspondent");
  });
});
