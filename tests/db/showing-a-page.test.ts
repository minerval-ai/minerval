/**
 * Showing a node's page below its label (docs/showing-a-page.md), against a
 * real database held to clearances: labels `r3-a`, `r3-b`, `r3-c` as the
 * label tests use them (`r3-c` reads `r3-a`; `r3-a` and `r3-b` read
 * `public` and not each other).
 *
 * No model runs here. The Redactor's and Audit's tools are driven directly
 * at the page's label, as their runs would call them, and the people's acts
 * are made through the services the routes call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { runAtLabel, withAgent } from "../../src/llm/usage-context.js";
import { executeAuditTool } from "../../src/llm/tools/audit-tools.js";
import { executePolicyReadTool } from "../../src/llm/tools/policy-read-tool.js";
import { executeRedactorTool } from "../../src/llm/tools/redactor-tools.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { madeBesideOf } from "../../src/services/judgment-version-service.js";
import { verifyShownPage, type ShownPageForCheck } from "../../src/services/page-fingerprint.js";
import { readablePolicies, savePolicyVersion } from "../../src/services/redaction-policy.js";
import {
  askedShowings,
  decideAtGate,
  holdPage,
  releaseQueue,
  setReleaseRule,
  shownPage,
  shownShowing,
  shownShowings,
  type GateActor,
} from "../../src/services/release-gate-service.js";
import { ShowingError, askShowing, endShowing, followShowings } from "../../src/services/showing-service.js";
import { withTransaction } from "../../src/db/client.js";
import { noteMirrorApplied, resetMirrorHeldForTests } from "../../src/services/mirrored-node-service.js";
import { openReassessmentsForVersionsMadeBesideEarlier } from "../../src/services/version-upkeep.js";
import { A, B, C, asPerson, attachSource, caught, seedNode, seedUser, system, unwall, wall } from "./review-3-common.js";

const SECRET = "4711 units";
const id: Record<string, string> = {};
const actor: Record<string, GateActor> = {};

const redactorAt = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a redactor's run", () => withAgent("redactor", fn));
const auditAt = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "an audit run", () => withAgent("audit", fn));
const tool = async (pageId: string, name: string, input: Record<string, unknown> = {}) =>
  JSON.parse(await redactorAt(C, () => executeRedactorTool(name, input, { pageId }))) as Record<string, any>;
const audit = async (name: string, input: Record<string, unknown>) =>
  JSON.parse(await auditAt(C, () => executeAuditTool(name, input, {}))) as Record<string, any>;
const atA = <T>(fn: () => Promise<T>) => asPerson([A, "public"], fn);
const atB = <T>(fn: () => Promise<T>) => asPerson([B, "public"], fn);
const atC = <T>(fn: () => Promise<T>) => asPerson([C, A, "public"], fn);

/** Redact nothing but the one passage, finish, and pass the check. Returns the page as the queue will have it. */
async function throughTheCheck(pageId: string, opts: { redact?: { part: number; passage: string }; answer?: string } = {}) {
  if (opts.redact) {
    const r = await tool(pageId, "redact", { ...opts.redact, category: "commercial figures", note: "A figure a counterparty could use." });
    expect(r.success).toBe(true);
  }
  const finished = await tool(pageId, "finish_redaction", { least_sure: opts.redact ? [{ part: opts.redact.part, why: "The figure may already be public." }] : [] });
  expect(finished.success).toBe(true);
  const passed = await audit("record_fidelity_outcome", { page_id: pageId, outcome: "pass", answer: opts.answer ?? "supports_in_part", reasons: "Each removal is covered by the category cited." });
  expect(passed.success).toBe(true);
  return finished;
}

beforeAll(async () => {
  await wall();
  await system(async () => {
    const party = async (name: string, own = false) =>
      (await rawQuery<{ id: string }>(`INSERT INTO parties (name, is_own_organization) VALUES ($1, $2) RETURNING id`, [`${name} ${Date.now()}`, own]))[0]!.id;
    const [existing] = await rawQuery<{ id: string }>(`SELECT id FROM parties WHERE is_own_organization`);
    id.org = existing?.id ?? (await party("The organization", true));
    if (!existing) id.orgMadeHere = "yes";
    id.acme = await party("Acme");
    id.borealis = await party("Borealis");
  });
  for (const who of ["director", "acmeReviewer", "borealisReviewer", "orgReviewer"]) id[who] = await seedUser();
  actor.director = { id: id.director!, holding: ["direct"], clearance: [C, A, "public"], releaseParties: [], direct: true };
  actor.acme = { id: id.acmeReviewer!, holding: ["release for Acme"], clearance: [C, A, "public"], releaseParties: [id.acme!], direct: false };
  actor.borealis = { id: id.borealisReviewer!, holding: ["release for Borealis"], clearance: ["public"], releaseParties: [id.borealis!], direct: false };
  actor.org = { id: id.orgReviewer!, holding: ["direct", "release for the organization"], clearance: [C, A, "public"], releaseParties: [id.org!], direct: true };

  // A public node with a version at a and a version at c, each resting on material at its own label.
  id.node = await seedNode("public", "The plant met its output target");
  id.child = await seedNode(C, "The night shift logs are complete");
  const aSource = await attachSource(id.node!, A, "An internal memo says the target was met.");
  id.aSource = aSource.source;
  const acme = await attachSource(id.node!, C, `Acme's meter data shows ${SECRET} produced.`);
  const borealis = await attachSource(id.node!, C, "Borealis's audit confirms the meters were calibrated.");
  id.acmeSource = acme.source;
  id.borealisSource = borealis.source;
  await system(async () => {
    await rawQuery(`UPDATE sources SET party_id = $2, content_hash = 'aaaa1111' WHERE id = $1`, [id.acmeSource, id.acme]);
    await rawQuery(`UPDATE sources SET party_id = $2 WHERE id = $1`, [id.borealisSource, id.borealis]);
    await rawQuery(`INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, sensitivity_label) VALUES ($1, $2, 'Acme', 'Acme is paid by output.', 'steward', $3)`, [id.acmeSource, id.node, C]);
    const [x1] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, inputs_recorded, sensitivity_label)
       VALUES ($1, 'inconclusive', 0.6, 'At a: the memo alone does not settle it.', 'At a: the memo alone does not settle it.', true, true, $2) RETURNING id`,
      [id.node, A]
    );
    id.x1 = x1!.id;
    await rawQuery(`INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, source_id, sensitivity_label) VALUES ('assessment', $1, 'source', $2, $3)`, [id.x1, id.aSource, A]);
    const [v] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, claim_credence, summary, reasoning_trace, model, is_current, sensitivity_label)
       VALUES ($1, 'supported', 0.8, 0.85, $2, $3, 'a-model', true, $4) RETURNING id`,
      [
        id.node,
        "The target was met, on meter data.\n\nOne caveat remains.",
        `The meter data shows ${SECRET} against a target of 4500.\n\nThe meters were calibrated in March.\n\nThe night shift logs were not all read.`,
        C,
      ]
    );
    id.v = v!.id;
    await rawQuery(`INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, input_judgment_id, input_label, sensitivity_label) VALUES ('assessment', $1, 'beside', $2, $3, $4)`, [id.v, id.x1, A, C]);
    const arg = async (stance: string, name: string, content: string) =>
      (await rawQuery<{ id: string }>(`INSERT INTO arguments (claim_id, stance, name, content, created_by, sensitivity_label) VALUES ($1, $2, $3, $4, 'steward', $5) RETURNING id`, [id.node, stance, name, content, C]))[0]!.id;
    id.argFor = await arg("for", "From the meters", "The meters record more than the target.");
    id.argAgainst = await arg("against", "From the missing logs", "Unread logs could hide a shortfall.");
    await rawQuery(`INSERT INTO argument_evaluations (argument_id, verdict, content, is_current, sensitivity_label) VALUES ($1, 'likely', 'The meters are direct evidence.', true, $2)`, [id.argFor, C]);
    await rawQuery(`INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning, sensitivity_label) VALUES ($1, $2, 'supports', 'Complete logs would close the caveat.', $3)`, [id.node, id.child, C]);
  });
}, 180_000);

