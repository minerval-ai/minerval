/**
 * Word from the layer below, against a real database with its wall up
 * (docs/architecture.md, "Word from the layer below").
 *
 * The model: a label stands to the labels it reads as a private graph
 * stands to the public graph. What is said, asked and changed below reaches
 * the work above; nothing the work above does about it is shown below.
 *
 * The labels are the review suite's (review-3-common.ts): `r3-a` reads
 * `public`, and `r3-c` reads `r3-a` and `public`, so public <- r3-a <- r3-c
 * is a chain of three, with `r3-a` in the place of a company-wide label and
 * `r3-c` in the place of a department's. Every case runs against two layers
 * (public <- r3-a) and against three.
 *
 * Each case takes what a run at each label below is given, before and after
 * the layer above has read, answered, taken up and changed things, and
 * expects the two to be the same to the byte.
 */
process.env.CONSISTENCY_SWEEPS_ENABLED = "true";

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/services/embedding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/embedding-service.js")>()),
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this test");
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { A, C, at, caught, seedNode, seedUser, sqlState, stewardAt, system, tag, unwall, version, wall } from "./review-3-common.js";
import { seedClaim, seedGrantWithJob } from "./helpers.js";
import {
  answerMessages,
  markMessagesRead,
  openInbox,
  postMessage,
  readMessage,
  saidBelowNote,
  waitingMessages,
} from "../../src/services/inbox-service.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { fileRequest, getRequest, listRequests, recordWork, setRequestState } from "../../src/services/request-service.js";
import { answerableBelow, takeUpFromBelow, takenUpAboveNote } from "../../src/services/request-adoption-service.js";
import { adoptRequestFromBelow } from "../../src/services/outward-acts-service.js";
import { executeKindTool } from "../../src/llm/tools/kind-tools.js";
import { createResearchTools } from "../../src/llm/tools/research-tools.js";
import { loadChangesBelowNote } from "../../src/llm/agents/changes-below-note.js";
import { getGeneralMandate, resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { fundCurationNow, fundRequestNow } from "../../src/services/maintenance-funding.js";
import { fundGrantSelfActions } from "../../src/services/allocation-service.js";
import { ensureRequestActions } from "../../src/services/action-service.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";

const PUBLIC = "public";
const NOW = Date.parse("2030-01-01T00:00:00Z");
const asMap = (m: Map<string, string>) => Object.fromEntries(m);
const rows = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => rawQuery<T>(sql, params);

/** Everything a run at `label` can learn about the node, its messages, its requests and what changed on it. */
async function whatARunIsGiven(label: string, node: string, requestIds: string[]): Promise<string> {
  return at(label, async () => {
    const inbox = await openInbox(node, NOW);
    return JSON.stringify({
      inbox: { brief: inbox.brief, labels: asMap(inbox.labels), ids: inbox.ids },
      waiting: await waitingMessages(node),
      requests: await Promise.all(requestIds.map((id) => getRequest(id))),
      listed: await listRequests({ claimId: node, limit: 50 }),
      changes: await loadChangesBelowNote(node, "claim"),
      rows: {
        messages: await rows(`SELECT * FROM node_messages WHERE node_id = $1 ORDER BY created_at, id`, [node]),
        reads: await rows(
          `SELECT r.* FROM node_message_reads r JOIN node_messages m ON m.id = r.message_id WHERE m.node_id = $1 ORDER BY r.message_id`,
          [node]
        ),
        requests: await rows(
          `SELECT r.* FROM requests r WHERE r.id IN (SELECT request_id FROM request_targets WHERE claim_id = $1) ORDER BY r.created_at, r.id`,
          [node]
        ),
        work: await rows(
          `SELECT w.* FROM request_work w WHERE w.request_id IN (SELECT request_id FROM request_targets WHERE claim_id = $1) ORDER BY w.created_at, w.id`,
          [node]
        ),
        adopted: await rows(`SELECT * FROM adopted_requests ORDER BY adopted_at, id`),
        actions: await rows(
          `SELECT a.id, a.kind, a.status, a.variant, a.exclusion_group, a.sensitivity_label FROM actions a
            WHERE a.claim_id = $1 OR a.target_ref IN (SELECT request_id::text FROM request_targets WHERE claim_id = $1)
            ORDER BY a.created_at, a.id`,
          [node]
        ),
        allocations: await rows(
          `SELECT al.exclusion_group, al.amount_micro_usd FROM action_allocations al
            WHERE al.exclusion_group IN (SELECT 'request:' || request_id::text FROM request_targets WHERE claim_id = $1)
            ORDER BY al.created_at`,
          [node]
        ),
        changes: await rows(`SELECT * FROM node_changes WHERE claim_id = $1 ORDER BY applied_at, id`, [node]),
        slots: await rows(`SELECT * FROM steward_slots WHERE claim_id = $1 ORDER BY sensitivity_label`, [node]),
        node: await rows(`SELECT text, kind, state, steward_state, steward_trigger FROM claims WHERE id = $1`, [node]),
      },
    });
  });
}

const generals: Record<string, string> = {};

async function seedGeneral(label: string, ageDays: number): Promise<string> {
  const funder = await seedUser();
  const { grantId } = await at(label, () => seedGrantWithJob({ funderId: funder, budgetMicroUsd: 500_000_000, policy: "general" }));
  await system(() =>
    rawQuery(`UPDATE grants SET is_platform = true, status = 'active', created_at = now() - make_interval(days => $2) WHERE id = $1`, [grantId, ageDays])
  );
  return grantId;
}

describe("one label: nothing here changes what a graph with `public` alone does", () => {
  it("writes no change rows, marks no message with a label, and reads and answers on the message itself", async () => {
    const node = await seedClaim("one label");
    await rawQuery(`UPDATE claims SET text = text || ' reworded', kind = 'question' WHERE id = $1`, [node]);
    await rawQuery(`INSERT INTO arguments (claim_id, name, stance, content, created_by) VALUES ($1, 'An argument', 'supports', 'Because.', 'test')`, [node]);
    expect(await rawQuery(`SELECT 1 FROM node_changes WHERE claim_id = $1`, [node])).toEqual([]);
    expect(await loadChangesBelowNote(node, "question")).toBe("");

    await postMessage({ nodeId: node, trigger: "steward_note", body: "one label, one inbox" });
    const inbox = await openInbox(node, NOW);
    expect(inbox.brief).not.toContain("said at");
    expect(inbox.brief).not.toContain(saidBelowNote(PUBLIC));
    expect(JSON.parse(await answerMessages(node, inbox.labels, [{ message: "m1", outcome: "no_change" }])).message).toBe(
      "Recorded 1 answer(s); 0 reached their senders as replies."
    );
    await markMessagesRead(inbox.ids);
    const [m] = await rawQuery<{ read: boolean; outcome: string }>(`SELECT read_at IS NOT NULL AS read, outcome FROM node_messages WHERE node_id = $1`, [node]);
    expect(m).toEqual({ read: true, outcome: "no_change" });
    expect(await rawQuery(`SELECT 1 FROM node_message_reads`)).toEqual([]);
  });
});

describe.each([
  { name: "two layers (public <- r3-a)", below: [PUBLIC], top: A },
  { name: "three layers (public <- r3-a <- r3-c)", below: [PUBLIC, A], top: C },
])("word from below: $name", ({ below, top }) => {
  let node: string;
  let child: string;
  let argument: string;
  const said: Record<string, string> = {};
  const requests: Record<string, string> = {};
  const before: Record<string, string> = {};
  let grantAtTop: string;
  let snapshotAt: Date;

  beforeAll(async () => {
    await wall();
    await system(() => rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`));
    resetAllocationPolicyCache();
    // A General mandate at every label, the one at `public` the oldest: the one the old lookup took for all.
    for (const [i, label] of [...below, top].entries()) generals[label] = await seedGeneral(label, 30 - i);
    resetAllocationPolicyCache();

    node = await seedNode(PUBLIC, "The reservoir holds enough for the summer");
    child = await seedNode(below.at(-1)!, "The spring inflow was above average");
    await at(below.at(-1)!, () =>
      rawQuery(`INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning) VALUES ($1, $2, 'A premise.')`, [node, child])
    );
    const [arg] = await at(below.at(-1)!, () =>
      rawQuery<{ id: string }>(
        `INSERT INTO arguments (claim_id, name, stance, content, created_by) VALUES ($1, 'From the gauge readings', 'supports', 'The gauges show it.', 'test') RETURNING id`,
        [node]
      )
    );
    argument = arg!.id;
    for (const label of below) await version(node, label, "supported", `Reasoning at ${label}.`);
    await version(node, top, "supported", `Reasoning at ${top}.`);
    await system(() => rawQuery(`UPDATE assessments SET assessed_at = now() - interval '1 hour' WHERE claim_id = $1`, [node]));

    // What is said and asked at each label below.
    for (const label of below) {
      await at(label, async () => {
        said[label] = (await postMessage({ nodeId: node, trigger: "steward_note", body: `SAID-AT-${label}: the gauge was recalibrated in May.` }))!;
        requests[label] = (
          await fileRequest({
            ask: `ASKED-AT-${label}: obtain the utility's internal inflow ledger`,
            why: "It would settle whether the spring inflow figure is right.",
            satisfiedBy: "The ledger's monthly totals for the year.",
            claimIds: [node],
            filer: { kind: "admin", agent: "claim_steward" },
          })
        ).id;
      });
    }
    const funder = await seedUser();
    grantAtTop = (await at(top, () => seedGrantWithJob({ funderId: funder, budgetMicroUsd: 200_000_000 }))).grantId;
    for (const label of below) before[label] = await whatARunIsGiven(label, node, Object.values(requests));
    snapshotAt = (await rawQuery<{ now: Date }>(`SELECT clock_timestamp() AS now`))[0]!.now;
  }, 120_000);

  afterAll(async () => {
    await system(async () => {
      await rawQuery(`DELETE FROM mandate_inbox WHERE grant_id = ANY($1::uuid[])`, [Object.values(generals)]);
      await rawQuery(`DELETE FROM action_allocations WHERE grant_id = ANY($1::uuid[])`, [[...Object.values(generals), grantAtTop]]);
      await rawQuery(`DELETE FROM adopted_requests WHERE from_request_id = ANY($1::uuid[])`, [Object.values(requests)]);
      await rawQuery(`DELETE FROM actions WHERE kind IN ('request', 'consistency_sweep') AND created_at > now() - interval '1 hour'`);
      await rawQuery(`DELETE FROM requests WHERE id IN (SELECT request_id FROM request_targets WHERE claim_id = $1)`, [node]);
      await rawQuery(`DELETE FROM node_changes WHERE claim_id = ANY($1::uuid[])`, [[node, child]]);
      await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = ANY($1::uuid[])`, [[...Object.values(generals), grantAtTop]]);
    }).catch(() => undefined);
    resetAllocationPolicyCache();
    await unwall();
  }, 120_000);

  // ---- 1. messages ----------------------------------------------------------------------

  it("a pass above is given what was said below, each marked with its label, beside what was said at its own", async () => {
    await at(top, () => postMessage({ nodeId: node, trigger: "steward_note", body: `SAID-AT-${top}: the sealed audit disagrees.` }));
    const inbox = await stewardAt(top, () => openInbox(node, NOW));
    expect(inbox.ids).toHaveLength(below.length + 1);
    for (const label of below) {
      expect(inbox.brief).toContain(`SAID-AT-${label}`);
      expect(inbox.brief).toMatch(new RegExp(`\\[m\\d\\] steward_note · .* · said at \`${label}\`\\nSAID-AT-${label}`));
    }
    // Its own is not marked, and the pass is told once what the mark means.
    expect(inbox.brief).toMatch(new RegExp(`\\[m\\d\\] steward_note · [^\\n]*the system\\nSAID-AT-${top}`));
    expect(inbox.brief.split(saidBelowNote(top))).toHaveLength(2);

    // Nothing was opened above when the message arrived below: no slot, no ledger row.
    const slots = await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM steward_slots WHERE claim_id = $1 AND steward_state = 'pending'`, [node]));
    expect(slots).toEqual([]);

    // Reading and answering at the top label writes at the top label alone.
    const mBelow = [...inbox.labels.entries()].find(([, id]) => id === said[below[0]!])![0];
    const read = JSON.parse(await stewardAt(top, () => readMessage(inbox.labels, mBelow)));
    expect(read).toMatchObject({ said_at: below[0], body: expect.stringContaining(`SAID-AT-${below[0]}`) });
    const answered = JSON.parse(
      await stewardAt(top, () =>
        answerMessages(
          node,
          inbox.labels,
          [...inbox.labels.keys()].map((message) => ({ message, outcome: "changed", note: "ANSWERED-ABOVE on what the sealed audit shows." }))
        )
      )
    );
    expect(answered.message).toBe(
      `Recorded ${below.length + 1} answer(s); 0 reached their senders as replies. ${below.length} answered a message sent at another label: ` +
        `recorded at \`${top}\` and not sent to the sender.`
    );
    await stewardAt(top, () => markMessagesRead(inbox.ids));

    const kept = await system(() =>
      rawQuery<{ message_id: string; outcome: string; l: string }>(
        `SELECT r.message_id, r.outcome, r.sensitivity_label AS l FROM node_message_reads r JOIN node_messages m ON m.id = r.message_id WHERE m.node_id = $1`,
        [node]
      )
    );
    expect(kept.map((k) => k.message_id).sort()).toEqual(below.map((l) => said[l]!).sort());
    expect(new Set(kept.map((k) => `${k.l}:${k.outcome}`))).toEqual(new Set([`${top}:changed`]));
    // The messages below are untouched: unread and unanswered for their own Steward.
    const untouched = await system(() =>
      rawQuery<{ read_at: unknown; outcome: unknown; answered_at: unknown }>(`SELECT read_at, outcome, answered_at FROM node_messages WHERE id = ANY($1::uuid[])`, [Object.values(said)])
    );
    expect(untouched).toEqual(below.map(() => ({ read_at: null, outcome: null, answered_at: null })));

    // "Since it last looked": the next pass above is given only what has been said since.
    expect((await stewardAt(top, () => openInbox(node, NOW))).ids).toEqual([]);
    const later = await at(below.at(-1)!, () => postMessage({ nodeId: node, trigger: "steward_note", body: "SAID-LATER below." }));
    expect((await stewardAt(top, () => openInbox(node, NOW))).ids).toEqual([later]);
    // The before-and-after comparison below is of the state without this later message.
    await system(() => rawQuery(`DELETE FROM node_messages WHERE id = $1`, [later]));
  });

  it("a message's own pass below, reading and answering it, is shown above with what it answered", async () => {
    const other = await seedNode(PUBLIC, "A second node for the answer case");
    const label = below.at(-1)!;
    const id = (await at(label, () => postMessage({ nodeId: other, trigger: "steward_note", body: "A point made below." })))!;
    const own = await stewardAt(label, () => openInbox(other, NOW));
    await stewardAt(label, () => answerMessages(other, own.labels, [{ message: "m1", outcome: "disagree", note: "The public record does not bear it out." }]));
    await stewardAt(label, () => markMessagesRead(own.ids));
    // Read and answered below, and still new to the layer above, which may weigh it differently.
    const above = await stewardAt(top, () => openInbox(other, NOW));
    expect(above.ids).toEqual([id]);
    expect(above.brief).toContain(`The pass at \`${label}\` answered: disagrees. The public record does not bear it out.`);
    // A paid message below paid for a pass below, and is not read above as paying for this one.
    await at(label, () => postMessage({ nodeId: other, trigger: "user_order", body: "Paid below.", paid: true }));
    const paid = await stewardAt(top, () => openInbox(other, NOW));
    expect(paid.brief).toContain(`· paid for a pass at \`${label}\``);
    expect(paid.brief).not.toContain("paid for this pass");
  });

  it("a message sent below opens work below and none above", async () => {
    const other = await seedNode(PUBLIC, "A third node for the queue case");
    const label = below.at(-1)!;
    await at(label, () => enqueueSteward({ claimId: other, trigger: "steward_note", context: "Look at this.", sender: { kind: "system" } }));
    const pending = await system(() =>
      rawQuery<{ l: string }>(
        `SELECT sensitivity_label AS l FROM steward_slots WHERE claim_id = $1 AND steward_state = 'pending'
         UNION ALL SELECT sensitivity_label FROM claims WHERE id = $1 AND steward_state = 'pending'`,
        [other]
      )
    );
    expect(pending.map((p) => p.l)).toEqual([label]);
    const assess = await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM actions WHERE claim_id = $1 AND kind IN ('assess', 'reassess')`, [other]));
    expect(assess.every((a) => a.l === label)).toBe(true);
  });

  // ---- 2. requests ----------------------------------------------------------------------

  it("a request below is taken up above: funded by a mandate there, worked there, the result recorded there and linked", async () => {
    const asked = requests[below.at(-1)!]!;
    const askedAt = below.at(-1)!;
    // A Grantmaker at the top label funds the request it reads below.
    const tools = createResearchTools({ requestedBy: "grantmaker", grantId: grantAtTop });
    const funded = JSON.parse(
      (await at(top, () => runWithUsageContext({ label: top, grantId: grantAtTop }, () => tools.execute("fund_request", { request_id: asked, budget_usd: 2 }))))!
    );
    expect(funded.success).toBe(true);
    const here: string = funded.request_id;
    expect(here).not.toBe(asked);
    expect(funded.taken_up_from).toBe(asked);
    expect(funded.taken_up).toBe(takenUpAboveNote({ id: asked, label: askedAt }, { id: here, label: top }));
    expect(funded.taken_up).toBe(
      `Request ${asked} was filed at \`${askedAt}\`, which this run reads and does not change. It is taken up at \`${top}\` as request ${here}, ` +
        `linked to it, and that is the request this acted on. Readers at \`${askedAt}\` are not shown that it was taken up or what was found.`
    );

    const state = await system(async () => ({
      request: (await rawQuery<{ l: string; ask: string }>(`SELECT sensitivity_label AS l, ask FROM requests WHERE id = $1`, [here]))[0],
      link: (await rawQuery<{ l: string; from_request_id: string; public_request_id: string | null }>(`SELECT sensitivity_label AS l, from_request_id, public_request_id FROM adopted_requests WHERE request_id = $1`, [here]))[0],
      money: await rawQuery<{ g: string; l: string; target: string }>(
        `SELECT al.grant_id AS g, a.sensitivity_label AS l, a.target_ref AS target FROM action_allocations al JOIN actions a ON a.id = al.action_id WHERE al.grant_id = $1`,
        [grantAtTop]
      ),
      onTheRowBelow: await rawQuery(`SELECT 1 FROM action_allocations WHERE exclusion_group = 'request:' || $1`, [asked]),
    }));
    expect(state.request).toEqual({ l: top, ask: `ASKED-AT-${askedAt}: obtain the utility's internal inflow ledger` });
    expect(state.link).toEqual({ l: top, from_request_id: asked, public_request_id: null });
    expect(state.money).toEqual([{ g: grantAtTop, l: top, target: here }]);
    expect(state.onTheRowBelow).toEqual([]);

    // The work is done at the top label and recorded there; the keeper there closes it.
    await at(top, () => recordWork({ requestId: here, byLabel: "Researcher", outcome: "met", summary: "RESULT-ABOVE: the ledger's totals, read where it is held." }));
    const closed = JSON.parse(
      (await stewardAt(top, () => executeKindTool("close_request", { request_id: asked, state: "met", note: "The ledger settles it." }, { role: "claim_steward", claimId: node })))!
    );
    expect(closed).toMatchObject({ success: true, request_id: here });
    const result = await system(async () => ({
      work: await rawQuery<{ l: string; summary: string }>(`SELECT sensitivity_label AS l, summary FROM request_work WHERE request_id = $1`, [here]),
      here: (await rawQuery<{ state: string }>(`SELECT state FROM requests WHERE id = $1`, [here]))[0]!.state,
      below: (await rawQuery<{ state: string; state_note: string | null }>(`SELECT state, state_note FROM requests WHERE id = $1`, [asked]))[0],
      workBelow: await rawQuery(`SELECT 1 FROM request_work WHERE request_id = $1`, [asked]),
    }));
    expect(result.work).toEqual([{ l: top, summary: "RESULT-ABOVE: the ledger's totals, read where it is held." }]);
    expect(result.here).toBe("met");
    expect(result.below).toEqual({ state: "open", state_note: null });
    expect(result.workBelow).toEqual([]);

    // Linked both ways for a reader above, and the seam for an answer going down.
    const [fromAbove, theOneBelow] = await at(top, () => Promise.all([getRequest(here), getRequest(asked)]));
    expect(fromAbove!.taken_up_from).toEqual({ request_id: asked, label: askedAt });
    expect(theOneBelow!.taken_up_at).toEqual([{ label: top, request_id: here, state: "met" }]);
    expect(await at(top, () => answerableBelow(here))).toMatchObject({
      asked: { request_id: asked, label: askedAt },
      answered_by: { request_id: here, label: top, state: "met" },
    });
    // The asker's label is shown none of it.
    const seenBelow = await at(askedAt, () => getRequest(asked));
    expect(seenBelow).not.toHaveProperty("taken_up_at");
    expect(await at(askedAt, () => getRequest(here))).toBeNull();
    expect(await at(askedAt, () => answerableBelow(here))).toBeNull();
  });

  it("a label takes a request up once, a person who directs can do it by name, and a request at the label itself is not taken up", async () => {
    const asked = requests[below[0]!]!;
    const person = await seedUser();
    const actor = { id: person, holding: ["direct"], clearance: [PUBLIC, A, C], releaseParties: [], direct: true };
    const first = await runWithUsageContext({ clearance: actor.clearance }, () => adoptRequestFromBelow({ requestId: asked, label: top, actor }));
    const again = await at(top, () => takeUpFromBelow({ requestId: asked }, { filer: { kind: "admin", agent: "curator" } }));
    expect(again).toMatchObject({ request_id: first.request_id, already: true });
    expect(await at(below[0]!, () => takeUpFromBelow({ requestId: asked }, { filer: { kind: "admin", agent: "curator" } }))).toBeNull();
    // A label the person does not read, and a request the label does not read.
    expect(sqlStateOrCode(await caught(() => adoptRequestFromBelow({ requestId: asked, label: top, actor: { ...actor, clearance: [PUBLIC] } })))).toBe("LABEL_NOT_READ");
    const above = (await at(top, () => fileRequest({ ask: "Asked above", why: "w", satisfiedBy: "s", claimIds: [node], filer: { kind: "admin", agent: "claim_steward" } }))).id;
    expect(
      sqlStateOrCode(await caught(() => runWithUsageContext({ clearance: actor.clearance }, () => adoptRequestFromBelow({ requestId: above, label: below[0]!, actor }))))
    ).toBe("REQUEST_NOT_FOUND");
  });

  // ---- 3. changes -----------------------------------------------------------------------

  it("a rewording, an argument retired, a kind corrected and a node withdrawn below are told to the Steward above", async () => {
    const label = below.at(-1)!;
    const text = (await system(() => rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [child])))[0]!.text;
    // Each is work at the row's own label: the wording and kind of the child, an argument on the node.
    await at(label, async () => {
      await rawQuery(`UPDATE claims SET text = $2 WHERE id = $1`, [child, `${text} REWORDED-BELOW`]);
      await rawQuery(`UPDATE claims SET kind = 'quantity' WHERE id = $1`, [child]);
      await rawQuery(`UPDATE arguments SET retired_at = now(), retired_reason = 'RETIRED-BELOW: superseded' WHERE id = $1`, [argument]);
      await rawQuery(`UPDATE arguments SET content = content WHERE id = $1`, [argument]);
    });
    const written = await system(() => rawQuery<{ change: string; l: string; seq: number | null }>(`SELECT change, sensitivity_label AS l, sequence AS seq FROM node_changes WHERE claim_id = ANY($1::uuid[]) ORDER BY applied_at, id`, [[node, child]]));
    expect(written).toEqual([
      // The argument was added below before the version above was backdated, in the setup.
      { change: "argument_added", l: label, seq: null },
      { change: "reworded", l: label, seq: null },
      { change: "kind_corrected", l: label, seq: null },
      { change: "argument_retired", l: label, seq: null },
    ]);
    const note = await stewardAt(top, () => loadChangesBelowNote(node, "claim"));
    const today = new Date().toISOString().slice(0, 10);
    expect(note.split("\n")[0]).toBe(`What work at \`${label}\` has changed, since the version at \`${top}\` was recorded on ${today}:`);
    expect(note).toContain(
      `Arguments on this node (2):\n- ${argument} "From the gauge readings" was added, ${today}\n` +
        `- ${argument} "From the gauge readings" was retired (RETIRED-BELOW: superseded), ${today}`
    );
    expect(note).toContain(`Nodes under it reworded (1):\n- ${child} "${text} REWORDED-BELOW", ${today}. It read: "${text}"`);
    expect(note).toContain(`Nodes under it whose kind was corrected (1):\n- ${child} "${text} REWORDED-BELOW", ${today}. It was a claim and is now a quantity.`);
    expect(note).not.toContain("the public graph");

    await at(label, () => rawQuery(`UPDATE claims SET state = 'deprecated' WHERE id = $1`, [child]));
    expect(await stewardAt(top, () => loadChangesBelowNote(node, "claim"))).toContain(`Nodes under it withdrawn (1):\n- ${child}`);
    // The label that made the changes is not told its own work back, and no pass was opened above.
    expect(await stewardAt(label, () => loadChangesBelowNote(node, "claim"))).toBe("");
    expect(await system(() => rawQuery(`SELECT 1 FROM steward_slots WHERE claim_id = $1 AND sensitivity_label = $2 AND steward_state = 'pending'`, [node, top]))).toEqual([]);
    await at(label, () => rawQuery(`UPDATE claims SET state = 'active', kind = 'claim', text = $2 WHERE id = $1`, [child, text]));
  });

  it("what the layer above changes on its own rows is written at its label and not told below", async () => {
    const own = await seedNode(top, "A node of the top label's own");
    await at(top, async () => {
      await rawQuery(`INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning) VALUES ($1, $2, 'A premise held above.')`, [node, own]);
      await rawQuery(`UPDATE claims SET text = text || ' REWORDED-ABOVE' WHERE id = $1`, [own]);
      await rawQuery(`INSERT INTO arguments (claim_id, name, stance, content, created_by) VALUES ($1, 'ARGUED-ABOVE', 'opposes', 'The sealed audit.', 'test')`, [node]);
    });
    const written = await system(() => rawQuery<{ change: string; l: string }>(`SELECT change, sensitivity_label AS l FROM node_changes WHERE claim_id = $1 OR detail->>'name' = 'ARGUED-ABOVE' ORDER BY change`, [own]));
    expect(written).toEqual([{ change: "argument_added", l: top }, { change: "reworded", l: top }]);
    for (const label of below) {
      expect(await at(label, () => rawQuery(`SELECT 1 FROM node_changes WHERE sensitivity_label = $1`, [top]))).toEqual([]);
      expect(await stewardAt(label, () => loadChangesBelowNote(node, "claim"))).not.toContain("ABOVE");
    }
  });

  // ---- nothing above reaches below --------------------------------------------------------

  it("what a run at each label below is given is the same, to the byte, as before the layer above read, answered, took up and changed anything", async () => {
    // The rows the changes case wrote below are below's own; take them away so that only the layer above's activity differs.
    await system(async () => {
      await rawQuery(`DELETE FROM node_changes WHERE claim_id = ANY($1::uuid[]) AND sensitivity_label = ANY($2::text[]) AND applied_at > $3`, [[node, child], below, snapshotAt]);
      await rawQuery(`UPDATE arguments SET retired_at = NULL, retired_reason = NULL WHERE id = $1`, [argument]);
    });
    const above = await system(async () => ({
      reads: (await rawQuery(`SELECT 1 FROM node_message_reads r JOIN node_messages m ON m.id = r.message_id WHERE m.node_id = $1`, [node])).length,
      adopted: (await rawQuery(`SELECT 1 FROM adopted_requests WHERE from_request_id = ANY($1::uuid[])`, [Object.values(requests)])).length,
      messages: (await rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1 AND sensitivity_label = $2`, [node, top])).length,
    }));
    // There was activity above to hide.
    expect(above.reads).toBeGreaterThanOrEqual(below.length);
    expect(above.adopted).toBeGreaterThanOrEqual(1);
    expect(above.messages).toBe(1);
    for (const label of below) {
      const after = await whatARunIsGiven(label, node, Object.values(requests));
      expect(after).toBe(before[label]);
      expect(after).not.toContain("ABOVE");
      expect(after).not.toContain(top);
    }
  });

  // ---- 4. upkeep --------------------------------------------------------------------------

  it("each label's upkeep is its own General mandate's: the lookup, what is raised, and the sweep it pays for", async () => {
    resetAllocationPolicyCache();
    for (const label of [...below, top]) {
      expect((await at(label, () => getGeneralMandate()))?.grantId).toBe(generals[label]);
      expect((await system(() => getGeneralMandate(label)))?.grantId).toBe(generals[label]);
    }
    // A request's row raised to the platform lane, from inside a run and from a sweep with no label in context.
    for (const label of [...below, top]) {
      const id = (await at(label, () => fileRequest({ ask: `Upkeep at ${label} ${randomUUID()}`, why: "w", satisfiedBy: "s", claimIds: [node], filer: { kind: "admin", agent: "claim_steward" } }))).id;
      const action = (await system(() => ensureRequestActions(id)))!;
      await system(() => fundRequestNow(action));
      const raised = await system(() => rawQuery<{ g: string; l: string }>(`SELECT grant_id AS g, sensitivity_label AS l FROM mandate_inbox WHERE detail->>'action_id' = $1`, [action]));
      expect(raised.length).toBeGreaterThan(0);
      expect(new Set(raised.map((r) => `${r.g} ${r.l}`))).toEqual(new Set([`${generals[label]} ${label}`]));
    }
    // A consistency sweep's row at each label is paid by that label's General mandate and no other.
    const groups: Record<string, string> = {};
    await system(async () => {
      for (const label of [...below, top]) {
        groups[label] = `consistency:wfb-${tag}-${randomUUID().slice(0, 6)} @${label}`;
        for (const [variant, cost] of [["standard", 1000], ["strong", 900_000_000]] as const) {
          await rawQuery(
            `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label) VALUES ('consistency_sweep', $1, $2, 'wfb', 'A sweep', $3, $4)`,
            [groups[label], variant, cost, label]
          );
        }
      }
      await fundGrantSelfActions();
    });
    for (const label of [...below, top]) {
      const paid = await system(() => rawQuery<{ g: string }>(`SELECT grant_id AS g FROM action_allocations WHERE exclusion_group = $1`, [groups[label]]));
      expect(paid.map((p) => p.g)).toEqual([generals[label]]);
    }
  });

  it("a label with no General mandate has none: its upkeep waits and is not put in front of another label's officers", async () => {
    await system(() => rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [generals[top]]));
    resetAllocationPolicyCache();
    expect(await at(top, () => getGeneralMandate())).toBeNull();
    const id = (await at(top, () => fileRequest({ ask: `No General at ${top} ${randomUUID()}`, why: "w", satisfiedBy: "s", claimIds: [node], filer: { kind: "admin", agent: "claim_steward" } }))).id;
    const action = (await system(() => ensureRequestActions(id)))!;
    await system(() => fundRequestNow(action));
    await at(top, () => fundCurationNow(action));
    expect(await system(() => rawQuery(`SELECT 1 FROM mandate_inbox WHERE detail->>'action_id' = $1`, [action]))).toEqual([]);
    // The labels below still have theirs.
    expect((await at(below[0]!, () => getGeneralMandate()))?.grantId).toBe(generals[below[0]!]);
  });
});

function sqlStateOrCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code ?? sqlState(err);
}
