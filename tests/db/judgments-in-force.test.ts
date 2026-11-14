/**
 * More than one judgment in force for one reader (judgment-version-service.ts),
 * against a real database held to clearances: the review labels `r3-a` and
 * `r3-b`, which do not read each other, and `r3-c`, which reads `r3-a`.
 *
 * A read that gives a node one judgment gives a reader of both `r3-a` and
 * `r3-b` the more recently made of two. Every such read says how many there
 * are, and a reader who has one is served exactly what they were.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery, withTransaction } from "../../src/db/client.js";
import { listClaims } from "../../src/services/claim-service.js";
import { getClaimCard } from "../../src/services/claim-card-service.js";
import { coverage, summarizeCoverage } from "../../src/services/coverage-service.js";
import { evaluationsInForce, judgmentsInForce, markSeveralInForce, nodeVersions } from "../../src/services/judgment-version-service.js";
import { noteMirrorApplied, resetMirrorHeldForTests } from "../../src/services/mirrored-node-service.js";
import { A, B, C, asPerson, attachSource, seedNode, stewardAt, system, unwall, version, wall } from "./review-3-common.js";

const id: Record<string, string> = {};
const both = <T>(fn: () => Promise<T>) => asPerson([A, B, "public"], fn);
const onlyA = <T>(fn: () => Promise<T>) => asPerson([A, "public"], fn);

beforeAll(async () => {
  await wall();
  id.node = await seedNode("public", "A node judged at two labels that do not read each other");
  id.one = await seedNode("public", "A node judged at one label");
  await attachSource(id.node!, A, "What a holds.");
  await attachSource(id.node!, B, "What b holds.");
  await attachSource(id.one!, A, "What a holds of the other.");
  await version(id.node!, A, "supported", "At a: supported.");
  await version(id.node!, B, "doubtful", "At b: doubtful.");
  await version(id.one!, A, "supported", "At a alone.");
  await system(async () => {
    const [arg] = await rawQuery<{ id: string }>(
      `INSERT INTO arguments (claim_id, stance, name, content, created_by, sensitivity_label) VALUES ($1, 'for', 'An argument', 'It follows.', 'steward', 'public') RETURNING id`,
      [id.node]
    );
    id.arg = arg!.id;
    for (const label of [A, B]) {
      await rawQuery(`INSERT INTO argument_evaluations (argument_id, verdict, content, is_current, sensitivity_label) VALUES ($1, 'likely', $2, true, $3)`, [id.arg, `Evaluated at ${label}.`, label]);
    }
  });
}, 180_000);

afterAll(async () => {
  resetMirrorHeldForTests();
  if (id.mirrored) {
    await system(() =>
      withTransaction(async (tx) => {
        await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
        await tx.query(`DELETE FROM claim_instances WHERE claim_id = $1`, [id.mirrored]);
        await tx.query(`DELETE FROM assessments WHERE claim_id = $1`, [id.mirrored]);
        await tx.query(`DELETE FROM claims WHERE id = $1`, [id.mirrored]);
      })
    ).catch((err: unknown) => console.warn("[judgments-in-force] cleanup:", err instanceof Error ? err.message : err));
  }
  await unwall();
}, 180_000);

describe("how many judgments are in force for the asker", () => {
  it("is two for a reader of both labels, and is not said for a reader who has one", async () => {
    expect(await both(() => judgmentsInForce([id.node!, id.one!]))).toEqual(new Map([[id.node!, 2]]));
    expect(await onlyA(() => judgmentsInForce([id.node!, id.one!]))).toEqual(new Map());
    expect(await asPerson(["public"], () => judgmentsInForce([id.node!]))).toEqual(new Map());
    expect(await both(() => evaluationsInForce([id.arg!]))).toEqual(new Map([[id.arg!, 2]]));
    expect(await onlyA(() => evaluationsInForce([id.arg!]))).toEqual(new Map());
  });

  it("is one for a run at a label that reads one of the two, and for a run at either", async () => {
    // r3-c reads r3-a and not r3-b: the version at r3-a is the one it goes by.
    expect(await stewardAt(C, () => judgmentsInForce([id.node!]))).toEqual(new Map());
    expect(await stewardAt(A, () => judgmentsInForce([id.node!]))).toEqual(new Map());
  });

  it("marks a row with the count and one sentence, and leaves a row with one judgment exactly as it was", async () => {
    const rows = [{ id: id.node!, status: "x" }, { id: id.one!, status: "y" }];
    await both(() => markSeveralInForce(rows, (r) => r.id));
    expect(rows[1]).toEqual({ id: id.one!, status: "y" });
    expect(rows[0]).toMatchObject({ judgments_in_force: 2 });
    expect((rows[0] as { judgments_in_force_note?: string }).judgments_in_force_note).toBe(
      "2 judgments of this node are in force for you, made at labels that do not read each other. The one given here is the most recently made of them. None replaces another: get_claim on the node lists each under versions, with its label."
    );
  });

  it("is on a card and on a row of the list for the reader of both, and on neither for a reader of one", async () => {
    const card = (await both(() => getClaimCard(id.node!))) as unknown as Record<string, unknown>;
    expect(card.judgments_in_force).toBe(2);
    expect(((await onlyA(() => getClaimCard(id.node!))) as unknown as Record<string, unknown>).judgments_in_force).toBeUndefined();
    const listed = await both(() => listClaims({ limit: 200 } as Parameters<typeof listClaims>[0]));
    const row = (listed.results as Array<Record<string, unknown>>).find((r) => r.id === id.node);
    if (row) expect(row.judgments_in_force).toBe(2);
    const other = (listed.results as Array<Record<string, unknown>>).find((r) => r.id === id.one);
    if (other) expect(other.judgments_in_force).toBeUndefined();
  });
});

describe("a node's judgments, each with what it was made on", () => {
  it("counts those in force and gives each its own coverage and changes", async () => {
    const read = (await both(() => nodeVersions(id.node!, "claim")))!;
    expect(read.in_force).toBe(2);
    expect(read.versions.map((v) => v.label).sort()).toEqual([A, B].sort());
    for (const v of read.versions) {
      expect((v.coverage as { examined: boolean }).examined).toBe(true);
      // Each was made on a source at its own label, which this reader reads.
      expect((v.coverage as { on: string[] }).on).toEqual(["evidence_this_reader_can_read"]);
    }
    const forA = (await onlyA(() => nodeVersions(id.node!, "claim")))!;
    expect(forA.in_force).toBe(1);
    expect(forA.versions.map((v) => v.label)).toEqual([A]);
  });
});

describe("coverage of a mirrored node's public judgment", () => {
  it("does not count what this deployment attached to the node since as what the public graph's judgment was made on", async () => {
    id.mirrored = await system(() =>
      withTransaction(async (tx) => {
        await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
        const [claim] = await tx.query<{ id: string }>(
          `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label, origin)
           VALUES ($1, 'claim', 'done', 'complete', now(), 'public', 'mirror') RETURNING id`,
          [`A mirrored claim for coverage (${Date.now()})`]
        );
        await tx.query(
          `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label, origin)
           VALUES ($1, 'inconclusive', 0.5, 'Open.', 'Open.', true, 'public', 'mirror')`,
          [claim!.id]
        );
        return claim!.id;
      })
    );
    noteMirrorApplied();
    // A page shown to `public` from a label this reader does not read arrives as a source on the node, of this
    // deployment's own. The public graph's judgment was made before it and elsewhere.
    const shown = await attachSource(id.mirrored!, "public", "Status: doubtful.", "mentions");
    await system(() => rawQuery(`UPDATE sources SET source_type = 'shown_page', url = $2 WHERE id = $1`, [shown.source, `minerval:shown-page/${shown.instance}/1`]));
    const said = coverage((await asPerson(["public"], () => summarizeCoverage([id.mirrored!]))).get(id.mirrored!));
    expect(said).toEqual({ examined: true, on: ["evidence_this_reader_can_read"] });
  });
});