afterAll(async () => {
  // A showing outside, and one to `public`, keep their destination side at `public`, which the review labels' cleanup leaves.
  await system(async () => {
    for (const showingId of [id.outside, id.toPublic]) {
      if (!showingId) continue;
      const [showing] = await rawQuery<{ boundary_id: string }>(`SELECT boundary_id FROM shown_showings WHERE id = $1`, [showingId]);
      await rawQuery(`DELETE FROM claim_instances WHERE source_id IN (SELECT source_id FROM shown_pages WHERE showing_id = $1)`, [showingId]);
      await rawQuery(`DELETE FROM sources WHERE id IN (SELECT source_id FROM shown_pages WHERE showing_id = $1)`, [showingId]);
      await rawQuery(`DELETE FROM shown_parts WHERE page_id IN (SELECT id FROM shown_pages WHERE showing_id = $1)`, [showingId]);
      for (const table of ["showing_acts", "shown_pages", "shown_nodes"]) await rawQuery(`DELETE FROM ${table} WHERE showing_id = $1`, [showingId]);
      await rawQuery(`DELETE FROM shown_showings WHERE id = $1`, [showingId]);
      await rawQuery(`DELETE FROM redaction_policies WHERE boundary_id = $1`, [showing?.boundary_id ?? null]);
    }
  }).catch((err: unknown) => console.warn("[showing-a-page] cleanup:", err instanceof Error ? err.message : err));
  // Everything else this file wrote is at one of the review labels, on either side of a boundary, and goes with them.
  await unwall();
  if (id.mirrored) {
    await system(() =>
      withTransaction(async (tx) => {
        await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
        await tx.query(`DELETE FROM assessments WHERE claim_id = $1`, [id.mirrored]);
        await tx.query(`DELETE FROM claims WHERE id = $1`, [id.mirrored]);
      })
    ).catch((err: unknown) => console.warn("[showing-a-page] cleanup:", err instanceof Error ? err.message : err));
  }
  await system(() => rawQuery(`DELETE FROM parties WHERE id = ANY($1::uuid[])`, [[id.acme, id.borealis, ...(id.orgMadeHere ? [id.org] : [])]])).catch((err: unknown) =>
    console.warn("[showing-a-page] cleanup:", err instanceof Error ? err.message : err)
  );
}, 180_000);

describe("asking", () => {
  it("refuses a destination that already reads the page, a node the page's label does not read, and a page shown once with no assessment", async () => {
    const ask = (over: Partial<Parameters<typeof askShowing>[0]>) =>
      caught(() => askShowing({ nodeId: id.node!, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: actor.director!, ...over }));
    const already = (await ask({ pageLabel: A, toLabel: C })) as ShowingError;
    expect(already.code).toBe("ALREADY_READ");
    expect(already.message).toBe(`Readers at "${C}" already read what is written at "${A}", so the page is in front of them whole and there is nothing to show.`);
    expect(((await ask({ nodeId: id.child!, pageLabel: A, toLabel: B })) as ShowingError).code).toBe("NODE_NOT_FOUND");
    expect(((await ask({ nodeId: id.child!, pageLabel: C, toLabel: A })) as ShowingError).code).toBe("NOTHING_TO_SHOW");
    expect(((await ask({ toLabel: "no-such-label" })) as ShowingError).code).toBe("UNKNOWN_LABEL");
  });

  it("opens the page, the boundary's policy on both sides and the redaction on the ledger, and shows nothing", async () => {
    const asked = await askShowing({ nodeId: id.node!, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: actor.director! });
    id.showing = asked.showing_id;
    expect(asked.pages_opened).toBe(1);
    expect(asked.policy.version).toBe(1);

    const record = (await atA(() => shownShowing(id.showing!)))!;
    expect(record.shown_to).toBe(`readers at "${A}"`);
    expect(record.asked_holding).toEqual(["direct"]);
    const [node] = record.nodes as any[];
    expect(node.state).toBe("held");
    expect(node.showing_began).toBe("after the node was first assessed");
    expect(node.versions[0].held_because).toBe("waiting for its redaction, which runs when it is paid for");
    id.page = node.versions[0].page_id;

    // The redaction is a row on the ledger at the page's label, waiting to be paid for.
    const actions = await system(() => rawQuery<{ kind: string; status: string; sensitivity_label: string }>(`SELECT kind, status, sensitivity_label FROM actions WHERE exclusion_group = $1`, [`redact:${id.page}`]));
    expect(actions).toEqual([{ kind: "redact", status: "open", sensitivity_label: C }]);

    // The policy is read on both sides, and the destination's row names no label of origin.
    const forA = await atA(() => readablePolicies());
    expect(forA.map((p) => [p.side, p.from, p.to])).toEqual([["destination", null, A]]);
    expect(await atB(() => readablePolicies())).toEqual([]);
    const forC = await atC(() => readablePolicies());
    expect(forC.map((p) => p.side).sort()).toEqual(["destination", "page"]);
    expect(forC[0]!.hash).toBe(forA[0]!.hash);

    // The Steward at c reads the policy its page may be shown under.
    const listed = JSON.parse((await runAtLabel(C, "a steward's run", () => executePolicyReadTool("get_redaction_policies", {})))!);
    expect(listed.policies).toHaveLength(1);
    expect(listed.policies[0].shown_to).toBe(A);
    expect(listed.policies[0].categories).toContain("commercial figures");
  });
});

describe("the Redactor's pass", () => {
  it("is given the page divided by its own structure, with what is always shown", async () => {
    const page = await tool(id.page!, "get_page_to_redact");
    expect(page.success).toBe(true);
    expect(page.parts.map((p: any) => p.kind)).toEqual([
      "summary", "summary", "reasoning", "reasoning", "reasoning", "argument", "argument", "reading", "reading", "supplier", "supplier", "subclaim",
    ]);
    expect(page.parts[2].text).toBe(`The meter data shows ${SECRET} against a target of 4500.`);
    expect(page.parts[5].text).toBe("Argument (for): From the meters\n\nThe meters record more than the target.\n\nEvaluation: likely if the premises hold\n\nThe meters are direct evidence.");
    expect(page.parts[11].text).toMatch(/^Subclaim \(supports\): The night shift logs are complete/);
    // Who supplied a source, by name, and the words of its interest are a part; that an outside party supplied it and that an interest is recorded are always shown.
    expect(page.parts[9].text).toMatch(/^Supplier of source 1: Acme \d+\n\nRecorded interest: Acme\. Acme is paid by output\.$/);
    expect(page.parts[10].text).toMatch(/^Supplier of source 2: Borealis \d+$/);
    expect(page.always_shown.verdict).toEqual({ status: "supported", confidence: 0.8, credence: 0.85 });
    expect(page.always_shown.sources).toHaveLength(2);
    expect(page.always_shown.sources).toEqual([
      { source: 1, kind: "unknown", fingerprint: "aaaa1111", supplied_by: "an_outside_party", interest_recorded: true },
      { source: 2, kind: "unknown", fingerprint: null, supplied_by: "an_outside_party", interest_recorded: false },
    ]);
    expect(JSON.stringify(page.always_shown)).not.toMatch(/Acme|Borealis|paid by output/);
    // Coverage is said to the readers the page is shown to: the memo at a is theirs to read, the two sources at c are not.
    expect(page.always_shown.coverage).toEqual({ examined: true, on: ["evidence_this_reader_can_read", "evidence_this_reader_cannot_read"] });
    expect(page.sources.map((s: any) => s.label).sort()).toEqual([A, C, C].sort());
    const source = await tool(id.page!, "get_page_to_redact", { source_id: id.acmeSource });
    expect(source.success).toBe(true);
  });

  it("removes a passage given exactly and leaves the category's mark, and refuses anything else", async () => {
    const policy = await tool(id.page!, "get_redaction_policy");
    expect(policy.policy).toContain("## What is shown whenever a page is shown");
    const wrongCategory = await tool(id.page!, "redact", { part: 3, passage: SECRET, category: "unfavorable to Acme", note: "x" });
    expect(wrongCategory.code).toBe("NO_SUCH_CATEGORY");
    const notThere = await tool(id.page!, "redact", { part: 3, passage: "4711  units", category: "commercial figures", note: "x" });
    expect(notThere.code).toBe("PASSAGE_NOT_FOUND");
    const first = await tool(id.page!, "redact", { part: 8, passage: "Acme's meter data", category: "internal identifiers", note: "Names the supplier's system." });
    expect(first.part_now_reads).toContain("[redacted: internal identifiers] shows");
    const back = await tool(id.page!, "restore", { removal_id: first.removal_id });
    expect(back.part_now_reads).toContain("Acme's meter data shows");
    const done = await tool(id.page!, "redact", { part: 3, passage: SECRET, category: "commercial figures", note: "An output figure a counterparty could use." });
    expect(done.part_now_reads).toBe("The meter data shows [redacted: commercial figures] against a target of 4500.");
    const again = await tool(id.page!, "redact", { part: 8, passage: SECRET, category: "commercial figures", note: "The same figure, quoted in the reading." });
    expect(again.success).toBe(true);
    expect((await tool(id.page!, "redact", { part: 3, passage: "4711", category: "commercial figures", note: "x" })).code).toBe("OVERLAPS");
  });

  it("records the root and the shape on the destination side when it finishes, before anyone decides anything", async () => {
    const finished = await tool(id.page!, "finish_redaction", { least_sure: [{ part: 4, why: "The calibration month may identify the auditor." }] });
    expect(finished.success).toBe(true);
    expect(finished.removals).toEqual({ "commercial figures": 2 });
    expect((await tool(id.page!, "redact", { part: 4, passage: "March", category: "commercial figures", note: "x" })).code).toBe("NOT_BEING_REDACTED");

    const shape = await atA(() => rawQuery<{ position: number; descriptor: string; commitment: string; text: string | null; salt: string | null }>(`SELECT position, descriptor, commitment, text, salt FROM shown_parts WHERE page_id = $1 ORDER BY position`, [id.page]));
    expect(shape.map((p) => p.descriptor)).toEqual(["summary", "summary", "reasoning", "reasoning", "reasoning", "argument:for", "argument:against", "reading", "reading", "supplier", "supplier", "subclaim"]);
    expect(shape.every((p) => p.text === null && p.salt === null && /^[0-9a-f]{64}$/.test(p.commitment))).toBe(true);
    const [page] = await atA(() => rawQuery<{ root: string; header: string | null; stage: string }>(`SELECT root, header, stage FROM shown_pages WHERE id = $1`, [id.page]));
    expect(page!.root).toBe(finished.root);
    expect(page!.header).toBeNull();
    expect(page!.stage).toBe("to_check");
    expect(await system(() => rawQuery(`SELECT 1 FROM showing_acts WHERE page_id = $1`, [id.page]))).toEqual([]);

    // Audit's check is asked for at the page's label.
    const audits = await system(() => rawQuery<{ audit_type: string; sensitivity_label: string }>(`SELECT audit_type, sensitivity_label FROM audit_runs WHERE context LIKE '%' || $1 || '%'`, [id.page]));
    expect(audits).toEqual([{ audit_type: "redaction_fidelity", sensitivity_label: C }]);
  });
});

