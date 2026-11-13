/**
 * The gate (docs/the-gate.md), against a real database with its wall up.
 *
 * Three layers and the outside. The labels are the review suite's
 * (review-3-common.ts): `r3-a` reads `public`, and `r3-c` reads `r3-a` and
 * `public`, so public <- r3-a <- r3-c is a chain of three, with `r3-a` in
 * the place of a company-wide label ("company") and `r3-c` in the place of
 * a department's ("finance"). The boundary to outside is driven through
 * the same settings in published-pages.test.ts.
 *
 * No model runs here. The Redactor's and Audit's tools are driven directly
 * at the item's label, as their runs would call them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/services/embedding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/embedding-service.js")>()),
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this test");
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { runAtLabel, withAgent } from "../../src/llm/usage-context.js";
import { executeAuditTool } from "../../src/llm/tools/audit-tools.js";
import { executeRedactorTool } from "../../src/llm/tools/redactor-tools.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { STARTING_MODE } from "../../src/services/gate-kinds.js";
import { fundBelow, gateItemFor, offerToGate } from "../../src/services/gate-service.js";
import { endGateSetting, gatesFor, modesFor, setGate, setGateMode, type GateAuthority } from "../../src/services/gate-settings-service.js";
import { answerMessages, openInbox, postMessage } from "../../src/services/inbox-service.js";
import {
  decideAtGate,
  gateBacklog,
  gateQueue,
  settleWaiting,
  shownItems,
  shownPage,
  shownShowing,
  type GateActor,
} from "../../src/services/release-gate-service.js";
import { takeUpFromBelow } from "../../src/services/request-adoption-service.js";
import { fileRequest, getRequest, recordWork } from "../../src/services/request-service.js";
import { askShowing, followShowings, retryGatePayments } from "../../src/services/showing-service.js";
import { seedGrantWithJob } from "./helpers.js";
import { A, B, C, asPerson, at, attachSource, seedNode, seedUser, stewardAt, system, unwall, wall } from "./review-3-common.js";

const COMPANY = A;
const FINANCE = C;
const SECRET = "8,812,400 in the escrow account";
const id: Record<string, string> = {};
let admin: GateAuthority;
let orgHolder: GateActor;
let director: GateActor;

const redactor = async (item: string, name: string, input: Record<string, unknown> = {}, label = FINANCE) =>
  JSON.parse(await runAtLabel(label, "a redactor's run", () => withAgent("redactor", () => executeRedactorTool(name, input, { pageId: item })))) as Record<string, any>;
const audit = async (name: string, input: Record<string, unknown>, label = FINANCE) =>
  JSON.parse(await runAtLabel(label, "an audit run", () => withAgent("audit", () => executeAuditTool(name, input, {})))) as Record<string, any>;
const atCompany = <T>(fn: () => Promise<T>) => asPerson([COMPANY, "public"], fn);
const everyRow = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => system(() => rawQuery<T>(sql, params));

/** Finish the Redactor's work on an item and pass Audit's check of it. */
async function finishAndPass(item: string, opts: { answer?: string; label?: string } = {}): Promise<void> {
  const done = await redactor(item, "finish_redaction", { least_sure: [] }, opts.label);
  expect(done.success).toBe(true);
  const passed = await audit("record_fidelity_outcome", { page_id: item, outcome: "pass", ...(opts.answer ? { answer: opts.answer } : {}), reasons: "Each removal is covered by its category." }, opts.label);
  expect(passed.success).toBe(true);
}

/** Who paid for an item's redaction and for the check of it: the mandates, in the order the two were placed. */
async function payersOfGateWork(item: string): Promise<string[]> {
  const rows = await everyRow<{ grant_id: string | null }>(
    `SELECT al.grant_id FROM action_allocations al JOIN actions a ON a.id = al.action_id
      WHERE a.exclusion_group = $1 OR a.id = (SELECT r.action_id FROM showing_pages p JOIN audit_runs r ON r.id = p.audit_run_id WHERE p.id = $2)
      ORDER BY al.created_at`,
    [`redact:${item}`, item]
  );
  return rows.map((r) => r.grant_id ?? "a person");
}

const personActs = (item: string) =>
  everyRow<{ act: string; by: string }>(`SELECT act, by FROM showing_acts WHERE page_id = $1 AND by = 'person' ORDER BY at`, [item]);

async function seedMandate(label: string, opts: { general?: boolean } = {}): Promise<{ grantId: string; jobId: string }> {
  const funder = await seedUser();
  const made = await at(label, () => seedGrantWithJob({ funderId: funder, budgetMicroUsd: 500_000_000, policy: opts.general ? "general" : "ranked" }));
  await system(() => rawQuery(`UPDATE grants SET status = 'active', is_platform = $2 WHERE id = $1`, [made.grantId, opts.general === true]));
  resetAllocationPolicyCache();
  return made;
}

