/**
 * A judgment at each label (src/db/schema.ts, "The judgment in force, and a
 * version at each label"; src/services/judgment-version-service.ts).
 *
 * Labels are `public`, `jl-a`, `jl-b` and `jl-c`: `jl-a` and `jl-b` read
 * `public`, `jl-c` reads `jl-a` and `public`, and `jl-a` and `jl-b` do not
 * read each other. Work with nothing in context is a connection that reads
 * `public` alone, as in a deployment, so every look at the rows is made by
 * someone: a run at a label, a person with a clearance, or the owner.
 *
 * What is held here: a node carries one current judgment at each label; a
 * run writes its own label's and no other's; a version on a node at
 * another label rests on material at its own label or is refused; what is
 * in force depends on who reads; work at one label on a node neither waits
 * on nor shows itself to another's; a version made beside one that has
 * since been replaced says so, and its reassessment is opened at its own
 * label and nowhere else; and a run changes no row at a label that is not
 * its own.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { runAtLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { versionsNote } from "../../src/llm/agents/steward-changes-note.js";
import { decideRequestLabel, LABEL_MESSAGES } from "../../src/server/plugins/request-label.js";
import { REQUEST_LABELS } from "../../src/server/request-labels.js";
import { ASSESS_GROUP } from "../../src/services/action-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { openInbox } from "../../src/services/inbox-service.js";
import { nodeVersions, versionWithoutMaterialMessage } from "../../src/services/judgment-version-service.js";
import { createOrder } from "../../src/services/order-service.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { openReassessmentsForVersionsMadeBesideEarlier } from "../../src/services/version-upkeep.js";
import { readViewsAs } from "./helpers.js";

const A = "jl-a";
const B = "jl-b";
const C = "jl-c";
const tag = randomUUID().slice(0, 8);

const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test of versions seeds and checks rows at every label.", fn);
/** A Steward's run at a label. */
const runAt = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a test's run", () => withAgent("steward", fn));
/** A person holding these labels, with everything they read. */
const person = async <T>(held: string[], fn: () => Promise<T>) => {
  const [row] = await system(() =>
    rawQuery<{ labels: string[] }>(`SELECT minerval_labels_readable_from($1::text[]) AS labels`, [held])
  );
  return runWithUsageContext({ clearance: row!.labels }, fn);
};
const sqlState = (err: unknown) => (err as { code?: string } | null)?.code;

const made: { claims: string[]; sources: string[]; users: string[] } = { claims: [], sources: [], users: [] };

async function seedNode(label: string, text: string, kind = "claim"): Promise<string> {
  const [row] = await system(() =>
    rawQuery<{ id: string }>(
      `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label)
       VALUES ($1, $2, 'done', 'complete', now(), $3) RETURNING id`,
      [`${text} (${tag} ${randomUUID().slice(0, 6)})`, kind, label]
    )
  );
  made.claims.push(row!.id);
  return row!.id;
}