describe("Audit's check", () => {
  it("reads the original and the redacted page, returns the work with reasons that stay at the page's label, and the redaction opens again", async () => {
    const work = await audit("get_redaction_to_check", { page_id: id.page });
    expect(work.parts[2].as_written).toContain(SECRET);
    expect(work.parts[2].as_redacted).not.toContain(SECRET);
    expect(work.parts[2].removals[0].note).toBe("An output figure a counterparty could use.");
    expect(work.least_sure).toHaveLength(1);

    const returned = await audit("record_fidelity_outcome", { page_id: id.page, outcome: "return", reasons: `The target of 4500 in part 3 lets a reader bound the figure ${SECRET}.` });
    expect(returned.success).toBe(true);
    const record = (await atA(() => shownShowing(id.showing!)))!;
    expect((record.nodes as any[])[0].versions[0].held_because).toBe("waiting for its redaction, which runs when it is paid for");
    expect((record.acts as any[]).map((a) => a.what)).toEqual(["asked for the showing", "the check returned the redaction to be done again"]);
    expect(JSON.stringify(record)).not.toContain("target of");
    const [action] = await system(() => rawQuery<{ status: string }>(`SELECT status FROM actions WHERE exclusion_group = $1`, [`redact:${id.page}`]));
    expect(action!.status).toBe("open");

    const page = await tool(id.page!, "get_page_to_redact");
    expect(page.round).toBe(2);
    expect(page.returned_by_audit).toContain("4500");
    expect(page.parts[2].removals).toHaveLength(1);
    await tool(id.page!, "redact", { part: 3, passage: "a target of 4500", category: "commercial figures", note: "Bounds the figure." });
    const finished = await tool(id.page!, "finish_redaction", { least_sure: [{ part: 4, why: "The calibration month may identify the auditor." }] });
    const [roots] = await atA(() => rawQuery<{ roots: any[]; root: string; round: number }>(`SELECT roots, root, round FROM shown_pages WHERE id = $1`, [id.page]));
    expect(roots!.round).toBe(2);
    expect(roots!.root).toBe(finished.root);
    expect(roots!.roots.map((r) => r.round)).toEqual([1, 2]);
  });

  it("passes the work with one of three fixed answers, which is all the other side is told", async () => {
    expect((await audit("record_fidelity_outcome", { page_id: id.page, outcome: "pass", answer: "it is fine", reasons: "x" })).code).toBe("ANSWER_NEEDED");
    const passed = await audit("record_fidelity_outcome", { page_id: id.page, outcome: "pass", answer: "supports_in_part", reasons: "The figures are gone and nothing else was removed." });
    expect(passed.success).toBe(true);
    const record = (await atA(() => shownShowing(id.showing!)))!;
    const version = (record.nodes as any[])[0].versions[0];
    expect(version.audit).toBe("The reasoning shown supports the verdict in part.");
    expect(version.state).toBe("held");
    expect(version.held_because).toMatch(/^waiting on (Acme|Borealis) \d+ and (Acme|Borealis) \d+$/);
  });
});

describe("the gate", () => {
  it("shows each holder of release the items that rest on their party, least sure first, as they would be shown, and the page as written only where they read its label", async () => {
    const forAcme = (await releaseQueue(actor.acme!)) as { items: any[] };
    // The verdict, the paragraphs of the summary and the reasoning, and Acme's own reading. Not Borealis's reading, and not the organization's parts.
    expect(forAcme.items.map((i) => i.part)).toEqual([null, 4, 1, 2, 3, 5, 8, 10]);
    expect(forAcme.items[1].redactor_least_sure).toBe(true);
    expect(forAcme.items[1].why_least_sure).toEqual(["The calibration month may identify the auditor."]);
    const figure = forAcme.items.find((i) => i.part === 3);
    expect(figure.as_written).toContain(SECRET);
    expect(figure.as_it_would_be_shown).toBe("The meter data shows [redacted: commercial figures] against [redacted: commercial figures].");
    expect(figure.removals_by_category).toEqual({ "commercial figures": 2 });
    expect(figure.audit).toBe("The reasoning shown supports the verdict in part.");
    expect(figure.rests_on.map((r: any) => r.standing)).toEqual(["waiting", "waiting"]);

    // Acme's reviewer reads the page's label: nothing tells them they are shown less.
    expect((forAcme as any).not_reading_the_label).toBeUndefined();
    expect(forAcme.items.every((i) => i.shown_as_released === undefined)).toBe(true);

    // Borealis's reviewer holds release for Borealis and reads `public` alone. They are shown what their decision would release.
    const forBorealis = (await releaseQueue(actor.borealis!)) as { items: any[] };
    expect(forBorealis.items.map((i) => i.part)).toEqual([null, 4, 1, 2, 3, 5, 9, 11]);
    const recorded = await system(() =>
      rawQuery<{ position: number; original: string; redacted: string | null }>(`SELECT position, original, redacted FROM showing_parts WHERE page_id = $1 ORDER BY position`, [id.page])
    );
    const [header] = await system(() => rawQuery<{ header: string }>(`SELECT header FROM showing_pages WHERE id = $1`, [id.page]));
    for (const item of forBorealis.items) {
      // What is always shown of the page is with every item, as recorded: no part is shown without it.
      expect(item.always_shown).toEqual(JSON.parse(header!.header));
      expect(item.shown_as_released).toBe(
        "You hold the permission to release this party's material and do not read the label this page was written at. You are shown what your decision would release, as it would be shown: the part with each removal marked, what is always shown of the page, and the node's wording. You are not shown the passages the Redactor removed, its notes, or why it flagged a part. The one exception is a passage removed from a part that rests only on the material of an outside party you release for, which is that party's own. An administrator of this deployment grants reading at a label."
      );
      if (item.part === null) continue;
      const part = recorded.find((p) => p.position === item.part)!;
      // Each part exactly as it would be shown if released: after the Redactor's removals, with the marks.
      expect(item.as_it_would_be_shown).toBe(part.redacted ?? part.original);
    }
    expect(forBorealis.items.find((i) => i.part === 3).as_it_would_be_shown).toBe("The meter data shows [redacted: commercial figures] against [redacted: commercial figures].");
    expect(forBorealis.items.find((i) => i.part === 3).removals_by_category).toEqual({ "commercial figures": 2 });
    // The part the Redactor flagged says that it was flagged, and not why.
    expect(forBorealis.items[1].part).toBe(4);
    expect(forBorealis.items[1].redactor_least_sure).toBe(true);
    expect(forBorealis.items[1].removals_by_category).toEqual({});
    expect((forBorealis as any).not_reading_the_label).toBe(
      "8 of these 8 items are of a page written at a label you do not read. For each you are shown the text your decision would release, as it would be shown, and not what was removed from it or what the Redactor wrote about it."
    );
  });

  it("shows a holder who does not read the page's label nothing but what their decision would release", async () => {
    const forBorealis = (await releaseQueue(actor.borealis!)) as { items: any[] };
    const said = JSON.stringify(forBorealis);
    // No removed passage: the figure, and the target that bounds it. Each is in a part that rests on Acme's material too.
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain("4500");
    // No word of the Redactor's notes or of why it flagged a part, and none of Audit's reasons.
    for (const written of [
      "An output figure a counterparty could use",
      "The same figure, quoted in the reading",
      "Bounds the figure",
      "calibration month may identify",
      "The figures are gone and nothing else was removed",
      "lets a reader bound the figure",
    ]) {
      expect(said).not.toContain(written);
    }
    // No part that is not theirs to decide: Acme's reading and supplier, and the organization's arguments and subclaim.
    for (const notTheirs of ["Acme's meter data", "paid by output", "The meters record more than the target", "Unread logs could hide a shortfall", "Complete logs would close the caveat"]) {
      expect(said).not.toContain(notTheirs);
    }
    // No page as written, no passage, no note and no reason on any item: only the keys below.
    const allowed = new Set([
      "page_id", "showing_id", "node_id", "node", "always_shown", "audit", "waiting_since", "shown_as_released",
      "part", "kind", "decide_for", "rests_on", "held", "removals_by_category", "redactor_least_sure", "as_it_would_be_shown",
    ]);
    for (const item of forBorealis.items) expect(Object.keys(item).filter((k) => !allowed.has(k))).toEqual([]);
    // The node is a public one, which they read like anyone; the page carries no wording of its own.
    expect(forBorealis.items[0].node).toMatch(/^The plant met its output target/);

    // A passage removed from a part that rests only on the material of an outside party the holder releases for is
    // that party's own, and is shown: the passage and its category, without the Redactor's note. Here, a holder of
    // release for Acme who reads `public` alone.
    const acmeOutside: GateActor = { ...actor.acme!, clearance: ["public"] };
    const forAcmeOutside = (await releaseQueue(acmeOutside)) as { items: any[] };
    const reading = forAcmeOutside.items.find((i) => i.part === 8);
    expect(reading.rests_on.map((r: any) => r.party.id)).toEqual([id.acme]);
    expect(reading.removals).toEqual([{ passage: SECRET, category: "commercial figures" }]);
    expect(reading.as_it_would_be_shown).toContain("[redacted: commercial figures]");
    expect(reading.as_written).toBeUndefined();
    // The same figure removed from a paragraph that rests on Borealis's material too is not shown to them.
    const figure = forAcmeOutside.items.find((i) => i.part === 3);
    expect(figure.removals).toBeUndefined();
    expect(JSON.stringify(forAcmeOutside)).not.toContain("4500");
    expect(JSON.stringify(forAcmeOutside)).not.toContain("The same figure, quoted in the reading");
    expect(forAcmeOutside.items.every((i) => i.as_written === undefined && i.why_least_sure === undefined)).toBe(true);
  });

  it("releases a part that rests on two parties only when both have released it, and shows nothing until the page itself is released", async () => {
    const all = (parts: Array<number | null>) => parts.map((part) => ({ page_id: id.page!, part }));
    const notTheirs = await decideAtGate({ actor: actor.acme!, partyId: id.acme!, items: all([9]), decision: "release" });
    expect(notTheirs.refused[0]!.why).toBe("This item does not rest on that party's material, so it is not that party's to release or hold.");
    await expect(decideAtGate({ actor: actor.acme!, partyId: id.borealis!, items: all([9]), decision: "release" })).rejects.toThrow(/do not hold the permission to release/);

    const acme = await decideAtGate({ actor: actor.acme!, partyId: id.acme!, items: all([null, 1, 2, 3, 4, 5, 8, 10]), decision: "release" });
    expect(acme.decided).toBe(8);
    expect(acme.shown).toEqual([]);
    expect((await atA(() => shownPage(id.page!)))!.state).toBe("held");
    expect(await atA(() => rawQuery(`SELECT 1 FROM shown_parts WHERE page_id = $1 AND text IS NOT NULL`, [id.page]))).toEqual([]);

    // Borealis holds one paragraph and releases the rest; the organization holds the argument against.
    await expect(decideAtGate({ actor: actor.borealis!, partyId: id.borealis!, items: all([4]), decision: "hold", reason: "because" })).rejects.toThrow(/reason from this list/);
    await decideAtGate({ actor: actor.borealis!, partyId: id.borealis!, items: all([4]), decision: "hold", reason: "confidentiality" });
    await decideAtGate({ actor: actor.org!, partyId: id.org!, items: all([6, 12]), decision: "release" });
    await decideAtGate({ actor: actor.org!, partyId: id.org!, items: all([7]), decision: "hold", reason: "under_review" });
    const borealis = await decideAtGate({ actor: actor.borealis!, partyId: id.borealis!, items: all([null, 1, 2, 3, 5, 9, 11]), decision: "release" });
    expect(borealis.shown).toEqual([id.page]);
  });

  it("refuses to take a release back, and offers no way to change a part", async () => {
    const back = await decideAtGate({ actor: actor.acme!, partyId: id.acme!, items: [{ page_id: id.page!, part: 3 }], decision: "hold", reason: "timing" });
    expect(back.refused[0]!.why).toBe("This party has released it, and a release is not taken back.");
    await expect(holdPage({ actor: actor.director!, pageId: id.page!, reason: "timing" })).rejects.toThrow(/has been shown, and a release is not taken back/);
  });
});