/** A node with a judgment at finance that a mandate's budget paid for. */
async function assessedAtFinance(text: string, jobId: string | null, reasoning: string): Promise<string> {
  const node = await seedNode("public", text);
  await system(() =>
    rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, claim_credence, summary, reasoning_trace, model, is_current, funded_by_job_id, sensitivity_label)
       VALUES ($1, 'supported', 0.8, 0.85, 'Supported, on the ledger.', $2, 'a-model', true, $3, $4)`,
      [node, reasoning, jobId, FINANCE]
    )
  );
  return node;
}

const latestItem = async (showingId: string) =>
  (await everyRow<{ id: string }>(`SELECT id FROM showing_pages WHERE showing_id = $1 AND stage <> 'overtaken' ORDER BY opened_at DESC LIMIT 1`, [showingId]))[0]!.id;

beforeAll(async () => {
  await wall();
  await system(async () => {
    const [existing] = await rawQuery<{ id: string }>(`SELECT id FROM parties WHERE is_own_organization`);
    id.org = existing?.id ?? (await rawQuery<{ id: string }>(`INSERT INTO parties (name, is_own_organization) VALUES ('The organization', true) RETURNING id`))[0]!.id;
    if (!existing) id.orgMadeHere = "yes";
  });
  admin = { id: await seedUser(), holding: ["administer"], administer: true, releaseParties: [] };
  orgHolder = { id: await seedUser(), holding: ["release for the organization"], clearance: [FINANCE, COMPANY, "public"], releaseParties: [id.org!], direct: false };
  director = { id: await seedUser(), holding: ["direct"], clearance: [FINANCE, COMPANY, "public"], releaseParties: [], direct: true };
  const work = await seedMandate(FINANCE);
  id.mandate = work.grantId;
  id.mandateJob = work.jobId;
  const other = await seedMandate(FINANCE);
  id.otherMandate = other.grantId;
  id.otherJob = other.jobId;
}, 180_000);

afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM gates WHERE boundary_id IN (SELECT boundary_id FROM redaction_policies WHERE from_label = ANY($1::text[]))`, [[A, B, C]]);
    await rawQuery(`DELETE FROM action_allocations WHERE grant_id = ANY($1::uuid[])`, [[id.mandate, id.otherMandate, id.general, id.companyGeneral].filter(Boolean)]);
  }).catch((err: unknown) => console.warn("[the-gate] cleanup:", err instanceof Error ? err.message : err));
  await unwall();
  if (id.orgMadeHere) await system(() => rawQuery(`DELETE FROM parties WHERE id = $1`, [id.org])).catch(() => undefined);
  resetAllocationPolicyCache();
}, 180_000);

describe("where a gate starts", () => {
  it("is the Redactor's decision for every kind, and open for the bare fact that a request was taken up", () => {
    expect(STARTING_MODE).toEqual({ page: "redactor", answer: "redactor", taken_up: "open", funding: "redactor", mandate: "redactor", message: "redactor" });
  });

  it("offers nothing where the destination already reads the label", async () => {
    expect(await offerToGate({ kind: "mandate", fromLabel: COMPANY, toLabel: FINANCE, subject: { grantId: id.mandate! } })).toBeNull();
  });
});