/** A source at `label`, attached to the node by an instance at the same label: material at that label. */
async function attachSource(node: string, label: string): Promise<string> {
  return system(async () => {
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'A document held at a label', $2) RETURNING id`,
      [`https://dbtest.example/versions/${randomUUID()}`, label]
    );
    made.sources.push(source!.id);
    await rawQuery(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, sensitivity_label)
       VALUES ($1, $2, 'What the document says.', 'supports', $3)`,
      [node, source!.id, label]
    );
    return source!.id;
  });
}

const assess = async (node: string, status = "supported", words = "Judged.") =>
  JSON.parse(
    await executeStewardTool("update_claim_assessment", {
      claim_id: node,
      status,
      confidence: 0.7,
      assessment: words,
      reasoning_trace: `${words} The reasoning.`,
    })
  ) as { success: boolean; message: string };

/** The current versions on a node, as the owner sees them: label and status. */
const current = (node: string) =>
  system(() =>
    rawQuery<{ label: string; status: string }>(
      `SELECT sensitivity_label AS label, status FROM assessments WHERE claim_id = $1 AND is_current ORDER BY sensitivity_label`,
      [node]
    )
  );

/** What a connection is given: the one version a one-row read takes, and every version with whether it is in force. */
async function seen(node: string) {
  const goneBy = await rawQuery<{ label: string }>(
    `SELECT sensitivity_label AS label FROM assessments_in_force WHERE claim_id = $1`,
    [node]
  );
  const versions = await rawQuery<{ label: string; in_force: boolean }>(
    `SELECT sensitivity_label AS label, in_force FROM assessments_versions WHERE claim_id = $1 ORDER BY sensitivity_label`,
    [node]
  );
  return {
    goneBy: goneBy.map((r) => r.label),
    inForce: versions.filter((v) => v.in_force).map((v) => v.label),
    beside: versions.filter((v) => !v.in_force).map((v) => v.label),
  };
}

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'One partner.'), ($2, 'Another partner.'), ($3, 'Reads the first.')
       ON CONFLICT (name) DO NOTHING`,
      [A, B, C]
    );
    await rawQuery(
      `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public'), ($3, $1), ($3, 'public') ON CONFLICT DO NOTHING`,
      [A, B, C]
    );
  });
  await ensureEnforcement();
});

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM judgment_inputs WHERE judgment_id IN (SELECT id FROM assessments WHERE claim_id = ANY($1::uuid[]))`, [made.claims]);
    await rawQuery(`DELETE FROM action_allocations WHERE claim_id = ANY($1::uuid[])`, [made.claims]);
    await rawQuery(`DELETE FROM assessment_orders WHERE claim_id = ANY($1::uuid[])`, [made.claims]);
    await rawQuery(`DELETE FROM actions WHERE claim_id = ANY($1::uuid[])`, [made.claims]);
    await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [made.claims]);
    await rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[])`, [made.sources]);
    await rawQuery(`DELETE FROM contributors WHERE id = ANY($1::uuid[])`, [made.users]);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B, C]]);
  }).catch((err: unknown) => console.warn("[judgments-per-label] cleanup:", err instanceof Error ? err.message : err));
});

// ---------------------------------------------------------------------------