describe("what the destination sees", () => {
  it("a reader at the destination label reads the released parts with their marks, the held parts by kind and holder, and can verify them", async () => {
    const page = (await atA(() => shownPage(id.page!)))!;
    expect(page.state).toBe("released_in_part");
    expect(page.parts_held).toBe(2);
    expect(page.of_parts).toBe(12);
    expect((page.parts as any[])[9].text).toMatch(/^Supplier of source 1: Acme/);
    expect(page.held_kinds).toBe("a paragraph of reasoning, an argument against");
    const parts = page.parts as any[];
    expect(parts[2].text).toBe("The meter data shows [redacted: commercial figures] against [redacted: commercial figures].");
    expect(parts[2].removals_marked).toEqual([{ at: 21, category: "commercial figures" }, { at: 60, category: "commercial figures" }]);
    expect(parts[3].held).toMatch(/^\[A paragraph of reasoning, held by Borealis \d+\]$/);
    expect(parts[3].text).toBeUndefined();
    expect(parts[6].held).toMatch(/^\[An argument against, held by The organization/);
    expect((page.always_shown as any).verdict).toEqual({ status: "supported", confidence: 0.8, credence: 0.85 });
    expect((page.always_shown as any).removals).toEqual({ "commercial figures": 3 });
    expect((page.always_shown as any).made.policy.version).toBe(1);
    expect((page.always_shown as any).made.prompt_set).toMatch(/^[0-9a-f]{64}$/);
    expect(page.verification).toEqual({ ok: true, problems: [], checked: 11, held: 2 });
    const whole = JSON.stringify(page);
    for (const hidden of [SECRET, "target of", "in March", "Unread logs", "An output figure"]) expect(whole).not.toContain(hidden);
  });

  it("the verifier catches a part that was altered, swapped, dropped or moved", async () => {
    const page = (await atA(() => shownPage(id.page!)))!;
    const hashed = page.always_shown_as_hashed as { text: string; salt: string; hash: string };
    const given = (): ShownPageForCheck => ({
      root: page.fingerprint as string,
      verdict: { position: 0, descriptor: "verdict", commitment: hashed.hash, text: hashed.text, salt: hashed.salt, marks: [] },
      parts: (page.parts as any[]).map((p) => ({ position: p.part, descriptor: p.descriptor, commitment: p.hash, text: p.text ?? null, marks: p.removals_marked ?? null, salt: p.salt ?? null })),
    });
    expect(verifyShownPage(given()).ok).toBe(true);

    const altered = given();
    (altered.parts[0] as any).text = (altered.parts[0] as any).text.replace("met", "missed");
    expect(verifyShownPage(altered).problems[0]).toBe("Part 1 does not match its hash: its text, its marks or its salt is not what was recorded.");

    const alteredVerdict = given();
    alteredVerdict.verdict.text = alteredVerdict.verdict.text!.replace('"supported"', '"verified"');
    expect(verifyShownPage(alteredVerdict).ok).toBe(false);

    const swapped = given();
    const [first, second] = [swapped.parts[0]!, swapped.parts[1]!];
    (swapped.parts as any)[0] = { ...second, position: 1 };
    (swapped.parts as any)[1] = { ...first, position: 2 };
    expect(verifyShownPage(swapped).ok).toBe(false);

    const dropped = given();
    (dropped.parts as any).splice(6, 1);
    expect(verifyShownPage(dropped).ok).toBe(false);
    const droppedAndRenumbered = given();
    (droppedAndRenumbered as any).parts = droppedAndRenumbered.parts.filter((_, i) => i !== 6).map((p, i) => ({ ...p, position: i + 1 }));
    expect(verifyShownPage(droppedAndRenumbered).ok).toBe(false);

    const reordered = given();
    (reordered.parts as any).reverse();
    expect(verifyShownPage(reordered).problems.some((p) => /out of order/.test(p))).toBe(true);

    const heldRenamed = given();
    (heldRenamed.parts[6] as any).descriptor = "argument:for";
    expect(verifyShownPage(heldRenamed).ok).toBe(false);
  });

  it("nothing at the page's label is read at the destination label, by a reader, a run, or an error", async () => {
    for (const table of ["showings", "showing_pages", "showing_parts", "showing_removals"]) {
      expect(await atA(() => rawQuery(`SELECT 1 FROM ${table}`)), table).toEqual([]);
      expect(await runAtLabel(A, "a run at a", () => rawQuery(`SELECT 1 FROM ${table}`)), table).toEqual([]);
    }
    expect((await atA(() => askedShowings())).length).toBe(0);
    expect((await atC(() => askedShowings())).length).toBe(1);
    // A reader at b, which the page was not shown to, finds no showing at all.
    expect(await atB(() => shownShowings())).toEqual([]);
    expect(await atB(() => shownShowing(id.showing!))).toBeNull();
    expect(await atB(() => shownPage(id.page!))).toBeNull();
    expect(await atB(() => rawQuery(`SELECT 1 FROM shown_parts`))).toEqual([]);
    // The Redactor's and Audit's tools at the destination label find no page.
    const fromA = JSON.parse(await redactorAt(A, () => executeRedactorTool("get_page_to_redact", {}, { pageId: id.page! })));
    expect(fromA).toEqual({ success: false, code: "PAGE_NOT_FOUND", message: "No page under a showing has that id at a label this work reads." });
    const everythingAtA = await atA(async () =>
      JSON.stringify([
        await rawQuery(`SELECT * FROM shown_pages`), await rawQuery(`SELECT * FROM shown_parts`), await rawQuery(`SELECT * FROM showing_acts`),
        await rawQuery(`SELECT * FROM shown_nodes`), await rawQuery(`SELECT * FROM shown_showings`), await rawQuery(`SELECT * FROM redaction_policies`),
        await rawQuery(`SELECT raw_content, title FROM sources`), await rawQuery(`SELECT verbatim_text, context FROM claim_instances`),
        await rawQuery(`SELECT body FROM node_messages`),
      ])
    );
    for (const hidden of [SECRET, "target of", "in March", "Unread logs", "An output figure", "Bounds the figure", C]) expect(everythingAtA, hidden).not.toContain(hidden);
  });
});

describe("arrival at the destination label", () => {
  it("the shown page is a source there, attached to the node, and a reassessment is opened at that label and no other", async () => {
    const [page] = await atA(() => rawQuery<{ source_id: string }>(`SELECT source_id FROM shown_pages WHERE id = $1`, [id.page]));
    id.shownSource = page!.source_id;
    const [source] = await atA(() => rawQuery<{ source_type: string; raw_content: string; sensitivity_label: string; content_hash: string }>(`SELECT source_type, raw_content, sensitivity_label, content_hash FROM sources WHERE id = $1`, [id.shownSource]));
    expect(source!.source_type).toBe("shown_page");
    expect(source!.sensitivity_label).toBe(A);
    expect(source!.raw_content).toContain("Status: supported. Confidence: 0.8. Credence: 0.85.");
    expect(source!.raw_content).toContain("Removals under the policy: commercial figures: 3.");
    expect(source!.raw_content).toContain("source 1: unknown, supplied by an outside party, an interest in this node is recorded for it, fingerprint aaaa1111");
    expect(source!.raw_content).toContain("source 2: unknown, supplied by an outside party, no interest in this node is recorded for it");
    expect(source!.raw_content).toContain("Parts: 12, of which 2 are held (a paragraph of reasoning, an argument against).");
    expect(source!.raw_content).toContain("Audit's check of the redaction: The reasoning shown supports the verdict in part.");
    expect(source!.raw_content).toContain("[redacted: commercial figures]");
    expect(source!.raw_content).not.toContain(SECRET);

    const instances = await atA(() => rawQuery<{ stance: string; verbatim_text: string }>(`SELECT stance, verbatim_text FROM claim_instances WHERE source_id = $1 AND claim_id = $2`, [id.shownSource, id.node]));
    expect(instances).toEqual([{ stance: "mentions", verbatim_text: "Status: supported. Confidence: 0.8. Credence: 0.85." }]);

    const messages = await system(() => rawQuery<{ trigger: string; sensitivity_label: string; body: string }>(`SELECT trigger, sensitivity_label, body FROM node_messages WHERE node_id = $1 AND trigger = 'page_shown'`, [id.node]));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sensitivity_label).toBe(A);
    expect(messages[0]!.body).toContain("3 passages were removed under the boundary's policy and marked in place, and 2 of its 12 parts are held.");
    const slots = await system(() => rawQuery<{ l: string; s: string }>(`SELECT sensitivity_label AS l, steward_state AS s FROM steward_slots WHERE claim_id = $1 ORDER BY 1`, [id.node]));
    expect(slots).toEqual([{ l: A, s: "pending" }]);
    const [own] = await system(() => rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [id.node]));
    expect(own!.steward_state).toBe("done");

    // A Steward's run at a reads the node and finds the shown page among its sources, and nothing of the original.
    const read = await runAtLabel(A, "a steward's run", () => withAgent("steward", () => executeStewardTool("get_claim", { claim_id: id.node })));
    expect(read).not.toContain(SECRET);
    expect(read).not.toContain("Unread logs");
  });

  it("the lower version taking the page in does not make the higher version read as made against an earlier one", async () => {
    // The Steward at a records a new version whose inputs are what the earlier one had, and the shown page.
    await system(async () => {
      await rawQuery(`UPDATE assessments SET is_current = false WHERE id = $1`, [id.x1]);
      const [x2] = await rawQuery<{ id: string }>(
        `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, inputs_recorded, sensitivity_label)
         VALUES ($1, 'supported', 0.7, 'At a: the shown page settles more.', 'At a: the shown page settles more.', true, true, $2) RETURNING id`,
        [id.node, A]
      );
      id.x2 = x2!.id;
      await rawQuery(`INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, source_id, sensitivity_label) VALUES ('assessment', $1, 'source', $2, $3), ('assessment', $1, 'source', $4, $3)`, [id.x2, id.aSource, A, id.shownSource]);
    });
    // The version at a that took the shown page in was made, in part, on evidence a reader at a cannot read, and its coverage says so.
    const { summarizeCoverage, coverageRow } = await import("../../src/services/coverage-service.js");
    const atADoes = (await atA(() => summarizeCoverage([id.node!]))).get(id.node!)!;
    expect(atADoes).toEqual({ examined: true, on: ["evidence_this_reader_can_read", "evidence_this_reader_cannot_read"] });
    expect(coverageRow(atADoes)).toEqual({ examined: true, on: ["evidence_this_reader_cannot_read"] });
    // A reader at c reads everything its version was made on.
    expect((await atC(() => summarizeCoverage([id.node!]))).get(id.node!)).toEqual({ examined: true, on: ["evidence_this_reader_can_read"] });
    expect(await openReassessmentsForVersionsMadeBesideEarlier({ claimIds: [id.node!] })).toBe(0);
    const beside = await runAtLabel(C, "a read at c", () => madeBesideOf("assessments", "assessment", [id.v!]));
    expect(beside.get(id.v!)!.beside).toEqual([{ label: A, judgment_id: id.x1, replaced: false }]);

    // A later version at a that rests on something else as well is a replacement like any other.
    await system(async () => {
      await rawQuery(`UPDATE assessments SET is_current = false WHERE id = $1`, [id.x2]);
      const [x3] = await rawQuery<{ id: string }>(
        `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, inputs_recorded, sensitivity_label)
         VALUES ($1, 'supported', 0.75, 'At a: a new memo as well.', 'At a: a new memo as well.', true, true, $2) RETURNING id`,
        [id.node, A]
      );
      const other = await attachSource(id.node!, A, "A second memo.");
      await rawQuery(`INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, source_id, sensitivity_label) VALUES ('assessment', $1, 'source', $2, $3), ('assessment', $1, 'source', $4, $3), ('assessment', $1, 'source', $5, $3)`, [x3!.id, id.aSource, A, id.shownSource, other.source]);
    });
    const after = await runAtLabel(C, "a read at c", () => madeBesideOf("assessments", "assessment", [id.v!]));
    expect(after.get(id.v!)!.beside[0]!.replaced).toBe(true);
    expect(await openReassessmentsForVersionsMadeBesideEarlier({ claimIds: [id.node!] })).toBe(1);
    const opened = await system(() => rawQuery<{ sensitivity_label: string }>(`SELECT sensitivity_label FROM node_messages WHERE node_id = $1 AND trigger = 'version_beside_changed'`, [id.node]));
    expect(opened).toEqual([{ sensitivity_label: C }]);
  });

  it("a hold is lifted and never deleted, and the page arrives again with more of it released", async () => {
    const lifted = await decideAtGate({ actor: actor.borealis!, partyId: id.borealis!, items: [{ page_id: id.page!, part: 4 }], decision: "lift" });
    expect(lifted.decided).toBe(1);
    expect(((await atA(() => shownPage(id.page!)))!.parts as any[])[3].held).toMatch(/held by Borealis/);
    const released = await decideAtGate({ actor: actor.borealis!, partyId: id.borealis!, items: [{ page_id: id.page!, part: 4 }], decision: "release" });
    expect(released.decided).toBe(1);
    const page = (await atA(() => shownPage(id.page!)))!;
    expect((page.parts as any[])[3].text).toBe("The meters were calibrated in March.");
    expect(page.parts_held).toBe(1);
    expect(page.verification!.ok).toBe(true);

    const acts = ((await atA(() => shownShowing(id.showing!)))!.acts as any[]).filter((a) => a.on === "part 4" && /Borealis/.test(a.for_party ?? ""));
    expect(acts.map((a) => a.what)).toEqual(["held", "lifted a hold", "released"]);
    expect(acts[0].reason).toBe("confidential to the party");
    expect(acts[0].holding).toEqual(["release for Borealis"]);

    // A source's text does not change: the page arrives again as a new source, and the earlier one gives way.
    const arrivals = await atA(() => rawQuery<{ id: string; detached: boolean }>(
      `SELECT s.id, i.detached_at IS NOT NULL AS detached FROM sources s JOIN claim_instances i ON i.source_id = s.id
        WHERE s.source_type = 'shown_page' AND i.claim_id = $1 ORDER BY s.retrieved_at`, [id.node]));
    expect(arrivals.map((a) => a.detached)).toEqual([true, false]);
    expect(arrivals[0]!.id).toBe(id.shownSource);
  });
});

