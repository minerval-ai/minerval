/**
 * A judgment left standing, against a real PostgreSQL with enforcement on
 * (src/services/left-standing-service.ts; constitution §29).
 *
 * A Steward at a label, on a node at a label it reads, records its own
 * judgment or leaves the one it reads standing. This file is the second:
 * what is recorded, what a reader at each label is then told, that it puts
 * nothing in force, that it is open again once the judgment it left
 * standing is replaced and a reassessment is opened at its own label, that
 * a judgment recorded later takes its place, and that a label with a
 * judgment of its own may retire it and leave the other standing.
 *
 * Labels: a and b each read public and not each other; c reads a.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { runAtLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { readsAnothersJudgment } from "../../src/llm/agents/claim-steward.js";
import { executeLeaveStandingTool } from "../../src/llm/tools/leave-standing-tool.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { versionsNote } from "../../src/llm/agents/steward-changes-note.js";
import { ASSESS_GROUP } from "../../src/services/action-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { judgmentsInForce, nodeVersions } from "../../src/services/judgment-version-service.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { leftStandingChangedMessage, openReassessmentsForJudgmentsLeftStanding } from "../../src/services/version-upkeep.js";

const A = "ls-a";
const B = "ls-b";
const C = "ls-c";
const tag = randomUUID().slice(0, 8);
const RUN = randomUUID();

const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test of judgments left standing seeds and checks rows at every label.", fn);
/** A Steward's run at a label. */
const runAt = <T>(label: string, fn: () => Promise<T>) =>
  runAtLabel(label, "a test's run", () => withAgent("steward", () => runWithUsageContext({ runId: RUN }, fn)));
/** A person holding these labels, with everything they read. */
const person = async <T>(held: string[], fn: () => Promise<T>) => {
  const [row] = await system(() => rawQuery<{ labels: string[] }>(`SELECT minerval_labels_readable_from($1::text[]) AS labels`, [held]));
  return runWithUsageContext({ clearance: row!.labels }, fn);
};

const made: string[] = [];

async function seedNode(label: string, text: string, kind = "claim"): Promise<string> {
  const [row] = await system(() =>
    rawQuery<{ id: string }>(
      `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label)
       VALUES ($1, $2, 'done', 'complete', now(), $3) RETURNING id`,
      [`${text} (${tag} ${randomUUID().slice(0, 6)})`, kind, label]
    )
  );
  made.push(row!.id);
  return row!.id;
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

const leave = async (node: string, reasoning = "Queried the order book through the warehouse connection; nothing there changes the public reading.") =>
  JSON.parse((await executeLeaveStandingTool("leave_judgment_standing", { claim_id: node, reasoning }))!) as {
    success: boolean; message: string; left_standing?: string[]; retired_own?: boolean;
  };

const current = (node: string) =>
  system(() =>
    rawQuery<{ label: string; status: string }>(
      `SELECT sensitivity_label AS label, status FROM assessments WHERE claim_id = $1 AND is_current ORDER BY sensitivity_label`,
      [node]
    )
  );
const inForceFor = async (held: string[], node: string) =>
  (await person(held, () => rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM assessments_in_force WHERE claim_id = $1`, [node]))).map((r) => r.label);

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
}, 120_000);

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM judgment_inputs WHERE judgment_id IN (SELECT id FROM audit_log WHERE claim_id = ANY($1::uuid[]))`, [made]);
    await rawQuery(`DELETE FROM judgment_inputs WHERE judgment_id IN (SELECT id FROM assessments WHERE claim_id = ANY($1::uuid[]))`, [made]);
    await rawQuery(`DELETE FROM action_allocations WHERE claim_id = ANY($1::uuid[])`, [made]);
    await rawQuery(`DELETE FROM actions WHERE claim_id = ANY($1::uuid[])`, [made]);
    await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [made]);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B, C]]);
  }).catch((err: unknown) => console.warn("[left-standing] cleanup:", err instanceof Error ? err.message : err));
});