describe("a public node with a version at public, at a and at b", () => {
  let node = "";
  beforeAll(async () => {
    node = await seedNode(PUBLIC_LABEL, "The partners' joint product ships this year");
    await attachSource(node, A);
    await attachSource(node, B);
    expect((await runAt(PUBLIC_LABEL, () => assess(node, "inconclusive", "On the public record."))).success).toBe(true);
    expect((await runAt(A, () => assess(node, "supported", "With partner A's schedule."))).success).toBe(true);
    expect((await runAt(B, () => assess(node, "doubtful", "With partner B's audit."))).success).toBe(true);
  });

  it("carries all three as current, each written by a run at its label and none replaced by another's", async () => {
    expect(await current(node)).toEqual([
      { label: A, status: "supported" },
      { label: B, status: "doubtful" },
      { label: PUBLIC_LABEL, status: "inconclusive" },
    ]);
    // Each label's next write replaces its own version and leaves the others standing.
    expect((await runAt(PUBLIC_LABEL, () => assess(node, "inconclusive", "On the public record, read again."))).success).toBe(true);
    expect((await runAt(A, () => assess(node, "supported", "With partner A's schedule, read again."))).success).toBe(true);
    expect(await current(node)).toEqual([
      { label: A, status: "supported" },
      { label: B, status: "doubtful" },
      { label: PUBLIC_LABEL, status: "inconclusive" },
    ]);
    const [history] = await system(() =>
      rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM assessments WHERE claim_id = $1 AND NOT is_current`, [node])
    );
    expect(history!.n).toBe(2);
  });

  // Seven kinds of reader, and what each is given.
  const readers: Array<[string, () => Promise<Awaited<ReturnType<typeof seen>>>, { goneBy: string[]; inForce: string[]; beside: string[] }]> = [
    ["a reader who holds no label", () => person([], () => seen(node)), { goneBy: [PUBLIC_LABEL], inForce: [PUBLIC_LABEL], beside: [] }],
    ["a reader who holds a", () => person([A], () => seen(node)), { goneBy: [A], inForce: [A], beside: [PUBLIC_LABEL] }],
    ["a reader who holds b", () => person([B], () => seen(node)), { goneBy: [B], inForce: [B], beside: [PUBLIC_LABEL] }],
    ["a reader who holds c, which reads a", () => person([C], () => seen(node)), { goneBy: [A], inForce: [A], beside: [PUBLIC_LABEL] }],
    ["a run at a", () => runAt(A, () => seen(node)), { goneBy: [A], inForce: [A], beside: [PUBLIC_LABEL] }],
    ["a run at c, which has no version of its own and reads a's", () => runAt(C, () => seen(node)), { goneBy: [A], inForce: [A], beside: [PUBLIC_LABEL] }],
    ["a run at public", () => runAt(PUBLIC_LABEL, () => seen(node)), { goneBy: [PUBLIC_LABEL], inForce: [PUBLIC_LABEL], beside: [] }],
  ];
  for (const [who, look, expected] of readers) {
    it(`gives ${who} the version in force for them, with the rest beside it`, async () => {
      expect(await look()).toEqual(expected);
    });
  }

  it("gives a reader who holds a and b both, side by side: neither reads the other, and nothing is merged", async () => {
    const both = await person([A, B], () => seen(node));
    expect(both.inForce).toEqual([A, B]);
    expect(both.beside).toEqual([PUBLIC_LABEL]);
    // A read that takes one row for the node takes the more recently made of the two, which is a's.
    expect(both.goneBy).toEqual([A]);
    // The node's read serves both in force, each with its label, and the public one beside them.
    const view = await person([A, B], () => getClaimView(node));
    const claim = view!.claim as { label: string };
    const versions = view!.versions as Array<{ label: string; in_force: boolean; status: string }>;
    expect(claim.label).toBe(PUBLIC_LABEL);
    expect(versions.map((v) => [v.label, v.in_force, v.status])).toEqual([
      [A, true, "supported"],
      [B, true, "doubtful"],
      [PUBLIC_LABEL, false, "inconclusive"],
    ]);
    expect((view!.assessment as { status: string }).status).toBe("supported");
  });

  it("serves a reader who holds no label one version and no sign of the others, through the read and through read-only SQL", async () => {
    const view = await person([], () => getClaimView(node));
    expect((view!.versions as Array<{ label: string }>).map((v) => v.label)).toEqual([PUBLIC_LABEL]);
    expect(JSON.stringify(view)).not.toContain("partner A");
    expect(JSON.stringify(view)).not.toContain(A);
    const rows = await readViewsAs([PUBLIC_LABEL], `SELECT status, is_current FROM assessments WHERE node_id = '${node}' AND is_current`);
    expect(rows).toEqual([{ status: "inconclusive", is_current: true }]);
    // Read-only SQL for a reader of a: one row is current for them, a's.
    const forA = await readViewsAs([PUBLIC_LABEL, A], `SELECT status FROM assessments WHERE node_id = '${node}' AND is_current`);
    expect(forA).toEqual([{ status: "supported" }]);
  });

  it("tells a Steward at c which versions it reads, and that it has none of its own", async () => {
    const versions = await runAt(C, () => nodeVersions(node, "claim"));
    const note = versionsNote(C, versions!);
    expect(note).toContain(`This node carries the label \`public\`, and this run works at \`${C}\`.`);
    expect(note).toContain(`- \`${C}\`, this run's own: none recorded.`);
    expect(note).toMatch(new RegExp(`- \`${A}\`, recorded \\d{4}-\\d{2}-\\d{2}\\. It is the version in force for this run\\.`));
    expect(note).not.toContain(B);
  });
});

// ---------------------------------------------------------------------------