describe("two people deciding at once", () => {
  it("settle the page one after the other, and it arrives once", async () => {
    for (let round = 0; round < 3; round++) {
      const asked = await askShowing({ nodeId: id.node!, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: actor.director! });
      const record = (await atA(() => shownShowing(asked.showing_id)))!;
      const pageId = (record.nodes as any[])[0].versions[0].page_id as string;
      await throughTheCheck(pageId);
      const all = (parts: Array<number | null>) => parts.map((part) => ({ page_id: pageId, part }));
      // Everything but the page itself, which rests on both outside parties.
      await decideAtGate({ actor: actor.acme!, partyId: id.acme!, items: all([1, 2, 3, 4, 5, 8, 10]), decision: "release" });
      await decideAtGate({ actor: actor.borealis!, partyId: id.borealis!, items: all([1, 2, 3, 4, 5, 9, 11]), decision: "release" });
      await decideAtGate({ actor: actor.org!, partyId: id.org!, items: all([6, 7, 12]), decision: "release" });
      expect((await atA(() => shownPage(pageId)))!.state).toBe("held");
      // Both release the page in the same instant, and each then settles it.
      const both = await Promise.all([
        decideAtGate({ actor: actor.acme!, partyId: id.acme!, items: all([null]), decision: "release" }),
        decideAtGate({ actor: actor.borealis!, partyId: id.borealis!, items: all([null]), decision: "release" }),
      ]);
      expect(both.map((r) => r.decided)).toEqual([1, 1]);
      expect((await atA(() => shownPage(pageId)))!.state).toBe("released_whole");
      const arrivals = await system(() => rawQuery<{ url: string }>(`SELECT url FROM sources WHERE url LIKE $1`, [`minerval:shown-page/${pageId}/%`]));
      expect(arrivals.map((a) => a.url)).toEqual([`minerval:shown-page/${pageId}/1`]);
    }
  });
});

