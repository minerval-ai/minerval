import { describe, it, expect, vi, beforeEach } from "vitest";

// One graph for every test:
//   PARENT and PARENT_2 depend on SELF (PARENT -> SELF), SELF depends on
//   CHILD (SELF -> CHILD), and OTHER is joined to SELF by no edge.
const SELF = "33333333-3333-3333-3333-333333333333";
const PARENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARENT_2 = "abababab-abab-abab-abab-abababababab";
const CHILD = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OTHER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MISSING = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const { NODES, EDGES } = vi.hoisted(() => ({
  NODES: {
    "33333333-3333-3333-3333-333333333333": "claim",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": "claim",
    "abababab-abab-abab-abab-abababababab": "question",
    "cccccccc-cccc-cccc-cccc-cccccccccccc": "quantity",
    "dddddddd-dddd-dddd-dddd-dddddddddddd": "claim",
  } as Record<string, string>,
  EDGES: [
    { parent_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", child_id: "33333333-3333-3333-3333-333333333333" },
    { parent_id: "abababab-abab-abab-abab-abababababab", child_id: "33333333-3333-3333-3333-333333333333" },
    { parent_id: "33333333-3333-3333-3333-333333333333", child_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
  ],
}));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM claims")) {
      const ids = params[0] as string[];
      return ids.filter((id) => id in NODES).map((id) => ({ id, kind: NODES[id] }));
    }
    if (sql.includes("FROM claim_relationships")) {
      const [sender, targets] = params as [string, string[]];
      return EDGES.filter(
        (e) =>
          (e.child_id === sender && targets.includes(e.parent_id)) ||
          (e.parent_id === sender && targets.includes(e.child_id))
      );
    }
    return [];
  }),
  getDb: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(async () => {}),
  enqueueClaimPipeline: vi.fn(async () => {}),
}));

import {
  executeStewardTool,
  getStewardToolDefinitions,
} from "../../../../src/llm/tools/steward-tools.js";
import {
  executeCuratorTool,
  getCuratorToolDefinitions,
} from "../../../../src/llm/tools/curator-tools.js";
import { enqueueSteward } from "../../../../src/services/queue-service.js";

async function stewardNotify(target_ids: unknown, message = "my reasons") {
  const out = await executeStewardTool("notify_steward", {
    claim_id: SELF,
    target_ids,
    message,
  });
  return JSON.parse(out);
}