describe("a version on a node that carries another label", () => {
  it("is refused where nothing at its label bears on the node, with what would satisfy it, and the version it reads stands", async () => {
    const node = await seedNode(PUBLIC_LABEL, "A public claim with nothing private bearing on it");
    expect((await runAt(PUBLIC_LABEL, () => assess(node, "supported", "On the public record."))).success).toBe(true);
    const refused = await runAt(A, () => assess(node, "doubtful", "Read from a."));
    expect(refused.success).toBe(false);
    expect(refused.message).toBe(versionWithoutMaterialMessage({ label: A, nodeLabel: PUBLIC_LABEL }, "An assessment"));
    expect(refused.message).toContain("attach it first");
    expect(await current(node)).toEqual([{ label: PUBLIC_LABEL, status: "supported" }]);
    // The database refuses it too, whatever wrote it.
    const err = await runAt(A, () =>
      rawQuery(
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, 'doubtful', 0.6, 'Written past the tool.', true, $2)`,
        [node, A]
      )
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(sqlState(err)).toBe("MVL07");
    // For a reader of a, the public version is the one in force.
    expect(await person([A], () => seen(node))).toEqual({ goneBy: [PUBLIC_LABEL], inForce: [PUBLIC_LABEL], beside: [] });
  });

  it("is stored once material at its label is attached: a source, a node under it, or a node under it with a version there", async () => {
    // A source at a.
    const bySource = await seedNode(PUBLIC_LABEL, "A public claim a private document bears on");
    await attachSource(bySource, A);
    expect((await runAt(A, () => assess(bySource))).success).toBe(true);
    // A node at a under it.
    const byNode = await seedNode(PUBLIC_LABEL, "A public claim a private premise bears on");
    const premise = await seedNode(A, "A private premise");
    await system(() =>
      rawQuery(
        `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning, sensitivity_label)
         VALUES ($1, $2, 'supports', 'It bears.', $3)`,
        [byNode, premise, A]
      )
    );
    expect((await runAt(A, () => assess(byNode))).success).toBe(true);
    // A public node under it that carries a version at a.
    const byVersion = await seedNode(PUBLIC_LABEL, "A public claim resting on a public premise judged at a");
    await system(() =>
      rawQuery(
        `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning, sensitivity_label)
         VALUES ($1, $2, 'requires', 'It rests on it.', 'public')`,
        [byVersion, bySource]
      )
    );
    expect((await runAt(A, () => assess(byVersion))).success).toBe(true);
    // And it does not serve b, which has none of it.
    expect((await runAt(B, () => assess(byVersion))).success).toBe(false);
  });

  it("needs none where the node carries the run's own label: a private node's first judgment is simply its judgment", async () => {
    const node = await seedNode(A, "A claim that exists only at a");
    expect((await runAt(A, () => assess(node))).success).toBe(true);
    expect(await current(node)).toEqual([{ label: A, status: "supported" }]);
    // c reads a, and its own version of this node rests on material at c or is not stored.
    expect((await runAt(C, () => assess(node, "doubtful"))).success).toBe(false);
    await attachSource(node, C);
    expect((await runAt(C, () => assess(node, "doubtful"))).success).toBe(true);
    expect(await runAt(C, () => seen(node))).toEqual({ goneBy: [C], inForce: [C], beside: [A] });
    expect(await runAt(A, () => seen(node))).toEqual({ goneBy: [A], inForce: [A], beside: [] });
  });

  it("holds for a quantity's estimate as for a claim's assessment", async () => {
    const quantity = await seedNode(PUBLIC_LABEL, "Units shipped in the first quarter", "quantity");
    await runAt(PUBLIC_LABEL, () =>
      defineQuantity({
        claimId: quantity,
        definition: { measures: "Units shipped", population: "The first quarter", unit: { kind: "count", noun: "units", min: 0 } } as never,
        createdBy: "claim_steward",
      })
    );
    const estimate = (low: number, high: number) => ({ form: "interval", low, high }) as never;
    await runAt(PUBLIC_LABEL, () => recordEstimate({ claimId: quantity, estimate: estimate(10, 90), work: "From the public filings." }));
    await expect(
      runAt(A, () => recordEstimate({ claimId: quantity, estimate: estimate(40, 50), work: "From the order book." }))
    ).rejects.toThrow(/An estimate at `jl-a` is stored only when material at `jl-a` bears on the node/);
    await attachSource(quantity, A);
    await runAt(A, () => recordEstimate({ claimId: quantity, estimate: estimate(40, 50), work: "From the order book." }));
    const versions = await system(() =>
      rawQuery<{ label: string }>(
        `SELECT sensitivity_label AS label FROM quantity_estimates WHERE claim_id = $1 AND is_current ORDER BY 1`,
        [quantity]
      )
    );
    expect(versions.map((v) => v.label)).toEqual([A, PUBLIC_LABEL]);
    const view = await person([A], () => nodeVersions(quantity, "quantity"));
    expect(view!.versions.map((v) => [v.label, v.in_force])).toEqual([[A, true], [PUBLIC_LABEL, false]]);
  });
});

// ---------------------------------------------------------------------------

describe("a run and the rows of another label", () => {
  it("cannot reword, re-rank or retire what a node carries at another label, and is told why", async () => {
    const node = await seedNode(PUBLIC_LABEL, "A public claim an internal run would reword");
    const reworded = JSON.parse(
      await runAt(A, () => executeStewardTool("update_canonical_form", { claim_id: node, new_text: "A wording from a.", reasoning: "It reads better." }))
    ) as { success: boolean; message: string };
    expect(reworded.success).toBe(false);
    expect(reworded.message).toContain(`This node carries the label \`public\` and this run works at \`${A}\`.`);
    expect(reworded.message).toContain("wording and type belongs to the Steward that works at the node's own label");
    const ranked = JSON.parse(await runAt(A, () => executeStewardTool("set_claim_importance", { claim_id: node, importance: 0.9, reasoning: "It matters to us." })));
    expect(ranked.success).toBe(false);
    // The database holds the same line for any write: a change or a delete of a row at another label is refused.
    for (const statement of [
      `UPDATE claims SET text = 'Changed from a' WHERE id = $1`,
      `UPDATE claims SET importance = 0.9 WHERE id = $1`,
      `DELETE FROM claims WHERE id = $1`,
    ]) {
      const err = await runAt(A, () => rawQuery(statement, [node])).then(
        () => null,
        (e: unknown) => e
      );
      expect(sqlState(err), statement).toBe("MVL06");
    }
    const [row] = await system(() => rawQuery<{ text: string; importance: number }>(`SELECT text, importance FROM claims WHERE id = $1`, [node]));
    expect(row!.text).toContain("A public claim an internal run would reword");
    expect(row!.importance).toBe(0.5);
    // What it adds is its own: a decision logged at a leaves the node's row untouched.
    const logged = JSON.parse(
      await runAt(A, () => executeStewardTool("log_stewardship_decision", { claim_id: node, action_taken: "no_change", reasoning: "Nothing at a bears on it." }))
    );
    expect(logged.success).toBe(true);
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM audit_log WHERE claim_id = $1`, [node]))
    ).toEqual([{ l: A }]);
  });

  it("cannot retire another label's version by any write: each is replaced only by work at its own label", async () => {
    const node = await seedNode(PUBLIC_LABEL, "A public claim whose version an internal run would retire");
    await runAt(PUBLIC_LABEL, () => assess(node));
    const err = await runAt(A, () =>
      rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND is_current`, [node])
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(sqlState(err)).toBe("MVL02");
    expect(await current(node)).toEqual([{ label: PUBLIC_LABEL, status: "supported" }]);
  });
});