describe("a standing showing of a node with what sits under it", () => {
  it("covers a node before it is assessed, and follows a first version, a new subclaim, a removed edge and a later version", async () => {
    // A node at c, which a reader at a cannot read at all.
    id.root = await seedNode(C, "The line can run at full speed");
    const asked = await askShowing({ nodeId: id.root!, pageLabel: C, toLabel: A, form: "standing", scope: "under", actor: actor.director! });
    id.standing = asked.showing_id;
    expect(asked.pages_opened).toBe(0);
    await expect(askShowing({ nodeId: id.root!, pageLabel: C, toLabel: A, form: "standing", scope: "under", actor: actor.director! })).rejects.toThrow(/already stands/);
    let record = (await atA(() => shownShowing(id.standing!)))!;
    expect((record.nodes as any[]).map((n) => [n.state, n.text, n.showing_began])).toEqual([["not_yet_assessed", null, "before the node was first assessed"]]);

    // A rule: the organization's untouched parts are released without a person deciding each.
    const rule = await setReleaseRule({ actor: actor.org!, partyId: id.org!, pageLabel: C, toLabel: A, condition: "nothing_removed_and_only_ours", coversVerdict: true });
    id.rule = rule.rule_id;

    const version = (words: string) =>
      system(async () => {
        await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND sensitivity_label = $2`, [id.root, C]);
        await rawQuery(`INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label) VALUES ($1, 'supported', 0.7, $2, $2, true, $3)`, [id.root, words, C]);
      });
    // A pass on the node is still running when its assessment appears: the page is not recorded from a half-finished pass.
    await system(() => rawQuery(`UPDATE claims SET steward_state = 'running' WHERE id = $1`, [id.root]));
    await version("First reading of the line speed.");
    expect(await followShowings()).toBe(0);
    expect(((await atA(() => shownShowing(id.standing!)))!.nodes as any[])[0].state).toBe("not_yet_assessed");
    await expect(askShowing({ nodeId: id.root!, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: actor.director! })).rejects.toThrow(
      `A pass on this node at "${C}" is running now, and a page shown once is the page as it stands when it is asked for. Ask again when the pass has finished, so that the page is the finished one.`
    );
    // The pass adds an argument after its assessment and ends; the page recorded then has it.
    await system(async () => {
      await rawQuery(`INSERT INTO arguments (claim_id, stance, name, content, created_by, sensitivity_label) VALUES ($1, 'for', 'Written last', 'Added after the assessment, in the same pass.', 'steward', $2)`, [id.root, C]);
      await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id.root]);
    });
    expect(await followShowings()).toBe(1);
    const [recorded] = await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM showing_parts p JOIN showing_pages g ON g.id = p.page_id WHERE g.node_id = $1 AND p.kind = 'argument'`, [id.root]));
    expect(recorded!.n).toBe(1);
    record = (await atA(() => shownShowing(id.standing!)))!;
    const firstPage = (record.nodes as any[])[0].versions[0].page_id;
    expect((record.nodes as any[])[0].state).toBe("held");

    // A later version before the first was redacted: the first is not redacted, and stays in the history.
    await version(`Second reading. The gearbox serial is ${SECRET}.`);
    expect(await followShowings()).toBe(1);
    record = (await atA(() => shownShowing(id.standing!)))!;
    const versions = (record.nodes as any[])[0].versions;
    expect(versions.map((v: any) => v.held_because)).toEqual([
      "waiting for its redaction, which runs when it is paid for",
      "a later version was recorded before this one was redacted, so this one was not",
    ]);
    expect(versions[1].page_id).toBe(firstPage);
    id.rootPage = versions[0].page_id;
    expect((await tool(firstPage, "redact", { part: 1, passage: "First", category: "test content", note: "x" })).code).toBe("NOT_BEING_REDACTED");

    // A subclaim comes under it, and is covered from then as not yet assessed.
    id.under = await seedNode(C, "The gearbox was serviced");
    await system(() => rawQuery(`INSERT INTO claim_relationships (id, parent_claim_id, child_claim_id, relation_type, reasoning, sensitivity_label) VALUES (gen_random_uuid(), $1, $2, 'requires', 'A worn gearbox limits speed.', $3)`, [id.root, id.under, C]));
    await followShowings();
    record = (await atA(() => shownShowing(id.standing!)))!;
    expect((record.nodes as any[]).map((n) => [n.node_id, n.state, n.under])).toEqual([[id.root, "held", null], [id.under, "not_yet_assessed", id.root]]);

    // The edge is removed: the node leaves, with a dated event and the reason.
    await system(() => rawQuery(`DELETE FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = $2`, [id.root, id.under]));
    await followShowings();
    record = (await atA(() => shownShowing(id.standing!)))!;
    const left = (record.nodes as any[])[1];
    expect(left.left_because).toBe("the link that placed it under the shown node was removed");
    expect(typeof left.left_at).toBe("string");
  });

  it("releases what a standing rule covers when the page reaches the gate, and shows the node's wording as a part of its page", async () => {
    // The figure stands in the summary and in the reasoning, and is removed from both.
    expect((await tool(id.rootPage!, "redact", { part: 2, passage: SECRET, category: "commercial figures", note: "A serial number." })).success).toBe(true);
    await throughTheCheck(id.rootPage!, { redact: { part: 3, passage: SECRET }, answer: "supports" });
    const page = (await atA(() => shownPage(id.rootPage!)))!;
    // The wording was untouched and is the organization's alone: the rule released it, and the page.
    expect(page.state).toBe("released_in_part");
    const parts = page.parts as any[];
    expect(parts[0].kind).toBe("wording");
    expect(parts[0].text).toMatch(/^The line can run at full speed/);
    expect(parts[1].held).toMatch(/^\[A paragraph of the summary, held by The organization/);
    expect(parts[2].held).toMatch(/^\[A paragraph of reasoning, held by The organization/);
    const acts = ((await atA(() => shownShowing(id.standing!)))!.acts as any[]).filter((a) => a.what === "released");
    expect(acts.every((a) => a.by === "a standing rule" && a.rule_id === id.rule)).toBe(true);

    // The destination cannot read the node, so the page arrives as a source attached to nothing, and no reassessment is opened.
    const [arrived] = await atA(() => rawQuery<{ source_id: string }>(`SELECT source_id FROM shown_pages WHERE id = $1`, [id.rootPage]));
    expect(arrived!.source_id).toBeTruthy();
    expect(await system(() => rawQuery(`SELECT 1 FROM claim_instances WHERE source_id = $1`, [arrived!.source_id]))).toEqual([]);
    expect(await system(() => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1`, [id.root]))).toEqual([]);

    // The person releases the parts the rule left, and the page is released whole by its gate.
    await decideAtGate({ actor: actor.org!, partyId: id.org!, items: [{ page_id: id.rootPage!, part: 2 }, { page_id: id.rootPage!, part: 3 }], decision: "release" });
    const whole = (await atA(() => shownPage(id.rootPage!)))!;
    expect(whole.state).toBe("released_whole");
    expect(whole.removals_under_the_policy).toEqual({ "commercial figures": 2 });
    expect(JSON.stringify(whole)).not.toContain(SECRET);
    const record = (await atA(() => shownShowing(id.standing!)))!;
    expect((record.nodes as any[])[0].state).toBe("released_whole");
  });

  it("a page that cannot be shown under the policy is held, in fixed words, and its reason stays at the page's label", async () => {
    await system(async () => {
      await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND sensitivity_label = $2`, [id.root, C]);
      await rawQuery(`INSERT INTO assessments (claim_id, status, confidence, claim_credence, summary, reasoning_trace, is_current, sensitivity_label) VALUES ($1, 'contradicted', 0.9, 0.1, 'Third reading.', 'Third reading.', true, $2)`, [id.root, C]);
    });
    await followShowings();
    const record = (await atA(() => shownShowing(id.standing!)))!;
    const pageId = (record.nodes as any[])[0].versions[0].page_id;
    const said = await tool(pageId, "cannot_cross", { category: "test content", note: `The verdict itself gives away the answer to a test still in use (${SECRET}).` });
    expect(said.success).toBe(true);
    const after = (await atA(() => shownShowing(id.standing!)))!;
    const version = (after.nodes as any[])[0].versions[0];
    expect(version.state).toBe("held");
    expect(version.held_because).toBe("it cannot be shown under this boundary's policy: something that is always shown with a page could not be shown here");
    expect(JSON.stringify(after)).not.toContain("test content");
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect((after.nodes as any[])[0].state).toBe("held");
    const asked = (await atC(() => askedShowings())).find((s) => s.showing_id === id.standing)!;
    expect((asked.pages as any[])[0].cannot_cross.category).toBe("test content");
  });

  it("ends with a dated event and its reason, after which later versions do not follow", async () => {
    await endShowing({ showingId: id.standing!, reason: "no_longer_needed", actor: actor.director! });
    const record = (await atA(() => shownShowing(id.standing!)))!;
    expect(record.ended_because).toBe("it is no longer needed");
    expect((record.acts as any[]).at(-1)).toMatchObject({ what: "ended the showing", reason: "it is no longer needed", holding: ["direct"] });
    await system(() => rawQuery(`INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label) SELECT claim_id, 'supported', 0.5, 'Fourth.', 'Fourth.', false, sensitivity_label FROM assessments WHERE claim_id = $1 LIMIT 1`, [id.root]));
    expect(await followShowings()).toBe(0);
    await expect(endShowing({ showingId: id.standing!, reason: "no_longer_needed", actor: actor.director! })).rejects.toThrow(/already ended/);
    // Nothing more is released from a showing that has ended. What was shown stays shown.
    const late = await decideAtGate({ actor: actor.org!, partyId: id.org!, items: [{ page_id: id.rootPage!, part: 1 }], decision: "release" });
    expect(late.refused[0]!.why).toBe("This page's showing has ended, so nothing more is released from it. What was shown stays shown.");
    expect((await atA(() => shownPage(id.rootPage!)))!.state).toBe("released_whole");
  });
});