describe("notify_steward (Steward)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is one tool for both roles", () => {
    const steward = getStewardToolDefinitions().map((t) => t.name);
    expect(steward).toContain("notify_steward");
    expect(getCuratorToolDefinitions().map((t) => t.name)).toContain("notify_steward");
  });

  it("tells a node that depends on the sender's that it changed (subclaim_change)", async () => {
    const out = await stewardNotify(
      [PARENT],
      "moved SUPPORTED -> INCONCLUSIVE: the key trial was retracted"
    );
    expect(out.success).toBe(true);
    expect(out.notified).toEqual([{ id: PARENT, kind: "claim", trigger: "subclaim_change" }]);
    const call = vi.mocked(enqueueSteward).mock.calls[0][0];
    expect(call).toMatchObject({ claimId: PARENT, trigger: "subclaim_change" });
    expect(call.context).toBe("moved SUPPORTED -> INCONCLUSIVE: the key trial was retracted");
    // Who wrote goes with the message; the inbox says how the nodes are joined.
    expect(call.sender).toEqual({ kind: "steward", nodeId: SELF });
  });

  it("tells a node the sender depends on that it may be mistaken (dependent_note), with the reasons", async () => {
    const reasons =
      "Your estimate uses the 2019 count; the 2023 census revised it down by a third.";
    const out = await stewardNotify([CHILD], reasons);
    expect(out.notified).toEqual([{ id: CHILD, kind: "quantity", trigger: "dependent_note" }]);
    const call = vi.mocked(enqueueSteward).mock.calls[0][0];
    expect(call).toMatchObject({ claimId: CHILD, trigger: "dependent_note" });
    expect(call.context).toBe(reasons);
    expect(call.sender).toEqual({ kind: "steward", nodeId: SELF });
  });

  it("allows a node joined by no edge, with the general trigger (steward_note)", async () => {
    const reasons = "We cite the same study and read its effect size differently.";
    const out = await stewardNotify([OTHER], reasons);
    expect(out.success).toBe(true);
    expect(out.notified).toEqual([{ id: OTHER, kind: "claim", trigger: "steward_note" }]);
    const call = vi.mocked(enqueueSteward).mock.calls[0][0];
    expect(call).toMatchObject({ claimId: OTHER, trigger: "steward_note" });
    expect(call.context).toContain(reasons);
  });

  it("notifies several targets in one call, each with its own derived trigger", async () => {
    const out = await stewardNotify([PARENT, PARENT_2, CHILD, OTHER, PARENT]);
    expect(out.notified).toEqual([
      { id: PARENT, kind: "claim", trigger: "subclaim_change" },
      { id: PARENT_2, kind: "question", trigger: "subclaim_change" },
      { id: CHILD, kind: "quantity", trigger: "dependent_note" },
      { id: OTHER, kind: "claim", trigger: "steward_note" },
    ]);
    // The repeated PARENT is sent once.
    expect(enqueueSteward).toHaveBeenCalledTimes(4);
  });

  it("refuses the sender's own node and notifies the rest", async () => {
    const out = await stewardNotify([SELF, PARENT]);
    expect(out.success).toBe(true);
    expect(out.notified.map((n: { id: string }) => n.id)).toEqual([PARENT]);
    expect(out.refused).toEqual([
      { id: SELF, reason: expect.stringContaining("your own node") },
    ]);
    expect(enqueueSteward).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueSteward).mock.calls[0][0].claimId).toBe(PARENT);
  });

  it("fails when the only target is the sender's own node", async () => {
    const out = await stewardNotify([SELF]);
    expect(out.success).toBe(false);
    expect(enqueueSteward).not.toHaveBeenCalled();
  });

  it("refuses unknown and malformed ids clearly, enqueueing nothing for them", async () => {
    const out = await stewardNotify([MISSING, "not-a-uuid"]);
    expect(out.success).toBe(false);
    expect(out.notified).toEqual([]);
    expect(out.refused).toEqual([
      { id: "not-a-uuid", reason: expect.stringContaining("Not a node id") },
      { id: MISSING, reason: expect.stringContaining("No such node") },
    ]);
    expect(enqueueSteward).not.toHaveBeenCalled();
  });

  it("refuses an empty message or no targets", async () => {
    expect((await stewardNotify([PARENT], "  ")).success).toBe(false);
    expect((await stewardNotify([])).success).toBe(false);
    expect(enqueueSteward).not.toHaveBeenCalled();
  });
});

describe("notify_steward (Curator)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues each target with curator_change and the message as written", async () => {
    const msg = "I merged X into you; reconcile the flipped arguments and re-assess.";
    const out = JSON.parse(
      await executeCuratorTool("notify_steward", { target_ids: [PARENT, CHILD], message: msg })
    );
    expect(out.success).toBe(true);
    expect(enqueueSteward).toHaveBeenCalledTimes(2);
    expect(enqueueSteward).toHaveBeenCalledWith({
      claimId: PARENT,
      trigger: "curator_change",
      context: msg,
      sender: { kind: "curator" },
    });
    expect(enqueueSteward).toHaveBeenCalledWith({
      claimId: CHILD,
      trigger: "curator_change",
      context: msg,
      sender: { kind: "curator" },
    });
  });

  it("refuses unknown ids", async () => {
    const out = JSON.parse(
      await executeCuratorTool("notify_steward", { target_ids: [MISSING], message: "m" })
    );
    expect(out.success).toBe(false);
    expect(out.refused[0].id).toBe(MISSING);
    expect(enqueueSteward).not.toHaveBeenCalled();
  });

  it("still tells the Curator to notify after a merge or split", () => {
    const def = getCuratorToolDefinitions().find((t) => t.name === "notify_steward")!;
    expect(def.description).toMatch(/after a merge or split/);
  });
});