describe("a Steward at a that leaves the public judgment standing", () => {
  let node: string;
  let publicJudgment: string;
  beforeAll(async () => {
    node = await seedNode(PUBLIC_LABEL, "A public claim examined at a");
    expect((await runAt(PUBLIC_LABEL, () => assess(node, "supported", "On the public record."))).success).toBe(true);
    [{ id: publicJudgment }] = (await system(() => rawQuery<{ id: string }>(`SELECT id FROM assessments WHERE claim_id = $1 AND is_current`, [node]))) as [{ id: string }];
  });

  it("is told, before it has looked, that the node has not been examined at a, which is not a finding", async () => {
    const view = (await person([A], () => nodeVersions(node, "claim")))!;
    expect(view.left_standing).toEqual([]);
    expect(view.not_examined_at).toEqual([A]);
    // A reader of public alone is told nothing of other labels.
    const forPublic = (await person([], () => nodeVersions(node, "claim")))!;
    expect(forPublic.not_examined_at).toEqual([]);
    const read = (await person([A], () => getClaimView(node))) as unknown as Record<string, unknown>;
    expect(read.not_examined_at).toEqual([A]);
    expect(read.left_standing).toBeUndefined();
  });

  it("is given the task that names the two outcomes: the node is judged at a label it reads and not at its own", async () => {
    expect(await runAt(A, () => readsAnothersJudgment(node, "claim"))).toBe(true);
    // Not the Steward at the node's own label, and not on a node of the run's own.
    expect(await runAt(PUBLIC_LABEL, () => readsAnothersJudgment(node, "claim"))).toBe(false);
    const own = await seedNode(A, "A claim of a's own, for the task");
    expect(await runAt(A, () => readsAnothersJudgment(own, "claim"))).toBe(false);
  });

  it("records the label, the time, the run, the judgment left standing and its reasons, and no judgment", async () => {
    const out = await runAt(A, () => leave(node));
    expect(out).toEqual({
      success: true,
      left_standing: [PUBLIC_LABEL],
      retired_own: false,
      message:
        `Recorded. The judgment at \`public\` stands for readers at \`${A}\`, and the node's page shows them that it was examined at \`${A}\` ` +
        `today and left standing, with your reasoning. When that judgment is replaced, a reassessment at \`${A}\` is opened, which runs when it is funded.`,
    });
    expect(await current(node)).toEqual([{ label: PUBLIC_LABEL, status: "supported" }]);
    const rows = await system(() =>
      rawQuery<{ action: string; label: string; run_id: string | null; reasoning: string; beside: string; beside_label: string; row_label: string }>(
        `SELECT a.action, a.sensitivity_label AS label, a.run_id, a.reasoning, i.input_judgment_id AS beside,
                i.input_label AS beside_label, i.sensitivity_label AS row_label
           FROM audit_log a JOIN judgment_inputs i ON i.judgment_kind = 'left_standing' AND i.judgment_id = a.id
          WHERE a.claim_id = $1`,
        [node]
      )
    );
    expect(rows).toEqual([
      {
        action: "left_standing", label: A, run_id: RUN,
        reasoning: "Queried the order book through the warehouse connection; nothing there changes the public reading.",
        beside: publicJudgment, beside_label: PUBLIC_LABEL, row_label: A,
      },
    ]);
  });

  it("is shown to readers at a as examined and left standing, and to nobody who does not read a", async () => {
    const view = (await person([A], () => nodeVersions(node, "claim")))!;
    expect(view.not_examined_at).toEqual([]);
    expect(view.left_standing).toHaveLength(1);
    const [entry] = view.left_standing;
    expect(entry).toMatchObject({
      label: A,
      run_id: RUN,
      reasoning: "Queried the order book through the warehouse connection; nothing there changes the public reading.",
      judgments: [{ label: PUBLIC_LABEL, replaced: false }],
      open_again: false,
    });
    expect(entry!.examined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The read an agent makes and the API serves carry the same.
    const read = (await person([A], () => getClaimView(node))) as unknown as Record<string, unknown>;
    expect(read.left_standing).toEqual(view.left_standing);
    expect(read.not_examined_at).toBeUndefined();
    // c reads a, so it sees a's record, and is told that c itself has not examined the node.
    const forC = (await person([C], () => nodeVersions(node, "claim")))!;
    expect(forC.left_standing.map((e) => e.label)).toEqual([A]);
    expect(forC.not_examined_at).toEqual([C]);
    // b and a reader of public alone see nothing of it.
    for (const held of [[B], []]) {
      const other = (await person(held, () => nodeVersions(node, "claim")))!;
      expect(other.left_standing).toEqual([]);
      expect(await person(held, () => rawQuery(`SELECT 1 FROM audit_log WHERE claim_id = $1`, [node]))).toEqual([]);
    }
    // The Steward at a is told the same in the note of its node's versions.
    const note = versionsNote(A, view);
    expect(note).toMatch(
      new RegExp(`- \`${A}\`, this run's own: none recorded\\. A run at \`${A}\` examined the node on \\d{4}-\\d{2}-\\d{2} and left the judgment at \`public\` standing\\.`)
    );
  });

  it("puts nothing in force: every read that gives one judgment gives what it gave", async () => {
    expect(await inForceFor([A], node)).toEqual([PUBLIC_LABEL]);
    expect(await inForceFor([A, B], node)).toEqual([PUBLIC_LABEL]);
    const view = (await person([A], () => nodeVersions(node, "claim")))!;
    expect(view.versions.map((v) => [v.label, v.in_force])).toEqual([[PUBLIC_LABEL, true]]);
    expect(view.in_force).toBe(1);
    expect((await person([A, B], () => judgmentsInForce([node]))).size).toBe(0);
  });

  it("opens nothing while the public judgment stands", async () => {
    expect(await openReassessmentsForJudgmentsLeftStanding({ claimIds: [node] })).toBe(0);
    expect(await system(() => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1`, [node]))).toEqual([]);
  });

  it("is open again once the public judgment is replaced: readers are told, and a reassessment is opened at a alone, once", async () => {
    expect((await runAt(PUBLIC_LABEL, () => assess(node, "doubtful", "A second public reading."))).success).toBe(true);
    const view = (await person([A], () => nodeVersions(node, "claim")))!;
    expect(view.left_standing[0]).toMatchObject({ judgments: [{ label: PUBLIC_LABEL, replaced: true }], open_again: true });
    expect(versionsNote(A, view)).toContain(`What it left standing has been replaced since, so the question is open again at \`${A}\`.`);

    expect(await openReassessmentsForJudgmentsLeftStanding({ claimIds: [node] })).toBe(1);
    const messages = await system(() =>
      rawQuery<{ l: string; trigger: string; body: string }>(`SELECT sensitivity_label AS l, trigger, body FROM node_messages WHERE node_id = $1`, [node])
    );
    expect(messages).toEqual([{ l: A, trigger: "left_standing_changed", body: leftStandingChangedMessage(A, [PUBLIC_LABEL]) }]);
    expect(messages[0]!.body).toBe(
      `A run at \`${A}\` examined this node and left the judgment at \`public\` standing for readers at \`${A}\`, recording none of its own. ` +
        `That judgment has been replaced since. Readers at \`${A}\` read the newer one, and the node's page tells them it has not been looked at from \`${A}\`. ` +
        `Read the node as it stands with get_claim. Record your own judgment, or leave the newer one standing with leave_judgment_standing. You are told this once.`
    );
    expect(
      await system(() => rawQuery<{ exclusion_group: string; l: string; status: string }>(`SELECT DISTINCT exclusion_group, sensitivity_label AS l, status FROM actions WHERE claim_id = $1`, [node]))
    ).toEqual([{ exclusion_group: ASSESS_GROUP(node, A), l: A, status: "open" }]);
    // Nothing was paid for or run, and it is asked once.
    expect(await system(() => rawQuery(`SELECT 1 FROM action_allocations WHERE claim_id = $1`, [node]))).toEqual([]);
    expect(await openReassessmentsForJudgmentsLeftStanding()).toBe(0);
    // Nothing of it reaches a reader who does not read a.
    expect(await person([B], () => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1`, [node]))).toEqual([]);
  });

  it("is closed again when the Steward at a looks and leaves the newer one standing", async () => {
    expect((await runAt(A, () => leave(node, "Looked again against the second public reading."))).success).toBe(true);
    const view = (await person([A], () => nodeVersions(node, "claim")))!;
    expect(view.left_standing).toHaveLength(1);
    expect(view.left_standing[0]).toMatchObject({ reasoning: "Looked again against the second public reading.", open_again: false });
    expect(await openReassessmentsForJudgmentsLeftStanding({ claimIds: [node] })).toBe(0);
  });

  it("gives way to a judgment recorded at a afterwards, with nothing written to say so", async () => {
    expect((await runAt(A, () => assess(node, "supported", "With what a holds, read against the public reasoning."))).success).toBe(true);
    // With a judgment of its own, the Steward at a has the ordinary revisit's task.
    expect(await runAt(A, () => readsAnothersJudgment(node, "claim"))).toBe(false);
    const view = (await person([A], () => nodeVersions(node, "claim")))!;
    expect(view.left_standing).toEqual([]);
    expect(view.not_examined_at).toEqual([]);
    expect(view.versions.map((v) => [v.label, v.in_force])).toEqual([[A, true], [PUBLIC_LABEL, false]]);
    // The entries stay in the Steward's decision trail.
    expect(await system(() => rawQuery(`SELECT 1 FROM audit_log WHERE claim_id = $1 AND action = 'left_standing'`, [node]))).toHaveLength(2);
  });

  it("may later retire its own judgment and leave the public one standing, and the judgment stays in the node's history", async () => {
    const out = await runAt(A, () => leave(node, "The source a relied on was withdrawn; the public reading now covers it."));
    expect(out.success, out.message).toBe(true);
    expect(out.retired_own).toBe(true);
    expect(out.message).toMatch(new RegExp(`The assessment at \`${A}\` of \\d{4}-\\d{2}-\\d{2} is retired and stays in the node's history\\.$`));
    expect(await current(node)).toEqual([{ label: PUBLIC_LABEL, status: "doubtful" }]);
    expect(await system(() => rawQuery(`SELECT 1 FROM assessments WHERE claim_id = $1 AND sensitivity_label = $2 AND NOT is_current`, [node, A]))).toHaveLength(1);
    expect(await inForceFor([A], node)).toEqual([PUBLIC_LABEL]);
    const view = (await person([A], () => nodeVersions(node, "claim")))!;
    expect(view.left_standing.map((e) => [e.label, e.open_again])).toEqual([[A, false]]);
  });
});

describe("what the tool refuses, with the reason", () => {
  it("a node at the run's own label: there is no other judgment to leave standing", async () => {
    const node = await seedNode(A, "A claim that exists only at a");
    await runAt(A, () => assess(node));
    const out = await runAt(A, () => leave(node));
    expect(out.success).toBe(false);
    expect(out.message).toBe(
      `Not recorded. This node carries this run's own label, \`${A}\`, so its judgment at \`${A}\` is the node's own and there is none at another label ` +
        `to leave standing. If your judgment of it has not changed, say so with log_stewardship_decision.`
    );
  });

  it("a node with no judgment at a label the run reads: there is none to leave standing", async () => {
    const node = await seedNode(PUBLIC_LABEL, "A public claim nobody has assessed");
    const out = await runAt(A, () => leave(node));
    expect(out.success).toBe(false);
    expect(out.message).toBe(
      `Not recorded. No judgment of this node stands at a label \`${A}\` reads, so there is none to leave standing. Record your own with update_claim_assessment.`
    );
    expect(await system(() => rawQuery(`SELECT 1 FROM audit_log WHERE claim_id = $1`, [node]))).toEqual([]);
  });

  it("retiring a judgment whose page is under a standing showing: its readers would be shown a page with its judgment withdrawn", async () => {
    const node = await seedNode(PUBLIC_LABEL, "A public claim whose page at a is shown standing");
    await runAt(PUBLIC_LABEL, () => assess(node, "supported", "On the public record."));
    await runAt(A, () => assess(node, "doubtful", "With what a holds."));
    const showing = await system(async () => {
      const [mine] = await rawQuery<{ id: string }>(`SELECT id FROM assessments WHERE claim_id = $1 AND sensitivity_label = $2 AND is_current`, [node, A]);
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO showings (node_id, to_label, boundary_id, form, scope, sensitivity_label)
         VALUES ($1, 'public', gen_random_uuid(), 'standing', 'node', $2) RETURNING id`,
        [node, A]
      );
      await rawQuery(
        `INSERT INTO showing_pages (showing_id, node_id, judgment_kind, judgment_id, judged_at, sensitivity_label)
         VALUES ($1, $2, 'assessment', $3, now(), $4)`,
        [row!.id, node, mine!.id, A]
      );
      return row!.id;
    });
    const out = await runAt(A, () => leave(node));
    expect(out.success).toBe(false);
    expect(out.message).toBe(
      `Not recorded. This node's page at \`${A}\` is under a standing showing to readers who do not read \`${A}\`. Retiring the judgment at \`${A}\` ` +
        `would leave them shown a page whose judgment had been withdrawn, with nothing to tell them so. Ending a showing is for the people who direct this ` +
        `graph. Until then, record your judgment as it now stands with update_claim_assessment.`
    );
    expect((await current(node)).map((r) => r.label).sort()).toEqual([A, PUBLIC_LABEL].sort());
    // Once the showing has ended, it may.
    await system(() => rawQuery(`UPDATE showings SET ended_at = now() WHERE id = $1`, [showing]));
    expect((await runAt(A, () => leave(node))).retired_own).toBe(true);
    await system(() => rawQuery(`DELETE FROM showings WHERE id = $1`, [showing]));
  });

  it("a call with no reasoning", async () => {
    const node = await seedNode(PUBLIC_LABEL, "A public claim examined without a word");
    await runAt(PUBLIC_LABEL, () => assess(node));
    const out = await runAt(A, () => leave(node, "  "));
    expect(out.success).toBe(false);
    expect(out.message).toContain("Say in `reasoning` what you looked at and why you leave the judgment standing");
  });
});

describe("a label that reads another private label", () => {
  it("leaves standing the judgment made on the most it reads, and is open again when a label beneath that one gains a judgment", async () => {
    const node = await seedNode(PUBLIC_LABEL, "A public claim judged at public and at a, examined at c");
    await runAt(PUBLIC_LABEL, () => assess(node, "supported", "On the public record."));
    await runAt(A, () => assess(node, "doubtful", "With what a holds."));
    const out = await runAt(C, () => leave(node, "Nothing at c beyond what a already weighed."));
    expect(out.left_standing).toEqual([A]);
    expect(await inForceFor([C], node)).toEqual([A]);
    // a's judgment is replaced: c's question is open again.
    await runAt(A, () => assess(node, "supported", "A second reading at a."));
    const view = (await person([C], () => nodeVersions(node, "claim")))!;
    expect(view.left_standing.map((e) => [e.label, e.open_again])).toEqual([[C, true]]);
  });
});

describe("a quantity", () => {
  it("has its estimate left standing the same way", async () => {
    const quantity = await seedNode(PUBLIC_LABEL, "Units shipped in the second quarter", "quantity");
    await runAt(PUBLIC_LABEL, () =>
      defineQuantity({
        claimId: quantity,
        definition: { measures: "Units shipped", population: "The second quarter", unit: { kind: "count", noun: "units", min: 0 } } as never,
        createdBy: "claim_steward",
      })
    );
    await runAt(PUBLIC_LABEL, () => recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 10, high: 90 } as never, work: "From the public filings." }));
    const out = await runAt(A, () => leave(quantity, "The order book agrees with the public interval."));
    expect(out.success).toBe(true);
    const view = (await person([A], () => nodeVersions(quantity, "quantity")))!;
    expect(view.left_standing.map((e) => [e.label, e.judgments])).toEqual([[A, [{ label: PUBLIC_LABEL, replaced: false }]]]);
  });
});