describe("a node's page, finance to company", () => {
  it("under the Redactor's decision: redacted, checked and released with no person's act, each run paid from the budget of the work that produced the page", async () => {
    id.node = await assessedAtFinance("The reserve covers the liability", id.mandateJob!, `The ledger shows ${SECRET}.\n\nThat exceeds the liability.`);
    const asked = await askShowing({ nodeId: id.node!, pageLabel: FINANCE, toLabel: COMPANY, form: "standing", scope: "node", actor: director });
    id.gate = asked.boundary_id;
    id.flow = asked.showing_id;
    const item = await latestItem(asked.showing_id);
    // Nobody commissioned the redaction: it is already paid for, by the mandate that paid for the assessment.
    expect(await payersOfGateWork(item)).toEqual([id.mandate]);
    const told = await redactor(item, "get_page_to_redact");
    expect(told.gate).toMatch(/^The Redactor decides/);
    expect((await redactor(item, "redact", { part: 2, passage: SECRET, category: "commercial figures", note: "An account balance." })).success).toBe(true);
    await finishAndPass(item, { answer: "supports" });
    // The check was paid for the same way.
    expect(await payersOfGateWork(item)).toEqual([id.mandate, id.mandate]);
    const page = (await atCompany(() => shownPage(item)))!;
    expect(page.state).toBe("released_whole");
    expect(JSON.stringify(page)).not.toContain(SECRET);
    expect((page.parts as any[])[1].text).toBe("The ledger shows [redacted: commercial figures].");
    expect(page.verification).toMatchObject({ ok: true });
    expect(await personActs(item)).toEqual([]);
    const acts = (await atCompany(() => shownShowing(asked.showing_id)))!.acts as any[];
    expect(acts.filter((a) => a.what === "released").every((a) => a.by === "the gate's setting")).toBe(true);
    // It arrived at company as a source on the node, and a pass was opened there.
    const [arrived] = await atCompany(() => rawQuery<{ source_id: string }>(`SELECT source_id FROM shown_pages WHERE id = $1`, [item]));
    expect(await atCompany(() => rawQuery(`SELECT 1 FROM claim_instances WHERE source_id = $1 AND claim_id = $2`, [arrived!.source_id, id.node]))).toHaveLength(1);
  });

  it("each later version flows without anyone asking again", async () => {
    await system(async () => {
      await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND sensitivity_label = $2`, [id.node, FINANCE]);
      await rawQuery(
        `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, funded_by_job_id, sensitivity_label)
         VALUES ($1, 'supported', 0.9, 'Still supported.', 'A second look.', true, $2, $3)`,
        [id.node, id.mandateJob, FINANCE]
      );
    });
    expect(await followShowings()).toBe(1);
    const item = await latestItem(id.flow!);
    expect(await payersOfGateWork(item)).toEqual([id.mandate]);
    await finishAndPass(item, { answer: "supports" });
    expect((await atCompany(() => shownPage(item)))!.state).toBe("released_whole");
  });

  it("open, for everything under one node: it goes as written, no Redactor runs and nothing is paid", async () => {
    id.openNode = await assessedAtFinance("The audit was completed on time", id.mandateJob!, "It was signed in March.");
    await expect(setGateMode({ boundaryId: id.gate!, kind: "page", scope: "under", mode: "open", actor: admin })).rejects.toThrow(/Say which node/);
    await setGateMode({ boundaryId: id.gate!, kind: "page", scope: "under", scopeRef: id.openNode!, mode: "open", actor: admin });
    const asked = await askShowing({ nodeId: id.openNode!, pageLabel: FINANCE, toLabel: COMPANY, form: "once", scope: "node", actor: director });
    const item = await latestItem(asked.showing_id);
    const page = (await atCompany(() => shownPage(item)))!;
    expect(page.state).toBe("released_whole");
    expect((page.parts as any[]).map((p) => p.text)).toContain("It was signed in March.");
    expect((page.always_shown as any).made.redaction).toBe("none: the gate was open for this item");
    expect(page.verification).toMatchObject({ ok: true });
    expect(await everyRow(`SELECT 1 FROM actions WHERE exclusion_group = $1`, [`redact:${item}`])).toEqual([]);
    expect(await payersOfGateWork(item)).toEqual([]);
    // The setting for that node does not open the gate for another.
    const scope = { boundaryId: id.gate!, kind: "page" as const, fromLabel: FINANCE, subjectRef: null, replyRef: null, grantIds: [] };
    expect((await modesFor({ ...scope, nodeId: id.node! }, [id.org!])).get(id.org!)!.mode).toBe("redactor");
    expect((await modesFor({ ...scope, nodeId: id.openNode! }, [id.org!])).get(id.org!)!.mode).toBe("open");
  });

  it("a person decides as well, for one mandate's work: the Redactor proposes, and the person approves, removes, or lifts with the same acts", async () => {
    id.personNode = await assessedAtFinance("The covenant was not breached", id.otherJob!, `The ratio stood at 2.4.\n\nCounsel advised on ${SECRET}.\n\nThe lender was told in April.`);
    await setGateMode({ boundaryId: id.gate!, scope: "mandate", scopeRef: id.otherMandate!, partyId: id.org!, mode: "person", actor: { ...admin, administer: false, releaseParties: [id.org!] } });
    const asked = await askShowing({ pageLabel: FINANCE, toLabel: COMPANY, scopeRef: id.otherMandate!, form: "standing", scope: "mandate", actor: director });
    expect(asked.pages_opened).toBe(1);
    const item = await latestItem(asked.showing_id);
    expect(await payersOfGateWork(item)).toEqual([id.otherMandate]);
    expect((await redactor(item, "get_page_to_redact")).gate).toMatch(/^A person decides as well: your work is a proposal/);
    // The Redactor delays one paragraph and holds another; it has every act a person has.
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect((await redactor(item, "delay_part", { part: 4, until: later })).success).toBe(true);
    expect((await redactor(item, "hold_part", { part: 3, reason: "legal", note: "Counsel's advice." })).success).toBe(true);
    await finishAndPass(item, { answer: "supports" });
    // Nothing went: the gate is set to a person's decision for the organization's material under this mandate.
    expect((await atCompany(() => shownPage(item)))!.state).toBe("held");

    const queue = (await gateQueue(orgHolder)) as { items: any[] };
    const mine = queue.items.filter((i) => i.item_id === item);
    // The part the Redactor held comes first, as what it was least sure of does.
    expect(mine.map((i) => [i.part, i.the_redactor_proposes])).toEqual([[null, "let through"], [3, "hold"], [1, "let through"], [2, "let through"], [4, "delay"]]);
    expect(mine[0].decide_for[0].setting).toBe("person");
    expect(mine[1].held_by_the_redactor.reason).toBe("a legal or contractual reason");

    // A person removes a passage, as the Redactor could, under a category of the policy. No word is changed.
    const badCategory = await decideAtGate({ actor: orgHolder, items: [{ item_id: item, part: 3, decision: "remove", passage: SECRET, category: "anything awkward" }] });
    expect(badCategory.refused[0]!.why).toMatch(/A removal is made under a category of this boundary's policy/);
    const before = (await atCompany(() => rawQuery<{ root: string }>(`SELECT root FROM shown_pages WHERE id = $1`, [item])))[0]!.root;
    const removed = await decideAtGate({ actor: orgHolder, items: [{ item_id: item, part: 3, decision: "remove", passage: SECRET, category: "commercial figures" }] });
    expect(removed).toMatchObject({ decided: 1, refused: [] });
    expect(await decideAtGate({ actor: orgHolder, items: [{ item_id: item, part: 3, decision: "remove", passage: SECRET, category: "commercial figures" }] })).toMatchObject({ decided: 0, unchanged: 1 });
    const [after] = await atCompany(() => rawQuery<{ root: string; roots: unknown[] }>(`SELECT root, roots FROM shown_pages WHERE id = $1`, [item]));
    expect(after!.root).not.toBe(before);
    expect(after!.roots).toHaveLength(2);

    // Approve as proposed: one act for the whole item. What the Redactor held or delayed stays back.
    const approved = await decideAtGate({ actor: orgHolder, items: [{ item_id: item }], decision: "approve" });
    expect(approved.shown).toEqual([item]);
    let page = (await atCompany(() => shownPage(item)))!;
    expect(page.state).toBe("released_in_part");
    expect((page.parts as any[])[2].held).toBe("[A paragraph of reasoning, held by the Redactor]");
    expect((page.always_shown as any).removals).toEqual({ "commercial figures": 1 });
    expect(page.verification).toMatchObject({ ok: true });

    // The person lifts the Redactor's hold and releases the part, with its mark; and the delay runs out by itself.
    await decideAtGate({ actor: orgHolder, items: [{ item_id: item, part: 3, decision: "lift" }, { item_id: item, part: 3, decision: "release" }] });
    await system(() => rawQuery(`UPDATE showing_acts SET until = now() - interval '1 minute' WHERE page_id = $1 AND act = 'delayed'`, [item]));
    expect(await settleWaiting({ boundaryId: id.gate! })).toBeGreaterThanOrEqual(0);
    await decideAtGate({ actor: orgHolder, items: [{ item_id: item, part: 4 }], decision: "release" });
    page = (await atCompany(() => shownPage(item)))!;
    expect(page.state).toBe("released_whole");
    expect((page.parts as any[])[2].text).toBe("Counsel advised on [redacted: commercial figures].");
    expect(JSON.stringify(page)).not.toContain(SECRET);
    expect(page.verification).toMatchObject({ ok: true });
    // Once the item itself is shown, nothing more is removed from it.
    const late = await decideAtGate({ actor: orgHolder, items: [{ item_id: item, part: 1, decision: "remove", passage: "ratio", category: "commercial figures" }] });
    expect(late.refused).toHaveLength(1);
    // Every act names who made it: the person, the Redactor, or the gate's setting.
    const by = await everyRow<{ act: string; by: string }>(`SELECT DISTINCT act, by FROM showing_acts WHERE page_id = $1 ORDER BY act, by`, [item]);
    expect(by).toEqual(
      expect.arrayContaining([
        { act: "delayed", by: "redactor" },
        { act: "held", by: "redactor" },
        { act: "hold_lifted", by: "person" },
        { act: "released", by: "person" },
        { act: "removed", by: "person" },
      ])
    );
  });

  it("a person delays a part, and it goes when the time comes", async () => {
    const node = await assessedAtFinance("The facility was renewed", id.otherJob!, "It was renewed for a year.");
    await followShowings();
    const [row] = await everyRow<{ id: string }>(`SELECT id FROM showing_pages WHERE node_id = $1`, [node]);
    const item = row!.id;
    await finishAndPass(item, { answer: "supports" });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await decideAtGate({ actor: orgHolder, items: [{ item_id: item }], decision: "delay", until: "2001-01-01T00:00:00Z" })).refused).toHaveLength(1);
    expect(await decideAtGate({ actor: orgHolder, items: [{ item_id: item }], decision: "delay", until })).toMatchObject({ decided: 1 });
    await decideAtGate({ actor: orgHolder, items: [{ item_id: item }], decision: "approve" });
    // The parts are approved, and the item itself is kept back until the time.
    expect((await atCompany(() => shownPage(item)))!.held_because).toBe(`delayed until ${until}`);
    await system(() => rawQuery(`UPDATE showing_acts SET until = now() - interval '1 minute' WHERE page_id = $1 AND act = 'delayed'`, [item]));
    await decideAtGate({ actor: orgHolder, items: [{ item_id: item }], decision: "release" });
    expect((await atCompany(() => shownPage(item)))!.state).toBe("released_whole");
  });
});

describe("a request asked at company and taken up at finance", () => {
  it("that it was taken up is told at once, with no Redactor's run; the answer is redacted, checked and comes back on the request that asked", async () => {
    id.asked = (await at(COMPANY, () => fileRequest({ ask: "What is held in escrow?", why: "It bears on the reserve.", satisfiedBy: "The balance.", claimIds: [id.node!], filer: { kind: "admin", agent: "claim_steward" } }))).id;
    const before = await atCompany(() => getRequest(id.asked!));
    expect(before!.taken_up_above).toBeUndefined();
    const taken = await at(FINANCE, () => takeUpFromBelow({ requestId: id.asked! }, { filer: { kind: "admin", agent: "claim_steward" } }));
    id.above = taken.request_id;
    const told = await atCompany(() => getRequest(id.asked!));
    expect(told!.taken_up_above).toMatchObject({ answer: "none yet" });
    // The fact carries no text from finance, names no label, and cost nothing.
    const facts = await atCompany(() => shownItems({ kind: "taken_up", replyRef: id.asked! }));
    expect(facts).toHaveLength(1);
    expect(JSON.stringify(told) + JSON.stringify(facts)).not.toContain(FINANCE);
    expect(await everyRow(`SELECT 1 FROM actions WHERE exclusion_group = $1`, [`redact:${facts[0]!.item_id}`])).toEqual([]);
    const [source] = await atCompany(() => rawQuery<{ raw_content: string }>(`SELECT raw_content FROM sources WHERE id = $1`, [facts[0]!.source_id]));
    expect(source!.raw_content).toContain("This request was taken up by work at a label this one does not read.");

    // Work with an outcome is recorded at finance, paid for by a mandate there. Its answer goes to the gate by itself.
    await at(FINANCE, () => recordWork({ requestId: id.above!, byLabel: "Researcher", outcome: "met", summary: `The escrow statement was read.\n\nIt shows ${SECRET}.`, fundedByJobId: id.mandateJob! }));
    const offered = (await at(FINANCE, () => gateItemFor({ kind: "answer", subjectRef: id.above!, toLabel: COMPANY })))!;
    expect(offered.state).toBe("waiting");
    expect((await atCompany(() => getRequest(id.asked!)))!.taken_up_above).toMatchObject({ answer: "at the gate" });
    // Paid from the budget of the work whose result is going down.
    expect(await payersOfGateWork(offered.item_id)).toEqual([id.mandate]);
    const item = await redactor(offered.item_id, "get_page_to_redact");
    expect(item.kind_of_thing).toBe("answer");
    expect(item.parts.map((p: any) => p.kind)).toEqual(["standing", "fact", "finding", "finding"]);
    expect((await redactor(offered.item_id, "redact", { part: 4, passage: SECRET, category: "commercial figures", note: "A balance." })).success).toBe(true);
    await finishAndPass(offered.item_id);
    expect(await personActs(offered.item_id)).toEqual([]);

    const answered = (await atCompany(() => getRequest(id.asked!)))!;
    expect(answered.taken_up_above).toMatchObject({ answer: "through the gate" });
    const work = answered.work.find((w) => w.by === "Work at a label this one does not read")!;
    expect(work.summary).toContain("The escrow statement was read.");
    expect(work.summary).toContain("It shows [redacted: commercial figures].");
    expect(JSON.stringify(answered)).not.toContain(SECRET);
    expect(JSON.stringify(answered)).not.toContain(FINANCE);
    // A reader of `public` alone is shown none of it.
    expect(await asPerson(["public"], () => shownItems({ replyRef: id.asked! }))).toEqual([]);
  });

  it("for one request, a person decides as well; and with the gate opened for answers, a later answer goes as written", async () => {
    const setting = await setGateMode({ boundaryId: id.gate!, scope: "request", scopeRef: id.above!, mode: "person", actor: admin });
    await at(FINANCE, () => recordWork({ requestId: id.above!, byLabel: "Researcher", outcome: "partly_met", summary: "A second statement was read.", fundedByJobId: id.mandateJob! }));
    const second = (await at(FINANCE, () => gateItemFor({ kind: "answer", subjectRef: id.above!, toLabel: COMPANY })))!;
    await finishAndPass(second.item_id);
    expect((await at(FINANCE, () => gateItemFor({ kind: "answer", subjectRef: id.above!, toLabel: COMPANY })))!.state).toBe("waiting");
    const waiting = (await gateQueue(orgHolder, { kind: "answer" })) as { items: any[] };
    expect(waiting.items.some((i) => i.item_id === second.item_id && i.kind_of_thing === "answer")).toBe(true);
    await decideAtGate({ actor: orgHolder, items: [{ item_id: second.item_id }], decision: "approve" });
    expect((await atCompany(() => getRequest(id.asked!)))!.work.some((w) => w.summary.includes("A second statement was read."))).toBe(true);

    // The request's own setting is ended, and answers at this gate are opened: the next goes with no run.
    expect(await endGateSetting({ settingId: setting.setting_id, actor: admin })).toEqual({ changed: true });
    await setGateMode({ boundaryId: id.gate!, kind: "answer", mode: "open", actor: admin });
    await at(FINANCE, () => recordWork({ requestId: id.above!, byLabel: "Researcher", outcome: "met", summary: "A third statement settled it.", fundedByJobId: id.mandateJob! }));
    const third = (await at(FINANCE, () => gateItemFor({ kind: "answer", subjectRef: id.above!, toLabel: COMPANY })))!;
    expect(third.state).toBe("released");
    expect(await payersOfGateWork(third.item_id)).toEqual([]);
    expect((await atCompany(() => getRequest(id.asked!)))!.work.some((w) => w.summary.includes("A third statement settled it."))).toBe(true);
    await setGateMode({ boundaryId: id.gate!, kind: "answer", mode: "redactor", actor: admin });
  });
});

describe("a message sent at company and answered at finance", () => {
  it("the answer goes to the gate, and reaches the sender when it is through", async () => {
    const sender = await seedNode(COMPANY, "A company node that asks");
    await at(COMPANY, () => postMessage({ nodeId: id.node!, trigger: "steward_note", body: "Does the escrow change this?", sender: { kind: "steward", nodeId: sender } }));
    const inbox = await stewardAt(FINANCE, () => openInbox(id.node!, Date.now()));
    const [message] = await everyRow<{ id: string }>(`SELECT id FROM node_messages WHERE node_id = $1 AND sender_node_id = $2`, [id.node, sender]);
    const label = [...inbox.labels.entries()].find(([, messageId]) => messageId === message!.id)![0];
    const result = JSON.parse(await stewardAt(FINANCE, () => answerMessages(id.node!, inbox.labels, [{ message: label, outcome: "no_change", note: `No: the escrow holds ${SECRET}, which the reserve already counts.` }])));
    expect(result.message).toContain("sent to the sender through the gate between the two labels");
    const offered = (await at(FINANCE, () => gateItemFor({ kind: "message", subjectRef: message!.id, toLabel: COMPANY })))!;
    expect(offered.state).toBe("waiting");
    // No mandate paid for the pass that answered, so finance's General mandate would pay; there is none yet, and the item waits.
    expect(await payersOfGateWork(offered.item_id)).toEqual([]);
    const backlog = JSON.stringify(await atCompany(() => gateBacklog({ clearance: [COMPANY, "public"], administer: false, releaseParties: [] })));
    expect(backlog).toContain('"kind":"message","kind_in_words":"an answer to a message","waiting_on":"funds"');
    // A General mandate at finance is set up, and the next look pays.
    id.general = (await seedMandate(FINANCE, { general: true })).grantId;
    expect(await retryGatePayments()).toBe(1);
    expect(await payersOfGateWork(offered.item_id)).toEqual([id.general]);
    expect((await redactor(offered.item_id, "redact", { part: 2, passage: SECRET, category: "commercial figures", note: "A balance." })).success).toBe(true);
    await finishAndPass(offered.item_id);
    const replies = await atCompany(() => rawQuery<{ body: string; trigger: string }>(`SELECT body, trigger FROM node_messages WHERE node_id = $1 AND reply_to = $2`, [sender, message!.id]));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toContain("It made no change.");
    expect(replies[0]!.body).toContain("No: the escrow holds [redacted: commercial figures], which the reserve already counts.");
    expect(replies[0]!.body).not.toContain(SECRET);
  });
});

describe("a mandate at finance: that it exists, and its funding of work at company", () => {
  it("its existence and terms go to the gate; the Redactor holds its budget, and the rest is shown at company", async () => {
    await system(() => rawQuery(`UPDATE grants SET mandate = '{"title": "Reserve review", "objective": "Assess the adequacy of reserves."}'::jsonb WHERE id = $1`, [id.mandate]));
    const offered = (await at(FINANCE, () => offerToGate({ kind: "mandate", fromLabel: FINANCE, toLabel: COMPANY, subject: { grantId: id.mandate! } })))!;
    expect(offered.state).toBe("waiting");
    // Offering it again changes nothing.
    expect((await at(FINANCE, () => offerToGate({ kind: "mandate", fromLabel: FINANCE, toLabel: COMPANY, subject: { grantId: id.mandate! } })))!.item_id).toBe(offered.item_id);
    const item = await redactor(offered.item_id, "get_page_to_redact");
    expect(item.parts.map((p: any) => p.kind)).toEqual(["fact", "name", "terms", "amount"]);
    expect((await redactor(offered.item_id, "hold_part", { part: 4, reason: "confidentiality", note: "Budgets are not shared." })).success).toBe(true);
    await finishAndPass(offered.item_id);
    const [listed] = await atCompany(() => shownItems({ kind: "mandate" }));
    expect(listed).toMatchObject({ item_id: offered.item_id, state: "through the gate" });
    const [source] = await atCompany(() => rawQuery<{ raw_content: string }>(`SELECT raw_content FROM sources WHERE id = $1`, [listed!.source_id]));
    expect(source!.raw_content).toContain("Reserve review");
    expect(source!.raw_content).toContain("Assess the adequacy of reserves.");
    expect(source!.raw_content).toContain("[An amount of funding, held by the Redactor]");
    expect(source!.raw_content).not.toContain("owls");
    expect(source!.raw_content).not.toContain(FINANCE);
  });

  it("its funding of a pass at company goes through the gate, and the pass is placed there when it is through", async () => {
    const target = await seedNode(COMPANY, "A company node finance wants assessed");
    const offered = (await at(FINANCE, () => fundBelow({ grantId: id.mandate!, nodeId: target, toLabel: COMPANY, amountMicroUsd: 2_000_000 })))!;
    expect(offered.state).toBe("waiting");
    // Nothing is at company yet: no pass opened, no message, no money.
    expect(await everyRow(`SELECT 1 FROM node_messages WHERE node_id = $1`, [target])).toEqual([]);
    const item = await redactor(offered.item_id, "get_page_to_redact");
    expect(item.parts).toHaveLength(1);
    expect(item.parts[0].text).toBe("A mandate at a label this one does not read pays 2.00 owls for a fresh assessment of this node here.");
    await finishAndPass(offered.item_id);
    expect((await at(FINANCE, () => gateItemFor({ kind: "funding", subjectRef: target, toLabel: COMPANY })))!.state).toBe("released");
    const messages = await atCompany(() => rawQuery<{ trigger: string; body: string }>(`SELECT trigger, body FROM node_messages WHERE node_id = $1`, [target]));
    expect(messages.map((m) => m.trigger)).toEqual(["funded_from_above"]);
    expect(messages[0]!.body).toContain("A mandate at a label this one does not read asked for a fresh assessment of this node here");
    expect(messages[0]!.body).not.toContain(FINANCE);
    // Who is paying for the pass at company: recorded for the report.
    const paid = await everyRow<{ grant_id: string | null }>(`SELECT grant_id FROM action_allocations WHERE claim_id = $1`, [target]);
    id.fundingPlaced = paid.some((p) => p.grant_id === id.mandate) ? "from the mandate above" : "opened for company's own funders";
    expect(["from the mandate above", "opened for company's own funders"]).toContain(id.fundingPlaced);
    process.stderr.write(`[the-gate] funding from above was placed: ${id.fundingPlaced}\n`);
  });
});

describe("company to public: the same gate one layer down", () => {
  it("a company page goes to readers of public under the same settings, paid by company's General mandate where no mandate paid for the work", async () => {
    id.companyGeneral = (await seedMandate(COMPANY, { general: true })).grantId;
    const node = await seedNode("public", "The company publishes its accounts yearly");
    await system(() =>
      rawQuery(
        `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label) VALUES ($1, 'supported', 0.9, 'It does.', 'Ten years of filings.', true, $2)`,
        [node, COMPANY]
      )
    );
    const asked = await askShowing({ nodeId: node, pageLabel: COMPANY, toLabel: "public", form: "once", scope: "node", actor: { ...director, clearance: [COMPANY, "public"] } });
    const item = await latestItem(asked.showing_id);
    expect(await payersOfGateWork(item)).toEqual([id.companyGeneral]);
    await finishAndPass(item, { answer: "supports", label: COMPANY });
    expect((await asPerson(["public"], () => shownPage(item)))!.state).toBe("released_whole");
    expect(await personActs(item)).toEqual([]);
  });
});

describe("the backlog, as the label below sees it", () => {
  it("says how many items wait, of what kinds, for how long and on whom, and nothing of what they contain or where they come from", async () => {
    // Something held by the Redactor, something waiting on a person, something waiting for its redaction.
    const held = await assessedAtFinance("The hedge was effective", id.mandateJob!, `It offset ${SECRET}.`);
    const asked = await askShowing({ nodeId: held, pageLabel: FINANCE, toLabel: COMPANY, form: "once", scope: "node", actor: director });
    const item = await latestItem(asked.showing_id);
    await redactor(item, "hold_part", { reason: "security", note: "The whole page turns on the figure." });
    await finishAndPass(item, { answer: "does_not_show_why" });
    const waiting = await assessedAtFinance("The swap was unwound", id.otherJob!, "It was unwound in May.");
    await followShowings();
    const [row] = await everyRow<{ id: string }>(`SELECT id FROM showing_pages WHERE node_id = $1`, [waiting]);
    await finishAndPass(row!.id, { answer: "supports" });
    const unredacted = await assessedAtFinance("The loan was repaid", id.mandateJob!, "It was repaid in June.");
    await askShowing({ nodeId: unredacted, pageLabel: FINANCE, toLabel: COMPANY, form: "once", scope: "node", actor: director });

    const reader = { clearance: [COMPANY, "public"], administer: false, releaseParties: [] };
    const backlog = (await atCompany(() => gateBacklog(reader))) as { gates: any[]; note: string };
    const gate = backlog.gates.find((g) => g.gate_id === id.gate)!;
    expect(gate.to).toBe(COMPANY);
    expect(gate.from).toBeUndefined();
    expect(gate.items_waiting).toBeGreaterThanOrEqual(3);
    const lines = gate.waiting.map((w: any) => `${w.kind}/${w.waiting_on}${w.party ? "/party" : ""}`);
    expect(lines).toEqual(expect.arrayContaining(["page/redactor", "page/waiting_on_person/party", "page/redactor_run"]));
    for (const line of gate.waiting) {
      expect(Object.keys(line).filter((k) => !["kind", "kind_in_words", "waiting_on", "in_words", "party", "items", "parts", "oldest_waiting_hours"].includes(k))).toEqual([]);
      expect(typeof line.oldest_waiting_hours).toBe("number");
    }
    const said = JSON.stringify(backlog);
    // No content, no label above, no node, no item, no mandate, no request.
    for (const hidden of [SECRET, FINANCE, "hedge", "swap", "loan", item, row!.id, held, waiting, id.mandate!, id.otherMandate!, id.above!, "Counsel", "turns on the figure"]) {
      expect(said).not.toContain(hidden);
    }
    // A reader of `public` alone, and a reader of the other partner's label, see none of this gate.
    expect(((await asPerson(["public"], () => gateBacklog({ clearance: ["public"], administer: false, releaseParties: [] }))) as { gates: any[] }).gates.some((g) => g.gate_id === id.gate)).toBe(false);
    expect(((await asPerson([B, "public"], () => gateBacklog({ clearance: [B, "public"], administer: false, releaseParties: [] }))) as { gates: any[] }).gates.some((g) => g.gate_id === id.gate)).toBe(false);

    // The gate's authorities see the same counts with the label things come from, whether or not they read company.
    const forAuthority = (await asPerson(["public"], () => gateBacklog({ clearance: ["public"], administer: true, releaseParties: [] }))) as { gates: any[] };
    expect(forAuthority.gates.find((g) => g.gate_id === id.gate)).toMatchObject({ from: FINANCE, to: COMPANY });

    // The authorities can keep the backlog to themselves; it is shown unless they do.
    await setGate({ boundaryId: id.gate!, backlogShown: false, actor: admin });
    expect(((await atCompany(() => gateBacklog(reader))) as { gates: any[] }).gates.some((g) => g.gate_id === id.gate)).toBe(false);
    expect(((await asPerson(["public"], () => gateBacklog({ clearance: ["public"], administer: true, releaseParties: [] }))) as { gates: any[] }).gates.some((g) => g.gate_id === id.gate)).toBe(true);
    await setGate({ boundaryId: id.gate!, backlogShown: true, actor: admin });
  });
});

describe("a gate's settings in one place", () => {
  it("lists what is set by kind, scope and party, to those with a say over it, and loosening lets through what was waiting", async () => {
    const [gate] = (await gatesFor({ ...admin, clearance: ["public"] })).filter((g) => g.gate_id === id.gate) as any[];
    expect(gate).toMatchObject({ from: FINANCE, to: COMPANY, flow: "asked", backlog_shown_to_the_other_side: true });
    expect(gate.settings.map((s: any) => `${s.kind}/${s.scope}/${s.party ? "party" : "all"}/${s.mode}`).sort()).toEqual([
      "*/mandate/party/person",
      "answer/boundary/all/redactor",
      "page/under/all/open",
    ]);
    // A reader of company with no say over the gate is not shown it.
    const forReader = await gatesFor({ id: await seedUser(), holding: [], administer: false, releaseParties: [], clearance: [COMPANY, "public"] });
    expect(forReader.some((g) => g.gate_id === id.gate)).toBe(false);
    // The organization's holder loosens its setting for that mandate: what was waiting on a person goes.
    const waitingBefore = ((await gateQueue(orgHolder)) as { items: any[] }).items.length;
    expect(waitingBefore).toBeGreaterThan(0);
    const [setting] = gate.settings.filter((s: any) => s.scope === "mandate");
    await endGateSetting({ settingId: setting.setting_id, actor: { ...admin, administer: false, releaseParties: [id.org!] } });
    expect(await settleWaiting({ boundaryId: id.gate! })).toBeGreaterThan(0);
    // Only what the Redactor holds is left for a person.
    const left = ((await gateQueue(orgHolder)) as { items: any[] }).items;
    expect(left.every((i) => i.held_by_the_redactor)).toBe(true);
  });

  it("everything flows, as one setting: each page at the label is offered as it is finished", async () => {
    await setGate({ boundaryId: id.gate!, flow: "everything", actor: admin });
    const asked = await askShowing({ pageLabel: FINANCE, toLabel: COMPANY, form: "standing", scope: "boundary", actor: director });
    expect(asked.pages_opened).toBeGreaterThan(0);
    const fresh = await assessedAtFinance("The dividend was covered", null, "It was covered twice.");
    expect(await followShowings()).toBeGreaterThanOrEqual(1);
    const [row] = await everyRow<{ id: string }>(`SELECT p.id FROM showing_pages p WHERE p.node_id = $1 AND p.showing_id = $2`, [fresh, asked.showing_id]);
    // No mandate paid for that judgment, so finance's General mandate pays for sending it down.
    expect(await payersOfGateWork(row!.id)).toEqual([id.general]);
    await setGate({ boundaryId: id.gate!, flow: "asked", actor: admin });
  });
});