describe("the policy of a boundary", () => {
  it("is saved as a new version on both sides, and refuses a category defined by favor or one that names what is always shown", async () => {
    const save = (categories: Array<{ name: string; covers: string; examples: string }>) => savePolicyVersion({ boundary: { from: C, to: A }, categories, savedBy: id.director! });
    const byFavor = await save([{ name: "sensitive findings", covers: "Anything unfavorable to the organization.", examples: "" }]);
    expect(byFavor.ok).toBe(false);
    expect((byFavor as any).message).toContain('worded by how a passage reflects on someone ("unfavorable")');
    const alwaysShown = await save([{ name: "bad verdicts", covers: "A status of contradicted.", examples: "" }]);
    expect(alwaysShown.ok).toBe(false);
    expect((alwaysShown as any).message).toContain('names something that is shown whenever a page is shown ("verdicts")');
    const saved = await save([{ name: "personal data", covers: "Detail about an identifiable person.", examples: "A name." }, { name: "plant layout", covers: "Where machines stand on the floor.", examples: "A floor plan." }]);
    expect(saved.ok).toBe(true);
    expect((saved as any).policy.version).toBe(2);
    const forA = await atA(() => readablePolicies());
    expect(forA.map((p) => [p.version, p.categories.map((c) => c.name)])).toEqual([[2, ["personal data", "plant layout"]]]);
    expect(forA[0]!.body).toContain("### plant layout");
  });
});

describe("two labels that do not read each other", () => {
  it("a page at a is shown to b across a boundary of its own", async () => {
    const asked = await askShowing({ nodeId: id.node!, pageLabel: A, toLabel: B, form: "once", scope: "node", actor: { ...actor.director!, clearance: [A, "public"] } });
    expect(asked.pages_opened).toBe(1);
    const forB = (await atB(() => shownShowing(asked.showing_id)))!;
    expect(forB.shown_to).toBe(`readers at "${B}"`);
    expect((forB.nodes as any[])[0].state).toBe("held");
    expect((await atB(() => readablePolicies())).map((p) => p.side)).toEqual(["destination"]);
    // The first boundary's readers do not see this one's record, since they do not read b.
    expect(await atA(() => shownShowing(asked.showing_id))).toBeNull();
  });
});

describe("a page shown outside the deployment", () => {
  it("goes through the same steps, rests on the parties a shown page it drew on rested on, and waits inside for the next piece", async () => {
    // The page at a, whose version took in the page shown from c.
    const asked = await askShowing({ nodeId: id.node!, pageLabel: A, toLabel: null, form: "once", scope: "node", actor: { ...actor.director!, clearance: [A, "public"] } });
    id.outside = asked.showing_id;
    // Its record is kept where every member reads it, and names no label.
    const record = (await atB(() => shownShowing(asked.showing_id)))!;
    expect(record.shown_to).toBe("outside this deployment");
    const pageId = (record.nodes as any[])[0].versions[0].page_id as string;
    const atPage = async (agent: string, run: () => Promise<string>) => JSON.parse(await runAtLabel(A, "a run at a", () => withAgent(agent, run)));
    expect((await atPage("redactor", () => executeRedactorTool("finish_redaction", { least_sure: [] }, { pageId }))).success).toBe(true);
    expect((await atPage("audit", () => executeAuditTool("record_fidelity_outcome", { page_id: pageId, outcome: "pass", answer: "supports", reasons: "Nothing was removed." }, {}))).success).toBe(true);

    // The version at a rested on the page shown from c, so it takes the releases that page took, and the organization's for its own memos.
    const [needs] = await system(() => rawQuery<{ rests_on: string[] }>(`SELECT rests_on FROM showing_pages WHERE id = $1`, [pageId]));
    expect([...needs!.rests_on].sort()).toEqual([id.org, id.acme, id.borealis].sort());
    for (const [who, party] of [[actor.org!, id.org!], [actor.acme!, id.acme!], [actor.borealis!, id.borealis!]] as const) {
      const queue = (await releaseQueue(who)) as { items: any[] };
      const mine = queue.items.filter((i) => i.page_id === pageId);
      await decideAtGate({ actor: who, partyId: party, items: mine.map((i) => ({ page_id: pageId, part: i.part })), decision: "release" });
    }
    const page = (await atB(() => shownPage(pageId)))!;
    expect(page.state).toBe("released_whole");
    expect(page.verification!.ok).toBe(true);
    // Nothing has left the deployment and nothing arrived anywhere inside it: carrying it out is not built here.
    expect(page.source_id).toBeNull();
    expect(await system(() => rawQuery(`SELECT 1 FROM sources WHERE url LIKE $1`, [`minerval:shown-page/${pageId}/%`]))).toEqual([]);
  });
});

/** Release everything on a page that waits on one party. */
async function releaseAllFor(who: GateActor, party: string, pageId: string, except: number[] = []) {
  const queue = (await releaseQueue(who, { limit: 200 })) as { items: any[] };
  const mine = queue.items.filter((i) => i.page_id === pageId && !except.includes(i.part));
  return decideAtGate({ actor: who, partyId: party, items: mine.map((i) => ({ page_id: pageId, part: i.part })), decision: "release" });
}