// ---------------------------------------------------------------------------

describe("work on one node at a and at public", () => {
  let node = "";
  let buyer = "";
  beforeAll(async () => {
    node = await seedNode(PUBLIC_LABEL, "A public claim worked on at two labels");
    const [who] = await system(() =>
      rawQuery<{ id: string }>(`INSERT INTO contributors (external_id, display_name) VALUES ($1, 'A buyer') RETURNING id`, [`jl-${tag}`])
    );
    buyer = who!.id;
    made.users.push(buyer);
    await runAt(PUBLIC_LABEL, () => enqueueSteward({ claimId: node, trigger: "steward_note", context: "A public note." }));
    await runAt(A, () => enqueueSteward({ claimId: node, trigger: "steward_note", context: "A note at a, about partner A's schedule." }));
  });

  it("has a row, a slot and an inbox for each label, and neither waits on the other", async () => {
    const rows = await system(() =>
      rawQuery<{ exclusion_group: string; l: string; status: string }>(
        `SELECT DISTINCT exclusion_group, sensitivity_label AS l, status FROM actions
          WHERE claim_id = $1 AND kind IN ('assess', 'reassess') ORDER BY exclusion_group`,
        [node]
      )
    );
    expect(rows).toEqual([
      { exclusion_group: ASSESS_GROUP(node, PUBLIC_LABEL), l: PUBLIC_LABEL, status: "open" },
      { exclusion_group: ASSESS_GROUP(node, A), l: A, status: "open" },
    ]);
    expect(ASSESS_GROUP(node, PUBLIC_LABEL)).toBe(`assess:${node}`);
    expect(ASSESS_GROUP(node, A)).toBe(`assess:${node} @${A}`);
    // The node's own row is the public work's slot; a's is its own row.
    const [own] = await system(() => rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [node]));
    expect(own!.steward_state).toBe("pending");
    expect(
      await system(() => rawQuery<{ l: string; steward_state: string }>(`SELECT sensitivity_label AS l, steward_state FROM steward_slots WHERE claim_id = $1`, [node]))
    ).toEqual([{ l: A, steward_state: "pending" }]);
    // The public pass finishes; a's row and a's slot are as they were.
    await runAt(PUBLIC_LABEL, () => rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [node]));
    await runAt(PUBLIC_LABEL, () => rawQuery(`UPDATE actions SET status = 'done' WHERE exclusion_group = $1`, [ASSESS_GROUP(node, PUBLIC_LABEL)]));
    expect(
      await system(() => rawQuery<{ status: string }>(`SELECT DISTINCT status FROM actions WHERE exclusion_group = $1`, [ASSESS_GROUP(node, A)]))
    ).toEqual([{ status: "open" }]);
    // Each pass reads its own label's messages.
    expect((await runAt(PUBLIC_LABEL, () => openInbox(node))).brief).not.toContain("partner A");
    expect((await runAt(A, () => openInbox(node))).brief).toContain("partner A's schedule");
    expect((await runAt(A, () => openInbox(node))).brief).not.toContain("A public note.");
  });

  it("shows the work at a to no reader who does not read a: not in the tables, not in the ledger view, not in a read of the node", async () => {
    for (const held of [[], [B]] as string[][]) {
      const who = `a reader holding ${held.length ? held.join(",") : "no label"}`;
      const tables = await person(held, async () => ({
        actions: (await rawQuery<{ l: string }>(`SELECT DISTINCT sensitivity_label AS l FROM actions WHERE claim_id = $1`, [node])).map((r) => r.l),
        messages: (await rawQuery<{ l: string }>(`SELECT DISTINCT sensitivity_label AS l FROM node_messages WHERE node_id = $1`, [node])).map((r) => r.l),
        slots: await rawQuery(`SELECT 1 FROM steward_slots WHERE claim_id = $1`, [node]),
      }));
      expect(tables, who).toEqual({ actions: [PUBLIC_LABEL], messages: [PUBLIC_LABEL], slots: [] });
      const view = JSON.stringify(await person(held, () => getClaimView(node)));
      expect(view, who).toContain("A public note.");
      expect(view, who).not.toContain("partner A");
      const ledger = await readViewsAs(
        [PUBLIC_LABEL, ...held],
        `SELECT count(*)::int AS n FROM ledger WHERE target_node_id = '${node}' AND kind IN ('assess', 'reassess')`
      );
      const all = await readViewsAs(
        [PUBLIC_LABEL, A],
        `SELECT count(*)::int AS n FROM ledger WHERE target_node_id = '${node}' AND kind IN ('assess', 'reassess')`
      );
      expect(Number(all[0]!.n), who).toBeGreaterThan(Number(ledger[0]!.n));
      const messages = await readViewsAs([PUBLIC_LABEL, ...held], `SELECT body FROM messages WHERE node_id = '${node}'`);
      expect(messages.map((m) => m.body), who).toEqual(["A public note."]);
    }
    // A reader of a reads both, since a reads public.
    const both = await person([A], () => rawQuery<{ l: string }>(`SELECT DISTINCT sensitivity_label AS l FROM node_messages WHERE node_id = $1 ORDER BY 1`, [node]));
    expect(both.map((r) => r.l)).toEqual([A, PUBLIC_LABEL]);
  });

  it("takes an order at each label from one person: an order is for a pass at its label", async () => {
    const atPublic = await runWithUsageContext({ label: PUBLIC_LABEL, clearance: [PUBLIC_LABEL, A] }, () => createOrder({ userId: buyer, claimId: node }));
    const atA = await runWithUsageContext({ label: A, clearance: [PUBLIC_LABEL, A] }, () => createOrder({ userId: buyer, claimId: node }));
    expect(atPublic.ok && atA.ok).toBe(true);
    const again = await runWithUsageContext({ label: A, clearance: [PUBLIC_LABEL, A] }, () => createOrder({ userId: buyer, claimId: node }));
    expect(again).toMatchObject({ ok: false, code: "ORDER_ALREADY_OPEN" });
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM assessment_orders WHERE claim_id = $1 ORDER BY 1`, [node]))
    ).toEqual([{ l: A }, { l: PUBLIC_LABEL }]);
    // A public reader sees their own public order and not the one at a.
    expect(
      await person([], () => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM assessment_orders WHERE claim_id = $1`, [node]))
    ).toEqual([{ l: PUBLIC_LABEL }]);
  });
});

