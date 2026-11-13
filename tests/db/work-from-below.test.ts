/**
 * Work asked for from below, against a real database with its wall up
 * (docs/architecture.md, "Work asked for from below").
 *
 * The one act: from a label, ask for work at a label that reads it, and pay
 * for it. The labels are the review suite's (review-3-common.ts) and one
 * more: public <- `r3-a` (a company-wide label) <- `r3-c` (finance), and
 * `r3-room`, an evidence room that reads `r3-a`, has a tighter posture and
 * holds nothing of its own. `r3-b` reads `public` alone and has no face.
 *
 * Each case checks both sides: what is made above is ordinary work of that
 * label, and what a run below is given is the same to the byte whatever
 * the work above goes on to do.
 */
process.env.RESEARCHER_ENABLED = "true";
process.env.LABEL_POSTURE = JSON.stringify({ "r3-room": { fetches: "given", sandbox: false, features_off: ["mathematics"] } });

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/services/embedding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/embedding-service.js")>()),
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this test");
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { A, B, C, at, seedNode, seedUser, system, unwall, wall } from "./review-3-common.js";
import { creditOwls, owlBalance, seedGrantWithJob } from "./helpers.js";
import { ASKED_FROM_BELOW, NOT_PLACED_MESSAGE, addToAsk, askAbove, askableFaces, askableNote } from "../../src/services/ask-above-service.js";
import { listLabelFaces, showLabelFace, withdrawLabelFace } from "../../src/services/label-admin-service.js";
import { setGateOffer, type GateOffer } from "../../src/services/gate-handoff.js";
import { getRequest, listRequests, paidFromBelowNote, recordWork, requestBrief, setRequestState } from "../../src/services/request-service.js";
import { answerableBelow } from "../../src/services/request-adoption-service.js";
import { grantEscrowBreakdown, regrantEdges } from "../../src/services/regrant-service.js";
import { cancelGrant } from "../../src/services/grant-service.js";
import { completeAction, ensureRequestActions } from "../../src/services/action-service.js";
import { routePetition } from "../../src/services/petition-service.js";
import { openInbox } from "../../src/services/inbox-service.js";
import { PETITION_BELOW_MESSAGE, askedAboveMessage, executeSpendTool } from "../../src/llm/tools/spend-tools.js";
import { runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { featureOn } from "../../src/features.js";
import { postureAt, postureNote } from "../../src/label-posture.js";
import { labelNote } from "../../src/llm/label-note.js";

const PUBLIC = "public";
const ROOM = "r3-room";
const OWL = 1_000_000;
const NOW = Date.parse("2030-01-01T00:00:00Z");
const rows = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => rawQuery<T>(sql, params);

const offered: GateOffer[] = [];
const face: Record<string, string> = {};
let admin: string;

/**
 * Everything a run at `label` can read that this piece touches: the faces,
 * every request with its work, links and ledger rows, the node's inbox,
 * and the mandates, regrants, allocations and petitions its label holds.
 * Money totals a payer reads across labels (its own escrow) are not here:
 * they are the payer's own money and are checked where they move.
 */
async function whatARunIsGiven(label: string, node: string, requestIds: string[]): Promise<string> {
  return at(label, async () => {
    const inbox = await openInbox(node, NOW);
    return JSON.stringify({
      askable: await askableFaces(),
      inbox: inbox.brief,
      requests: await Promise.all(requestIds.map((id) => getRequest(id))),
      listed: await listRequests({ claimId: node, limit: 50 }),
      rows: {
        faces: await rows(`SELECT id, name, can_be_asked, withdrawn_at, sensitivity_label FROM label_faces ORDER BY id`),
        requests: await rows(`SELECT id, ask, state, state_note, budget_micro_usd, asked_as, asked_budget_micro_usd, updated_at, sensitivity_label FROM requests ORDER BY created_at, id`),
        work: await rows(`SELECT * FROM request_work ORDER BY created_at, id`),
        adopted: await rows(`SELECT * FROM adopted_requests ORDER BY adopted_at, id`),
        actions: await rows(`SELECT id, kind, status, exclusion_group, sensitivity_label FROM actions WHERE kind IN ('request', 'research', 'grant_planning') ORDER BY created_at, id`),
        allocations: await rows(`SELECT id, exclusion_group, amount_micro_usd, spent_micro_usd, released_at FROM action_allocations ORDER BY created_at, id`),
        grants: await rows(`SELECT id, name, status, mandate, sensitivity_label FROM grants ORDER BY created_at, id`),
        jobs: await rows(`SELECT id, budget_micro_usd, status FROM budget_jobs ORDER BY created_at, id`),
        regrants: await rows(`SELECT * FROM regrants ORDER BY created_at, id`),
        petitions: await rows(`SELECT id, status FROM petitions ORDER BY created_at, id`),
        messages: await rows(`SELECT id, body FROM node_messages WHERE node_id = $1 ORDER BY created_at, id`, [node]),
        runs: await rows(`SELECT id FROM research_runs ORDER BY id`),
      },
    });
  });
}

describe("one label: nothing can be asked and nothing is said", () => {
  it("lists no face, adds nothing to a run's note, and leaves every label at the deployment's posture", async () => {
    const [{ others }] = (await rawQuery<{ others: number }>(`SELECT count(*)::int AS others FROM labels WHERE name <> 'public'`)) as [{ others: number }];
    if (others === 0) expect(await askableFaces()).toEqual([]);
    expect(askableNote([])).toBe("");
    expect(postureNote(PUBLIC)).toBe("");
    expect(postureAt(PUBLIC).own).toEqual({});
    expect(labelNote(PUBLIC, [PUBLIC], { posture: postureNote(PUBLIC), askable: askableNote([]) })).toBe(labelNote(PUBLIC, [PUBLIC]));
    const res = await askAbove({
      faceId: randomUUID(), as: "work", ask: "Anything", why: "Because", satisfiedBy: "An answer", bearsOnText: "Something",
      budgetMicroUsd: OWL, payer: { kind: "user", userId: randomUUID() }, filer: { kind: "contributor", contributorId: randomUUID() },
    });
    expect(res).toMatchObject({ ok: false, code: "NO_SUCH_FACE" });
  });
});

describe("work asked for from below", () => {
  beforeAll(async () => {
    await wall();
    await system(async () => {
      await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'An evidence room: holds only work asked for from below.') ON CONFLICT (name) DO NOTHING`, [ROOM]);
      await rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, $2), ($1, 'public') ON CONFLICT DO NOTHING`, [ROOM, A]);
    });
    admin = await seedUser();
    const finance = await showLabelFace({ label: C, at: A, name: "Finance desk", canBeAsked: "Questions the finance department's own records would settle.", actorId: admin });
    const room = await showLabelFace({ label: ROOM, at: A, name: "Evidence room", canBeAsked: "Research on the sealed evidence, by a Researcher that reads it.", actorId: admin });
    if (!("id" in finance) || !("id" in room)) throw new Error("faces not shown");
    face.finance = finance.id;
    face.room = room.id;
    setGateOffer(async (offer) => {
      offered.push(offer);
    });
  });

  afterAll(async () => {
    setGateOffer(null);
    await system(async () => {
      const tables = (
        await rawQuery<{ t: string }>(
          `SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)`
        )
      ).map((r) => r.t);
      // Requests below point at faces, and rows above at requests below: the rows this file left go first, over a few passes.
      for (let pass = 0; pass < 6; pass++) {
        let removed = 0;
        for (const table of tables) {
          removed += (await rawQuery(`DELETE FROM "${table}" WHERE sensitivity_label = ANY($1::text[]) RETURNING 1`, [[ROOM, A, B, C]]).catch(() => [])).length;
        }
        removed += (await rawQuery(`DELETE FROM label_faces RETURNING 1`).catch(() => [])).length;
        if (removed === 0) break;
      }
      await rawQuery(`DELETE FROM label_reads WHERE label = $1`, [ROOM]);
      await rawQuery(`DELETE FROM labels WHERE name = $1`, [ROOM]).catch((err: unknown) => console.warn("[work-from-below] cleanup:", err instanceof Error ? err.message : err));
    });
    await unwall();
  });

  it("a label is addressed by a face its administrators show below, and by nothing else", async () => {
    // Shown at the company label: read there and at every label that reads it, and not at `public`.
    expect((await at(A, () => askableFaces())).map((f) => f.name)).toEqual(["Evidence room", "Finance desk"]);
    expect(await at(PUBLIC, () => askableFaces())).toEqual([]);
    expect(await at(B, () => askableFaces())).toEqual([]);
    // Finance reads the room's face (a row at the company label) and cannot ask it: the room does not read finance.
    expect(await at(C, () => askableFaces())).toEqual([]);
    // The face carries a name and a line, and no label's name.
    const [seen] = await at(A, () => askableFaces());
    expect(Object.keys(seen!).sort()).toEqual(["can_be_asked", "id", "name"]);
    expect(askableNote(await at(A, () => askableFaces()))).toBe(
      `Work can be asked of labels above this one, which this run does not read: "Evidence room" (${face.room}): Research on the sealed evidence, ` +
        `by a Researcher that reads it.; "Finance desk" (${face.finance}): Questions the finance department's own records would settle.. ` +
        `What is asked there is done by an agent that reads what that label reads, is paid for from here, and comes back only through that ` +
        `label's gate, where it may be redacted or held.`
    );
    // A face is shown below, never across or above.
    expect(await showLabelFace({ label: A, at: C, name: "Company", canBeAsked: "Anything.", actorId: admin })).toMatchObject({ ok: false, code: "FACE_NOT_BELOW" });
    expect(await showLabelFace({ label: B, at: A, name: "Partner", canBeAsked: "Anything.", actorId: admin })).toMatchObject({ ok: false, code: "FACE_NOT_BELOW" });
    // A label with no face cannot be asked, and neither can a face that is not there for the asker.
    const user = await seedUser();
    await system(() => creditOwls(user, 10 * OWL));
    const ask = (label: string, faceId: string) =>
      at(label, () =>
        askAbove({
          faceId, as: "work", ask: "What do the records show?", why: "It would settle the node.", satisfiedBy: "A report.", bearsOnText: "The records.",
          budgetMicroUsd: OWL, payer: { kind: "user", userId: user }, filer: { kind: "contributor", contributorId: user },
        })
      );
    expect(await ask(A, randomUUID())).toMatchObject({ ok: false, code: "NO_SUCH_FACE" });
    expect(await ask(PUBLIC, face.finance!)).toMatchObject({ ok: false, code: "NO_SUCH_FACE" });
    expect(await ask(B, face.finance!)).toMatchObject({ ok: false, code: "NO_SUCH_FACE" });
    expect(await ask(C, face.room!)).toMatchObject({ ok: false, code: "NO_SUCH_FACE" });
    expect(await system(() => owlBalance(user))).toBe(10 * OWL);
    expect((await system(() => rawQuery(`SELECT 1 FROM requests WHERE filer_contributor_id = $1`, [user]))).length).toBe(0);
    // Withdrawn, a face can no longer be asked; shown again, it can, under the same id.
    await withdrawLabelFace({ label: C, at: A, actorId: admin });
    expect(await ask(A, face.finance!)).toMatchObject({ ok: false, code: "NO_SUCH_FACE" });
    const again = await showLabelFace({ label: C, at: A, name: "Finance desk", canBeAsked: "Questions the finance department's own records would settle.", actorId: admin });
    expect(again).toMatchObject({ ok: true, id: face.finance });
    expect((await listLabelFaces()).filter((f) => !f.withdrawn).map((f) => `${f.label}@${f.shown_at}`).sort()).toEqual([`${C}@${A}`, `${ROOM}@${A}`]);
  });

  it("a person who may fund at the company label creates and funds a mandate at finance; a decline returns the money and goes to the gate", async () => {
    const node = await seedNode(A, "A company node finance holds records about");
    const person = await seedUser();
    await system(() => creditOwls(person, 50 * OWL));
    offered.length = 0;
    const res = await at(A, () =>
      askAbove({
        faceId: face.finance!, as: "mandate", title: "What the ledgers show about the node",
        ask: "Assess this node against the finance department's own ledgers.", why: "The company page rests on a figure only finance can check.",
        satisfiedBy: "An assessment at finance, whichever way it comes out.", claimIds: [node],
        budgetMicroUsd: 20 * OWL, payer: { kind: "user", userId: person }, filer: { kind: "contributor", contributorId: person },
      })
    );
    expect(res).toMatchObject({ ok: true, as: "mandate", budget_micro_usd: 20 * OWL, face: { name: "Finance desk" } });
    if (!res.ok) return;
    // Below: the asker's own record, an ordinary request at the company label, and nothing else.
    const asked = await at(A, () => getRequest(res.request_id));
    expect(asked).toMatchObject({
      ask: "Assess this node against the finance department's own ledgers.", addressed_to: "Finance desk", state: "addressed",
      asked_of: { face_id: face.finance, name: "Finance desk", as: "mandate", budget_usd: 20 }, ledger: null, work: [],
    });
    expect(asked).not.toHaveProperty("taken_up_at");
    expect(Object.keys(res).sort()).toEqual(["as", "budget_micro_usd", "face", "ok", "request_id"]);
    // No ledger row at the company label: the work is finance's.
    expect(await at(A, () => ensureRequestActions(res.request_id))).toBeNull();
    expect((await system(() => rawQuery(`SELECT 1 FROM actions WHERE target_ref = $1`, [res.request_id]))).length).toBe(0);
    // The money went up with it.
    expect(await system(() => owlBalance(person))).toBe(30 * OWL);
    // Above: an ordinary mandate at finance, in planning, with the asker's words and money, linked to the request it was asked by.
    const [made] = await at(C, () =>
      rawQuery<{ grant_id: string; request_id: string; status: string; mandate: Record<string, unknown>; label: string; budget: string }>(
        `SELECT a.grant_id, a.request_id, g.status, g.mandate, g.sensitivity_label AS label, j.budget_micro_usd AS budget
           FROM adopted_requests a JOIN grants g ON g.id = a.grant_id JOIN budget_jobs j ON j.id = g.budget_job_id
          WHERE a.from_request_id = $1`,
        [res.request_id]
      )
    );
    expect(made).toMatchObject({ status: "planning", label: C, budget: String(20 * OWL) });
    expect(made!.mandate).toMatchObject({ title: "What the ledgers show about the node", objective: "Assess this node against the finance department's own ledgers.", origin: ASKED_FROM_BELOW });
    // Finance's Grantmaker has the asker's request as an open request of its own label, bearing on the node, to fund as it judges.
    const above = await at(C, () => getRequest(made!.request_id));
    expect(above).toMatchObject({ state: "addressed", taken_up_from: { request_id: res.request_id, label: A }, paid_from_below: { label: A } });
    expect(above!.bears_on.map((n) => n.id)).toEqual([node]);
    expect(await at(C, () => answerableBelow(made!.request_id)).then((x) => x?.asked)).toEqual({ request_id: res.request_id, label: A });
    // The company label reads none of it.
    expect(await at(A, () => rawQuery(`SELECT 1 FROM grants WHERE id = $1`, [made!.grant_id]))).toEqual([]);
    expect(await at(A, () => rawQuery(`SELECT 1 FROM adopted_requests WHERE from_request_id = $1`, [res.request_id]))).toEqual([]);
    // That it was made is offered to the gate, for the request that asked, paid from the mandate's own budget.
    expect(offered).toEqual([
      { kind: "mandate", fromLabel: C, toLabel: A, subject: { grantId: made!.grant_id }, replyTo: { requestId: res.request_id }, payer: { grantId: made!.grant_id } },
    ]);
    const before = await whatARunIsGiven(A, node, [res.request_id]);
    // A decline: finance closes the mandate as it would any scope it should not accept. The money returns; the account of it is the gate's.
    const closed = await at(C, () => cancelGrant({ grantId: made!.grant_id, funderUserId: person }));
    expect(closed).toMatchObject({ ok: true, refundedMicroUsd: 20 * OWL });
    expect(await system(() => owlBalance(person))).toBe(50 * OWL);
    expect(offered.length).toBe(2);
    expect(offered[1]).toEqual(offered[0]);
    expect(await whatARunIsGiven(A, node, [res.request_id])).toBe(before);
  });

  it("a mandate at the company label creates a mandate at finance and adds to it: a regrant that crosses upward, and comes back when it closes", async () => {
    const node = await seedNode(A, "A second company node");
    const funder = await seedUser();
    const { grantId, jobId } = await at(A, () => seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL }));
    const escrow = () => at(A, () => grantEscrowBreakdown({ id: grantId, budgetJobId: jobId }));
    const res = await at(A, () =>
      askAbove({
        faceId: face.finance!, as: "mandate", title: "A slice of the mission, at finance",
        ask: "Carry this mandate's question into what finance holds.", why: "The mission needs it.", satisfiedBy: "The mandate's mission, as its own Grantmaker judges it.",
        bearsOnText: "What the mandate's objective describes.", budgetMicroUsd: 30 * OWL,
        payer: { kind: "grant", grantId }, filer: { kind: "mandate", grantId },
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [above] = await at(C, () =>
      rawQuery<{ grant_id: string; budget: string; funder: string }>(
        `SELECT a.grant_id, j.budget_micro_usd AS budget, g.funder_user_id AS funder FROM adopted_requests a
           JOIN grants g ON g.id = a.grant_id JOIN budget_jobs j ON j.id = g.budget_job_id WHERE a.from_request_id = $1`,
        [res.request_id]
      )
    );
    expect(above).toMatchObject({ budget: String(30 * OWL), funder });
    // The regrant is an ordinary regrant at finance, from the mandate below. The paying mandate's escrow counts it wherever it is.
    expect(await at(C, () => rawQuery(`SELECT from_grant_id, to_grant_id, amount_micro_usd::text AS amount, sensitivity_label FROM regrants WHERE to_grant_id = $1`, [above!.grant_id]))).toEqual([
      { from_grant_id: grantId, to_grant_id: above!.grant_id, amount: String(30 * OWL), sensitivity_label: C },
    ]);
    expect(await escrow()).toMatchObject({ regrants: 30 * OWL, committed: 30 * OWL });
    // The mandate below is shown no mandate above among those it funds: only its own money's total.
    expect((await at(A, () => regrantEdges(grantId))).fundsOut).toEqual([]);
    expect((await at(C, () => regrantEdges(above!.grant_id))).fundedBy.map((e) => e.grant_id)).toEqual([grantId]);
    // More money for what it asked for: addressed by its own request, never by the mandate above.
    expect(await at(A, () => addToAsk({ requestId: res.request_id, budgetMicroUsd: 10 * OWL, payer: { kind: "grant", grantId }, note: "More." }))).toEqual({ ok: true });
    expect(await escrow()).toMatchObject({ regrants: 40 * OWL });
    expect(await at(A, () => addToAsk({ requestId: randomUUID(), budgetMicroUsd: OWL, payer: { kind: "grant", grantId } }))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // More than the mandate holds is refused in words about its own money.
    expect(await at(A, () => addToAsk({ requestId: res.request_id, budgetMicroUsd: 500 * OWL, payer: { kind: "grant", grantId } }))).toMatchObject({ ok: false, code: "PAYER" });
    const before = await whatARunIsGiven(A, node, [res.request_id]);
    // A run the mandate above pays for petitions that mandate, at its own label: nothing about that path is new.
    const [job] = await at(C, () => rawQuery<{ id: string }>(`SELECT budget_job_id AS id FROM grants WHERE id = $1`, [above!.grant_id]));
    expect(await at(C, () => routePetition({ grantId: above!.grant_id }))).toBe(above!.grant_id);
    // It closes with everything unspent: the whole of it comes back to the mandate below, and nothing below is written.
    const closed = await at(C, () => cancelGrant({ grantId: above!.grant_id, funderUserId: funder }));
    expect(closed).toMatchObject({ ok: true });
    expect(job).toBeTruthy();
    expect(await escrow()).toMatchObject({ regrants: 0, committed: 0 });
    // Once it has closed, more money is refused in the one sentence that says nothing of why.
    expect(await at(A, () => addToAsk({ requestId: res.request_id, budgetMicroUsd: OWL, payer: { kind: "grant", grantId } }))).toEqual({
      ok: false, code: "NOT_PLACED", message: NOT_PLACED_MESSAGE,
    });
    expect(await whatARunIsGiven(A, node, [res.request_id])).toBe(before);
  });

  it("a Steward at the company label commissions research in the evidence room from its own budget; the report goes to the gate's seam and not to the Steward", async () => {
    const node = await seedNode(A, "A company node the sealed evidence bears on");
    const funder = await seedUser();
    const { grantId, jobId } = await at(A, () => seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL }));
    // The Steward's own run: an assess row at the company label, paid for by a mandate there.
    const [pass] = await at(A, () =>
      rawQuery<{ id: string }>(
        `INSERT INTO actions (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd, status)
         VALUES ('assess', $1, 'standard', $2, 'A pass', $3, 'running') RETURNING id`,
        [`assess:${node} @${A}`, node, 20 * OWL]
      )
    );
    await at(A, () =>
      rawQuery(
        `INSERT INTO action_allocations (exclusion_group, action_id, claim_id, grant_id, amount_micro_usd, commissioned_by)
         VALUES ($1, $2, $3, $4, $5, 'grantmaker')`,
        [`assess:${node} @${A}`, pass!.id, node, grantId, 20 * OWL]
      )
    );
    const budget = { microUsd: 20 * OWL, source: "the commission for this pass", meter: { billedMicroUsd: 0 }, funding: { actionId: pass!.id } };
    const asSteward = <T>(fn: () => Promise<T>) =>
      at(A, () => withAgent("steward", () => runWithUsageContext({ claimId: node, passBudget: budget as never }, fn)));
    const brief = "Does the sealed audit file support the figure this node states? Report what the file shows and what it does not.";
    const out = JSON.parse((await asSteward(() => executeSpendTool("commission", { kind: "research", ask_of: face.room, brief, budget_owls: 8 })))!);
    expect(out.message).toBe(askedAboveMessage("Evidence room", out.request_id, 8, 12));
    expect(out).not.toHaveProperty("research_run_id");
    // The Steward's record: a request on its node at its own label, which it keeps, addressed to the room.
    const asked = await at(A, () => getRequest(out.request_id));
    expect(asked).toMatchObject({
      ask: brief, addressed_to: "Evidence room", keeper: { kind: "steward" }, filed_by: { kind: "admin" },
      asked_of: { name: "Evidence room", as: "work", budget_usd: 8 }, ledger: null, work: [],
    });
    expect((await at(A, () => listRequests({ claimId: node, limit: 10 }))).items.map((r) => r.id)).toEqual([out.request_id]);
    // Its budget went down by what it paid, and nothing waits on an answer: no session is paused, no research run is the Steward's.
    expect(budget.microUsd).toBe(12 * OWL);
    expect(await system(() => rawQuery(`SELECT 1 FROM research_runs WHERE task = $1`, [brief]))).toEqual([]);
    expect(await at(A, () => rawQuery(`SELECT 1 FROM agent_sessions WHERE node_id = $1`, [node]))).toEqual([]);
    // In the room: the request taken up, its ledger row at the room's label, paid by the money from below along the chain of runs.
    const link = await system(() =>
      rawQuery<{ request_id: string; label: string }>(`SELECT request_id, sensitivity_label AS label FROM adopted_requests WHERE from_request_id = $1`, [out.request_id])
    );
    expect(link.map((l) => l.label)).toEqual([ROOM]);
    const roomRequest = link[0]!.request_id;
    const [row] = await at(ROOM, () =>
      rawQuery<{ id: string; variant: string; status: string; label: string; cost: string }>(
        `SELECT id, variant, status, sensitivity_label AS label, cost_est_micro_usd AS cost FROM actions WHERE kind = 'request' AND target_ref = $1`,
        [roomRequest]
      )
    );
    expect(row).toMatchObject({ variant: "full", status: "open", label: ROOM, cost: String(8 * OWL) });
    expect(
      await at(ROOM, () =>
        rawQuery(`SELECT grant_id, amount_micro_usd::text AS amount, parent_action_id, sensitivity_label FROM action_allocations WHERE action_id = $1`, [row!.id])
      )
    ).toEqual([{ grant_id: grantId, amount: String(8 * OWL), parent_action_id: pass!.id, sensitivity_label: ROOM }]);
    // The paying mandate's escrow holds the same total as before: the money moved from the pass to the work above.
    const escrow = () => at(A, () => grantEscrowBreakdown({ id: grantId, budgetJobId: jobId }));
    expect(await escrow()).toMatchObject({ held: 20 * OWL, spent: 0 });
    // The Researcher there works under the room's posture and is told so, and is told who it works for and what a petition does.
    expect(row!.label).toBe(ROOM);
    expect(postureAt(ROOM)).toMatchObject({ fetches: "given", sandbox: false, own: { fetches: "given", sandbox: false, featuresOff: ["mathematics"] } });
    expect(postureAt(A).own).toEqual({});
    expect(await at(ROOM, async () => featureOn("mathematics"))).toBe(false);
    expect(await at(A, async () => featureOn("mathematics"))).toBe(true);
    expect(postureNote(ROOM)).toBe(
      "Runs at `r3-room` work under settings this organization chose for that label, which differ from the rest of this deployment because of " +
        "what the label holds: a page is fetched only from an address this deployment was given (a search result, a source it holds, an address " +
        "in your task); no command is run over a set of files; switched off: mathematics. A tool that is not offered, or that refuses for one of " +
        "these, is this setting and not a fault."
    );
    expect(labelNote(ROOM, [ROOM, A, PUBLIC], { posture: postureNote(ROOM) })).toContain(postureNote(ROOM));
    const taken = await at(ROOM, () => getRequest(roomRequest));
    expect(taken).toMatchObject({ paid_from_below: { label: A }, taken_up_from: { request_id: out.request_id, label: A } });
    expect(requestBrief(taken!)).toContain(paidFromBelowNote(A));

    const before = await whatARunIsGiven(A, node, [out.request_id]);
    const beforePublic = await whatARunIsGiven(PUBLIC, node, []);
    // A petition from the run above: recorded at its own label, nothing waits on it, and nobody below is asked.
    const roomBudget = { microUsd: 8 * OWL, source: "the commission for this work", meter: { billedMicroUsd: 0 }, funding: { actionId: row!.id } };
    await at(ROOM, () => rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [row!.id]));
    const petition = JSON.parse(
      (await at(ROOM, () =>
        withAgent("researcher", () =>
          runWithUsageContext({ passBudget: roomBudget as never }, () =>
            executeSpendTool("petition_mandate", { kind: "more_budget", owls: 5, plan: "Read the second audit file.", done_so_far: "The first file is read." })
          )
        )
      ))!
    );
    expect(petition).toMatchObject({ success: true, message: PETITION_BELOW_MESSAGE });
    expect(await at(ROOM, () => rawQuery(`SELECT grant_id, waiting, status, sensitivity_label FROM petitions WHERE id = $1`, [petition.petition_id]))).toEqual([
      { grant_id: grantId, waiting: false, status: "pending", sensitivity_label: ROOM },
    ]);
    // The Researcher reports in the room; the room's keeper closes the request. Other work goes on above as well.
    await at(ROOM, () => recordWork({ requestId: roomRequest, byLabel: "the Researcher", outcome: "met", summary: "The sealed file supports the figure. It rests on page 4 of the audit." }));
    await at(ROOM, () => setRequestState({ requestId: roomRequest, state: "met", note: "The file was read in full." }));
    await at(ROOM, () => seedNode(ROOM, "Something else in the room").then(() => undefined));
    // What it did not spend returns to the payer below by the ordinary settlement: 3 owls spent, 5 back in the mandate's escrow.
    await at(ROOM, () => completeAction(row!.id, 3 * OWL));
    expect(await escrow()).toMatchObject({ held: 12 * OWL, spent: 3 * OWL, committed: 15 * OWL });
    // The seam: the gate is given the request that asked and its label, and the request above whose work is the answer.
    expect(await at(ROOM, () => answerableBelow(roomRequest))).toMatchObject({
      asked: { request_id: out.request_id, label: A },
      answered_by: { request_id: roomRequest, label: ROOM, state: "met" },
    });
    // The Steward is given nothing directly: its request, its node's inbox and every row its label reads are as they were, to the byte.
    expect(await whatARunIsGiven(A, node, [out.request_id])).toBe(before);
    expect(await whatARunIsGiven(PUBLIC, node, [])).toBe(beforePublic);
    expect(before).not.toContain("page 4 of the audit");
    expect(before).not.toContain(roomRequest);
    // And nothing here blinds the Steward at its own label: the node's requests and inbox are what any pass reads.
    expect(JSON.parse(before).listed.items.map((r: { id: string }) => r.id)).toEqual([out.request_id]);
  });

  it("refuses an ask the payer cannot pay for in words about the payer's own money, and leaves nothing on either side", async () => {
    const poor = await seedUser();
    await system(() => creditOwls(poor, 2 * OWL));
    for (const as of ["work", "mandate"] as const) {
      const res = await at(A, () =>
        askAbove({
          faceId: face.room!, as, title: "A title", ask: `Too dear (${as})`, why: "Because.", satisfiedBy: "A report.", bearsOnText: "The evidence.",
          budgetMicroUsd: 5 * OWL, payer: { kind: "user", userId: poor }, filer: { kind: "contributor", contributorId: poor },
        })
      );
      expect(res).toMatchObject({ ok: false, code: "PAYER", message: "A budget of 5 owls is more than your balance." });
    }
    expect(await system(() => owlBalance(poor))).toBe(2 * OWL);
    expect(await system(() => rawQuery(`SELECT 1 FROM requests WHERE ask LIKE 'Too dear%'`))).toEqual([]);
    expect(await system(() => rawQuery(`SELECT 1 FROM actions WHERE label LIKE '%Too dear%' AND status = 'open'`))).toEqual([]);
    // A run pays for one piece of work, not a mandate.
    expect(
      await at(A, () =>
        askAbove({
          faceId: face.room!, as: "mandate", title: "T", ask: "A", why: "W", satisfiedBy: "S", bearsOnText: "B", budgetMicroUsd: OWL,
          payer: { kind: "run", actionId: randomUUID() }, filer: { kind: "admin", agent: "claim_steward" },
        })
      )
    ).toMatchObject({ ok: false, code: "PAYER" });
  });
});