describe("a quantity's page and a question's page", () => {
  it("a quantity's page is shown with its estimate, and a supplier's name that cannot be shown is held where the reader sees it", async () => {
    const quantity = await seedNode(C, "Units the plant made in the third quarter", "quantity");
    const meter = await attachSource(quantity, C, "The meter export for the quarter.");
    await system(async () => {
      await rawQuery(`UPDATE sources SET party_id = $2 WHERE id = $1`, [meter.source, id.acme]);
      await rawQuery(`INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, sensitivity_label) VALUES ($1, $2, 'Acme', 'Acme is paid by output.', 'steward', $3)`, [meter.source, quantity, C]);
      await rawQuery(
        `INSERT INTO quantity_estimates (claim_id, estimate, summary, work, model, is_current, sensitivity_label)
         VALUES ($1, $2::jsonb, 'About thirteen thousand units.', $3, 'a-model', true, $4)`,
        [quantity, JSON.stringify({ central: 13200, low: 12800, high: 13600, unit: "units" }), "Three monthly meter totals were added.\n\nThe September total was corrected for a stoppage.", C]
      );
    });
    const asked = await askShowing({ nodeId: quantity, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: actor.director! });
    const pageId = ((await atA(() => shownShowing(asked.showing_id)))!.nodes as any[])[0].versions[0].page_id as string;
    const page = await tool(pageId, "get_page_to_redact");
    expect(page.parts.map((p: any) => p.kind)).toEqual(["wording", "summary", "reasoning", "reasoning", "reading", "supplier"]);
    expect(page.always_shown.node_kind).toBe("quantity");
    expect(page.always_shown.verdict).toEqual({ estimate: { central: 13200, low: 12800, high: 13600, unit: "units" } });
    expect(page.always_shown.sources).toEqual([{ source: 1, kind: "unknown", fingerprint: null, supplied_by: "an_outside_party", interest_recorded: true }]);
    await throughTheCheck(pageId, { answer: "supports" });

    // A holder of release who reads neither the page's label nor the node is shown the node's wording as the page would show it.
    const outside = (await releaseQueue({ ...actor.acme!, clearance: ["public"] })) as { items: any[] };
    const ofPage = outside.items.filter((i) => i.page_id === pageId);
    expect(ofPage.length).toBeGreaterThan(0);
    expect(ofPage.every((i) => i.node === undefined && i.wording_as_it_would_be_shown === page.parts[0].text)).toBe(true);

    // Acme releases everything of its own but its name and the words of its interest.
    await decideAtGate({ actor: actor.acme!, partyId: id.acme!, items: [{ page_id: pageId, part: 6 }], decision: "hold", reason: "confidentiality" });
    await releaseAllFor(actor.acme!, id.acme!, pageId, [6]);
    const shown = (await atA(() => shownPage(pageId)))!;
    expect(shown.state).toBe("released_in_part");
    expect(shown.held_kinds).toBe("a source's supplier and recorded interest, by name");
    const parts = shown.parts as any[];
    expect(parts[5].held).toMatch(/^\[A source's supplier and recorded interest, by name, held by Acme \d+\]$/);
    expect(parts[3].text).toBe("The September total was corrected for a stoppage.");
    expect((shown.always_shown as any).sources[0]).toMatchObject({ supplied_by: "an_outside_party", interest_recorded: true });
    expect(shown.verification!.ok).toBe(true);
    const [source] = await atA(() => rawQuery<{ raw_content: string }>(`SELECT raw_content FROM sources WHERE id = $1`, [shown.source_id]));
    expect(source!.raw_content).toContain('Estimate: {"low":12800,"high":13600,"unit":"units","central":13200}.');
    expect(source!.raw_content).toContain("source 1: unknown, supplied by an outside party, an interest in this node is recorded for it");
    expect(source!.raw_content).not.toContain("paid by output");
  });

  it("a question's page is shown with its standing, what it says remains open, and the request it records", async () => {
    const question = await seedNode(C, "Why did the third line stop in September?", "question");
    await system(async () => {
      await rawQuery(
        `INSERT INTO question_assessments (claim_id, standing, favored_claim_ids, summary, reasoning_trace, incomplete, confidence, model, is_current, sensitivity_label)
         VALUES ($1, 'leaning', ARRAY[$2]::uuid[], 'Most likely a gearbox fault.', 'The maintenance log points to the gearbox.', 'Whether the fault was reported before the stoppage is not known.', 0.6, 'a-model', true, $3)`,
        [question, id.child, C]
      );
      await rawQuery(
        `INSERT INTO requests (ask, why, satisfied_by, filer_kind, filer_agent, keeper_kind, keeper_claim_id, addressed_to, sensitivity_label)
         VALUES ('The fault reports for August.', 'They would settle whether the fault was known.', 'The reports, dated.', 'admin', 'question_steward', 'steward', $1, 'The maintenance team', $2)`,
        [question, C]
      );
    });
    const asked = await askShowing({ nodeId: question, pageLabel: C, toLabel: A, form: "once", scope: "node", actor: actor.director! });
    const pageId = ((await atA(() => shownShowing(asked.showing_id)))!.nodes as any[])[0].versions[0].page_id as string;
    const page = await tool(pageId, "get_page_to_redact");
    expect(page.parts.map((p: any) => p.kind)).toEqual(["wording", "summary", "reasoning", "gap", "gap"]);
    expect(page.parts[3].text).toBe("Whether the fault was reported before the stoppage is not known.");
    expect(page.parts[4].text).toBe("Request (open)\n\nAsks for: The fault reports for August.\n\nWhy: They would settle whether the fault was known.\n\nWhat would satisfy it: The reports, dated.");
    expect(page.always_shown.verdict).toEqual({ standing: "leaning", confidence: 0.6, favored_answers: [id.child] });
    expect(page.always_shown.gaps.names_what_remains_open).toBe(true);
    expect(page.always_shown.gaps.requests).toHaveLength(1);
    expect(page.always_shown.gaps.requests[0]).toMatchObject({ state: "open", addressed_to_someone: true });
    expect(JSON.stringify(page.always_shown)).not.toContain("maintenance team");
    await throughTheCheck(pageId, { answer: "supports" });
    await releaseAllFor(actor.org!, id.org!, pageId);
    const shown = (await atA(() => shownPage(pageId)))!;
    expect(shown.state).toBe("released_whole");
    expect(shown.verification).toEqual({ ok: true, problems: [], checked: 6, held: 0 });
    const [source] = await atA(() => rawQuery<{ raw_content: string }>(`SELECT raw_content FROM sources WHERE id = $1`, [shown.source_id]));
    expect(source!.raw_content).toContain("Standing: leaning. Confidence: 0.6.");
    expect(source!.raw_content).toContain("Gaps it records: 1 request (open); it says what remains open.");
  });
});

describe("a mirrored node's page shown to the public label", () => {
  it("arrives as a source of this deployment's own beside the public graph's rows, and opens no pass at the public label", async () => {
    // A node of the public graph, as the mirror's applier writes one, with a version at c beside it.
    const mirrored = await system(() =>
      withTransaction(async (tx) => {
        await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
        const [claim] = await tx.query<{ id: string }>(
          `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label, origin)
           VALUES ($1, 'claim', 'done', 'complete', now(), 'public', 'mirror') RETURNING id`,
          [`A claim of the public graph, mirrored here (${Date.now()})`]
        );
        await tx.query(
          `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label, origin)
           VALUES ($1, 'inconclusive', 0.5, 'The public graph has it open.', 'The public graph has it open.', true, 'public', 'mirror')`,
          [claim!.id]
        );
        return claim!.id;
      })
    );
    id.mirrored = mirrored;
    noteMirrorApplied();
    try {
      await attachSource(mirrored, C, "A record held at c that settles it.");
      await system(() =>
        rawQuery(
          `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label)
           VALUES ($1, 'verified', 0.9, 'The record at c settles it.', 'The record at c settles it.', true, $2)`,
          [mirrored, C]
        )
      );
      const asked = await askShowing({ nodeId: mirrored, pageLabel: C, toLabel: "public", form: "once", scope: "node", actor: actor.director! });
      id.toPublic = asked.showing_id;
      const forEveryone = (await asPerson(["public"], () => shownShowing(asked.showing_id)))!;
      expect(forEveryone.shown_to).toBe('readers at "public"');
      const pageId = (forEveryone.nodes as any[])[0].versions[0].page_id as string;
      await throughTheCheck(pageId, { answer: "supports" });
      await releaseAllFor(actor.org!, id.org!, pageId);
      const shown = (await asPerson(["public"], () => shownPage(pageId)))!;
      expect(shown.state).toBe("released_whole");
      expect((shown.always_shown as any).coverage).toEqual({ examined: true, on: ["evidence_this_reader_cannot_read"] });

      // The source and its instance are this deployment's own rows at `public`; the mirrored rows are as they were.
      const [arrived] = await system(() => rawQuery<{ origin: string; sensitivity_label: string; attached: number }>(
        `SELECT s.origin, s.sensitivity_label, (SELECT count(*)::int FROM claim_instances i WHERE i.source_id = s.id AND i.claim_id = $2 AND i.origin = 'local') AS attached
           FROM sources s WHERE s.id = $1`, [shown.source_id, mirrored]));
      expect(arrived).toEqual({ origin: "local", sensitivity_label: "public", attached: 1 });
      const [publicVersion] = await system(() => rawQuery<{ status: string; origin: string }>(`SELECT status, origin FROM assessments WHERE claim_id = $1 AND sensitivity_label = 'public' AND is_current`, [mirrored]));
      expect(publicVersion).toEqual({ status: "inconclusive", origin: "mirror" });
      // The judgment of a mirrored node at `public` is the public graph's: no pass is queued, no message kept, no ledger row opened here.
      expect(await system(() => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1`, [mirrored]))).toEqual([]);
      expect(await system(() => rawQuery(`SELECT 1 FROM actions WHERE claim_id = $1 AND kind IN ('assess', 'reassess')`, [mirrored]))).toEqual([]);
      const [node] = await system(() => rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [mirrored]));
      expect(node!.steward_state).toBe("done");
    } finally {
      resetMirrorHeldForTests();
    }
  });
});