// ---------------------------------------------------------------------------

describe("the label a request starts work at, on a node that is already there", () => {
  const rule = REQUEST_LABELS["POST /claims/:claim_id/order"]!;
  const standing = (clearance: string[]) => ({ member: true, grants: [], clearance, rawSources: [PUBLIC_LABEL] });
  const ask = (clearance: string[], node: string, body: Record<string, unknown>, fixedLabel?: { label: string; of: "API key" }) =>
    runWithUsageContext({ clearance, ...(fixedLabel ? { label: fixedLabel.label } : {}) }, () =>
      decideRequestLabel(rule, {
        auth: { standing: standing(clearance), ...(fixedLabel ? { fixedLabel } : {}) } as never,
        params: { claim_id: node },
        body,
      })
    );
  let node = "";
  beforeAll(async () => {
    node = await seedNode(PUBLIC_LABEL, "A public claim a member orders work on");
  });

  it("is the node's own when none is named, and one the person holds that reads the node's when they name it", async () => {
    expect(await ask([PUBLIC_LABEL, A], node, {})).toEqual({ label: PUBLIC_LABEL });
    expect(await ask([PUBLIC_LABEL, A], node, { label: A })).toEqual({ label: A });
    expect(await ask([PUBLIC_LABEL, A, C], node, { label: C })).toEqual({ label: C });
    // On a node at a: c reads it, b does not.
    const atA = await seedNode(A, "A claim at a");
    expect(await ask([PUBLIC_LABEL, A, C], atA, { label: C })).toEqual({ label: C });
    const sideways = await ask([PUBLIC_LABEL, A, B], atA, { label: B });
    expect(sideways).toMatchObject({ refusal: { status: 400, code: "LABEL_DOES_NOT_READ", labels: [A] } });
    expect((sideways as { refusal: { error: string } }).refusal.error).toBe(LABEL_MESSAGES.doesNotRead(B, "node", A, [A]));
    const down = await ask([PUBLIC_LABEL, A], atA, { label: PUBLIC_LABEL });
    expect(down).toMatchObject({ refusal: { code: "LABEL_DOES_NOT_READ" } });
  });

  it("is never one the person does not hold, and a node they may not read is not there", async () => {
    expect(await ask([PUBLIC_LABEL, A], node, { label: B })).toMatchObject({ refusal: { status: 403, code: "LABEL_NOT_READABLE" } });
    const atB = await seedNode(B, "A claim at b");
    expect(await ask([PUBLIC_LABEL, A], atB, {})).toMatchObject({ refusal: { status: 404, code: "NOT_FOUND" } });
  });

  it("is a credential's own label, on any node that label reads, with no label named", async () => {
    const key = { label: A, of: "API key" as const };
    expect(await ask([PUBLIC_LABEL, A], node, {}, key)).toEqual({ label: A });
    expect(await ask([PUBLIC_LABEL, A], node, { label: PUBLIC_LABEL }, key)).toMatchObject({ refusal: { code: "LABEL_FIXED" } });
    // Changing a row is still its own label's alone: a contribution's rule has no such opening.
    const contribute = REQUEST_LABELS["POST /appeals"]!;
    expect("orReader" in contribute).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("a version made beside one that is then replaced", () => {
  let node = "";
  beforeAll(async () => {
    node = await seedNode(PUBLIC_LABEL, "A public claim whose public version moves");
    await attachSource(node, A);
    await attachSource(node, B);
    await runAt(PUBLIC_LABEL, () => assess(node, "inconclusive", "The first public reading."));
    await runAt(A, () => assess(node, "supported", "With a's material."));
    await runAt(B, () => assess(node, "doubtful", "With b's material."));
    // The sweep is the whole deployment's: what the tests above left to be
    // opened is opened now, so that what follows counts this node alone.
    await openReassessmentsForVersionsMadeBesideEarlier();
  });

  it("records what it was made beside, and is shown as current against it", async () => {
    const forA = await person([A], () => nodeVersions(node, "claim"));
    const own = forA!.versions.find((v) => v.label === A)!;
    expect(own.made_beside).toEqual([{ label: PUBLIC_LABEL, replaced: false }]);
    expect(own.made_against_earlier).toBe(false);
    // Nothing is opened while nothing has moved.
    expect(await openReassessmentsForVersionsMadeBesideEarlier()).toBe(0);
  });

  it("is shown as made against an earlier version once the public one is replaced, from the record alone", async () => {
    await runAt(PUBLIC_LABEL, () => assess(node, "supported", "The second public reading."));
    const before = await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM node_messages WHERE node_id = $1`, [node]));
    for (const label of [A, B]) {
      const view = await person([label], () => nodeVersions(node, "claim"));
      const own = view!.versions.find((v) => v.label === label)!;
      expect(own.made_beside, label).toEqual([{ label: PUBLIC_LABEL, replaced: true }]);
      expect(own.made_against_earlier, label).toBe(true);
    }
    // The public version was made beside nothing, and reads as it did.
    const pub = (await person([], () => nodeVersions(node, "claim")))!.versions[0]!;
    expect(pub).toMatchObject({ label: PUBLIC_LABEL, made_beside: [], made_against_earlier: false });
    // Reading wrote nothing.
    expect(await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM node_messages WHERE node_id = $1`, [node]))).toEqual(before);
  });

  it("has its reassessment opened at its own label and at no other, once, and nothing is run", async () => {
    expect(await openReassessmentsForVersionsMadeBesideEarlier()).toBe(2);
    const opened = await system(() =>
      rawQuery<{ l: string; trigger: string; body: string }>(
        `SELECT sensitivity_label AS l, trigger, body FROM node_messages WHERE node_id = $1 ORDER BY sensitivity_label`,
        [node]
      )
    );
    expect(opened.map((m) => [m.l, m.trigger])).toEqual([
      [A, "version_beside_changed"],
      [B, "version_beside_changed"],
    ]);
    expect(opened[0]!.body).toContain(`The version at \`${A}\` was recorded beside the versions at the labels \`${A}\` reads`);
    expect(opened[0]!.body).toContain("- `public`: the version yours was made beside has been replaced by a newer one.");
    const rows = await system(() =>
      rawQuery<{ exclusion_group: string; l: string; status: string }>(
        `SELECT DISTINCT exclusion_group, sensitivity_label AS l, status FROM actions WHERE claim_id = $1 ORDER BY 1`,
        [node]
      )
    );
    // A row for a and a row for b, open and unfunded. None at public, none at c.
    expect(rows).toEqual([
      { exclusion_group: ASSESS_GROUP(node, A), l: A, status: "open" },
      { exclusion_group: ASSESS_GROUP(node, B), l: B, status: "open" },
    ]);
    expect(
      await system(() => rawQuery<{ l: string; steward_state: string }>(`SELECT sensitivity_label AS l, steward_state FROM steward_slots WHERE claim_id = $1 ORDER BY 1`, [node]))
    ).toEqual([
      { l: A, steward_state: "pending" },
      { l: B, steward_state: "pending" },
    ]);
    const [own] = await system(() => rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [node]));
    expect(own!.steward_state).toBe("done");
    // No money was placed and no run was started: opening runs nothing.
    expect(await system(() => rawQuery(`SELECT 1 FROM action_allocations WHERE claim_id = $1`, [node]))).toEqual([]);
    expect(await system(() => rawQuery(`SELECT 1 FROM agent_runs WHERE claim_id = $1`, [node]))).toEqual([]);
    // Asked once for this state of what it reads.
    expect(await openReassessmentsForVersionsMadeBesideEarlier()).toBe(0);
    // b's readers are not told of a's, nor a's of b's.
    expect(
      (await person([B], () => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM node_messages WHERE node_id = $1`, [node]))).map((r) => r.l)
    ).toEqual([B]);
  });

  it("is recorded beside the versions as they now stand when its Steward records it again", async () => {
    await runAt(A, () => assess(node, "supported", "With a's material, against the second public reading."));
    const own = (await person([A], () => nodeVersions(node, "claim")))!.versions.find((v) => v.label === A)!;
    expect(own.made_beside).toEqual([{ label: PUBLIC_LABEL, replaced: false }]);
    expect(own.made_against_earlier).toBe(false);
    // b's is still as it was.
    const other = (await person([B], () => nodeVersions(node, "claim")))!.versions.find((v) => v.label === B)!;
    expect(other.made_against_earlier).toBe(true);
  });
});
