/**
 * Lists (constitution §7b, #845) against real Postgres: a list is a node of
 * kind 'artifact' with its specification, its entries as 'draws_on' edges,
 * and its fidelity in artifact_assessments, read through
 * artifact_assessments_in_force. What the Steward judged against is
 * recorded, so an entry that moves afterwards makes the list stale.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import {
  addListEntry,
  getListDetail,
  proposeList,
  recordListAssessment,
  removeListEntry,
  restateListSpec,
} from "../../src/services/artifact-service.js";
import { markQuestion } from "../../src/services/question-service.js";

const SPEC = {
  purpose: "Which places have been seriously proposed as the origin of the 1918 pandemic.",
  inclusion: "A claim that the pandemic began in a named place, argued in scholarly work from pre-1918 evidence.",
  ordering: "By the earliest date the hypothesis puts the start.",
  entry_kinds: ["claim" as const],
};

async function seedList(): Promise<string> {
  const { id } = await proposeList({ title: `Hypotheses of origin ${Math.random()}`, spec: SPEC, createdBy: "dbtest", confirmNew: true });
  expect(id).toBeTruthy();
  return id!;
}

async function assess(claimId: string, status: string): Promise<void> {
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND is_current`, [claimId]);
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current)
     VALUES ($1, $2, 0.6, 'dbtest', true)`,
    [claimId, status]
  );
}

describe("lists", () => {
  it("are nodes of kind artifact with a specification", async () => {
    const list = await seedList();
    const [row] = await rawQuery<{ kind: string; steward_state: string }>(`SELECT kind, steward_state FROM claims WHERE id = $1`, [list]);
    expect(row!.kind).toBe("artifact");
    const detail = await getListDetail(list);
    expect(detail.spec).toMatchObject({ subtype: "list", purpose: SPEC.purpose, inclusion: SPEC.inclusion, entry_kinds: ["claim"] });
    expect(detail.fidelity).toBeNull();
    expect(detail.stale).toBeNull();
    expect(detail.entries).toEqual([]);
  });

  it("refuses a proposal without criteria", async () => {
    await expect(
      proposeList({ title: "Things", spec: { purpose: "x", inclusion: "" } as never, createdBy: "dbtest" })
    ).rejects.toThrow(/inclusion/);
  });

  it("draws on entries through draws_on edges, held to the specification's kinds", async () => {
    const list = await seedList();
    const a = await seedClaim("The 1918 pandemic began in Kansas.");
    const q = await seedClaim("Where did the 1918 pandemic begin?");
    await markQuestion(q);
    await addListEntry({ artifactId: list, nodeId: a, note: "Names a place; argued by Barry.", createdBy: "dbtest" });
    await expect(addListEntry({ artifactId: list, nodeId: q, note: "n", createdBy: "dbtest" })).rejects.toThrow(/entries are claim/);
    await expect(addListEntry({ artifactId: list, nodeId: list, note: "n", createdBy: "dbtest" })).rejects.toThrow(/not an entry of itself/);
    const other = await seedList();
    await expect(addListEntry({ artifactId: list, nodeId: other, note: "n", createdBy: "dbtest" })).rejects.toThrow(/not on other lists/);

    const edges = await rawQuery<{ relation_type: string; reasoning: string }>(
      `SELECT relation_type, reasoning FROM claim_relationships WHERE parent_claim_id = $1`,
      [list]
    );
    expect(edges).toEqual([{ relation_type: "draws_on", reasoning: "Names a place; argued by Barry." }]);

    expect(await removeListEntry({ artifactId: list, nodeId: a })).toBe(true);
    expect((await getListDetail(list)).entries).toEqual([]);
  });

  it("records fidelity with the order and what was left out, and goes stale when an entry moves", async () => {
    const list = await seedList();
    const kansas = await seedClaim("The 1918 pandemic began in Kansas.");
    const france = await seedClaim("The 1918 pandemic began in France.");
    const spread = await seedClaim("The first wave followed troop movements.");
    await assess(kansas, "inconclusive");
    await assess(france, "inconclusive");
    await addListEntry({ artifactId: list, nodeId: kansas, note: "Kansas, early 1918.", createdBy: "dbtest" });
    await addListEntry({ artifactId: list, nodeId: france, note: "France, 1916.", createdBy: "dbtest" });

    await expect(
      recordListAssessment({ claimId: list, fidelity: "incomplete", reasoningTrace: "t" })
    ).rejects.toThrow(/gaps/);
    await expect(
      recordListAssessment({ claimId: list, fidelity: "faithful", reasoningTrace: "t", entryOrder: [spread] })
    ).rejects.toThrow(/not entries/);
    await expect(
      recordListAssessment({ claimId: list, fidelity: "faithful", reasoningTrace: "t", leftOut: [{ node_id: kansas, reason: "r" }] })
    ).rejects.toThrow(/not both/);
    await expect(
      recordListAssessment({ claimId: list, fidelity: "verified" as never, reasoningTrace: "t" })
    ).rejects.toThrow(/Unknown fidelity/);

    await recordListAssessment({ claimId: list, fidelity: "faithful", reasoningTrace: "first" });
    const current = await recordListAssessment({
      claimId: list,
      fidelity: "faithful",
      summary: "Faithful.",
      reasoningTrace: "second",
      entryOrder: [france, kansas],
      leftOut: [{ node_id: spread, reason: "About spread, not origin." }],
      confidence: 0.7,
    });
    const [n] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifact_assessments WHERE claim_id = $1 AND is_current`,
      [list]
    );
    expect(n!.n).toBe(1);

    let detail = await getListDetail(list);
    expect(detail.fidelity).toBe("faithful");
    expect(detail.assessment).toMatchObject({ id: current.id, reasoning_trace: "second", confidence: 0.7 });
    expect(detail.entries.map((e) => e.id)).toEqual([france, kansas]);
    expect(detail.entries[0]).toMatchObject({ status: "inconclusive", note: "France, 1916.", changed_since: false });
    expect(detail.left_out).toEqual([
      expect.objectContaining({ id: spread, kind: "claim", reason: "About spread, not origin." }),
    ]);
    expect(detail.stale).toBe(false);

    // An entry judged again to another verdict: the list was judged against the old one.
    await assess(kansas, "doubtful");
    detail = await getListDetail(list);
    expect(detail.stale).toBe(true);
    expect(detail.changed_entries).toBe(1);
    expect(detail.entries.find((e) => e.id === kansas)).toMatchObject({ status: "doubtful", changed_since: true });
    expect(detail.entries.find((e) => e.id === france)!.changed_since).toBe(false);

    // Its Steward looks again and records the judgment: current once more.
    await recordListAssessment({ claimId: list, fidelity: "faithful", reasoningTrace: "third", entryOrder: [france, kansas] });
    expect((await getListDetail(list)).stale).toBe(false);
  });

  it("restates the specification under the same identity", async () => {
    const list = await seedList();
    await restateListSpec({ claimId: list, spec: { ...SPEC, purpose: "Where the 1918 pandemic may have begun." }, createdBy: "dbtest" });
    const detail = await getListDetail(list);
    expect(detail.spec!.purpose).toBe("Where the 1918 pandemic may have begun.");
    const [n] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM artifact_specs WHERE claim_id = $1`, [list]);
    expect(n!.n).toBe(1);
  });

  it("reads the list's judgment through the views of judgments in force", async () => {
    const list = await seedList();
    await recordListAssessment({ claimId: list, fidelity: "ill_specified", reasoningTrace: "The criteria cannot be checked." });
    const [inForce] = await rawQuery<{ fidelity: string }>(`SELECT fidelity FROM artifact_assessments_in_force WHERE claim_id = $1`, [list]);
    expect(inForce!.fidelity).toBe("ill_specified");
    const [version] = await rawQuery<{ in_force: boolean }>(`SELECT in_force FROM artifact_assessments_versions WHERE claim_id = $1`, [list]);
    expect(version!.in_force).toBe(true);
  });
});
