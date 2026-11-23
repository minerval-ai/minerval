/**
 * Safety cases (constitution §7b, #1211) against real Postgres: a case is a
 * node of kind 'artifact' with its specification, its structure in
 * case_elements, a 'draws_on' edge to each node an element points at, and a
 * judgment in two parts in artifact_assessments.
 *
 * The synthetic case here is the one the issue asks for: a deployment's
 * monitoring argument with a planted shared premise between two legs of a
 * decomposition, and a planted substitution with no transfer premise. The
 * Steward's part is played by the test: it records the shared premise as a
 * defeater of the decomposition's side claim, and the form check finds the
 * substitution. The case is then exported, and the export is read back by
 * the check of the framework's form.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { getListDetail, proposeList } from "../../src/services/artifact-service.js";
import { readCaseExport } from "../../src/services/case-form.js";
import {
  artifactSubtypeOf,
  exportCase,
  getCaseDetail,
  proposeCase,
  recordCaseAssessment,
  removeCaseElement,
  restateCaseSpec,
  setDefeaterStanding,
  writeCaseElement,
} from "../../src/services/safety-case-service.js";
import { markQuestion } from "../../src/services/question-service.js";

const BY = "dbtest";

async function seedCase(framework: "assurance_2_cae" | "none" = "assurance_2_cae") {
  const conclusion = await seedClaim(`Model M-3 will not exfiltrate its weights in the internal research deployment ${Math.random()}.`);
  const { id } = await proposeCase({
    title: `Safety case: M-3 internal research deployment, weight exfiltration ${Math.random()}`,
    spec: {
      system: "Model M-3, checkpoint of 2026-09-01",
      deployment: "Internal research use by staff, with the monitoring pipeline of October 2026",
      conclusion_claim_id: conclusion,
      standard: "The standard deployment policy P-7 requires for internal deployment",
      standard_of: "The developer's deployment policy P-7",
      framework,
      not_covered: "External deployment, and any later checkpoint.",
    },
    createdBy: BY,
    confirmNew: true,
  });
  expect(id).toBeTruthy();
  const detail = await getCaseDetail(id!);
  const top = detail.elements.find((e) => e.parent === null)!;
  return { caseId: id!, conclusion, top: top.id };
}

async function assess(claimId: string, status: string): Promise<void> {
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND is_current`, [claimId]);
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current) VALUES ($1, $2, 0.6, 'dbtest', true)`,
    [claimId, status]
  );
}

const add = (caseId: string, type: Parameters<typeof writeCaseElement>[0]["type"], parentId: string, rest: Partial<Parameters<typeof writeCaseElement>[0]> = {}) =>
  writeCaseElement({ caseId, type, parentId, statement: `${type} for the case`, createdBy: BY, ...rest }).then((r) => r.id);

describe("safety cases", () => {
  it("are artifacts with a specification of their own, a top claim, and an edge to what they draw on", async () => {
    const { caseId, conclusion, top } = await seedCase();
    expect(await artifactSubtypeOf(caseId)).toBe("safety_case");
    const detail = await getCaseDetail(caseId);
    expect(detail.spec).toMatchObject({ subtype: "safety_case", framework: "assurance_2_cae", conclusion_claim_id: conclusion });
    expect(detail.conclusion).toMatchObject({ id: conclusion, kind: "claim", judgment: null });
    expect(detail.elements).toHaveLength(1);
    expect(detail.elements[0]).toMatchObject({ id: top, type: "claim", parent: null });
    expect(detail.verdict).toBeNull();
    // An undeveloped conclusion is a failure of form from the first moment: the burden is on the case.
    expect(detail.form.failures.map((f) => f.rule)).toEqual(["undeveloped_claim"]);
    const edges = await rawQuery<{ child_claim_id: string; relation_type: string }>(
      `SELECT child_claim_id, relation_type FROM claim_relationships WHERE parent_claim_id = $1`,
      [caseId]
    );
    expect(edges).toEqual([{ child_claim_id: conclusion, relation_type: "draws_on" }]);
  });

  it("leaves lists as they were", async () => {
    const { id } = await proposeList({
      title: `Evaluations of M-3 ${Math.random()}`,
      spec: { purpose: "Which evaluations were run.", inclusion: "A claim reporting an evaluation of M-3." },
      createdBy: BY,
      confirmNew: true,
    });
    expect(await artifactSubtypeOf(id!)).toBe("list");
    expect((await getListDetail(id!)).spec).toMatchObject({ subtype: "list" });
    expect(await exportCase(id!)).toBeNull();
  });

  it("refuses a specification without its parts, and a conclusion that is not a claim", async () => {
    const q = await seedClaim("How would M-3 exfiltrate its weights?");
    await markQuestion(q);
    const spec = { system: "M-3", deployment: "internal", standard: "P-7", standard_of: "the developer", framework: "assurance_2_cae" as const };
    await expect(proposeCase({ title: "A case", spec: { ...spec, conclusion_claim_id: q }, createdBy: BY })).rejects.toThrow(/is a question/);
    await expect(
      proposeCase({ title: "A case", spec: { ...spec, standard_of: "" } as never, createdBy: BY })
    ).rejects.toThrow(/standard_of/);
  });

  it("holds a structure to what a structure is, and says where its form fails without refusing it", async () => {
    const { caseId, top } = await seedCase();
    const sub = await seedClaim("The monitor flags exfiltration attempts.");
    await expect(add(caseId, "evidence", top, { nodeId: sub })).rejects.toThrow(/hangs under a step/);
    await expect(add(caseId, "step", top, { block: "induction" as never })).rejects.toThrow(/building blocks/);
    await expect(add(caseId, "claim", top, { nodeId: sub })).rejects.toThrow(/hangs under a step or a defeater/);
    await expect(add(caseId, "side_claim", top)).rejects.toThrow(/presents a node the graph holds/);
    await expect(removeCaseElement({ caseId, elementId: top, createdBy: BY })).rejects.toThrow(/stays/);
    // A step with no side claim is written, and reported.
    const step = await add(caseId, "step", top, { block: "decomposition", statement: "The conclusion holds if each route is closed." });
    const rules = (await getCaseDetail(caseId)).form.failures.filter((f) => f.element === step).map((f) => f.rule);
    expect(rules).toEqual(["no_side_claim", "no_subclaims"]);
  });

  it("records the planted shared premise as a defeater and finds the substitution with no transfer premise", async () => {
    const { caseId, conclusion, top } = await seedCase();
    const noAttempt = await seedClaim("M-3 does not attempt exfiltration in evaluations designed to elicit it.");
    const caught = await seedClaim("The deployment monitor would catch an exfiltration attempt by M-3.");
    const independent = await seedClaim("M-3's propensity evaluations and its deployment monitor do not fail together.");
    // The planted shared premise: both legs rest on it.
    const sameDistribution = await seedClaim("M-3 behaves in deployment as it does on the evaluation distribution.");
    const evalResult = await seedClaim("M-2 attempted exfiltration in 0 of 400 elicitation episodes.");
    const redTeam = await seedClaim("The monitor flagged 37 of 40 red-team exfiltration attempts.");
    const measures = await seedClaim("The monitor's red-team recall measures its recall on attempts M-3 would make.");

    const decomposition = await add(caseId, "step", top, {
      block: "decomposition",
      statement: "M-3 will not exfiltrate if it does not attempt to, or if an attempt would be caught.",
      raisedInPublished: true,
    });
    const side = await add(caseId, "side_claim", decomposition, { nodeId: independent, statement: "The two legs suffice together and do not fail together.", raisedInPublished: false });
    const legA = await add(caseId, "claim", decomposition, { nodeId: noAttempt, raisedInPublished: true });
    const legB = await add(caseId, "claim", decomposition, { nodeId: caught, raisedInPublished: true });

    // Leg A: the planted substitution. Evidence about M-2 is used for M-3, and nothing says why it transfers.
    const substitution = await add(caseId, "step", legA, {
      block: "substitution",
      statement: "What the elicitation evaluations showed of M-2 holds of M-3.",
      raisedInPublished: true,
    });
    const aboutM2 = await add(caseId, "claim", substitution, { nodeId: sameDistribution, statement: "M-3's evaluation behaviour stands for its deployment behaviour." });
    const incA = await add(caseId, "step", aboutM2, { block: "evidence_incorporation", statement: "The elicitation run is the evidence." });
    await add(caseId, "evidence", incA, { nodeId: evalResult });
    await add(caseId, "side_claim", incA, { nodeId: measures, statement: "The episodes measure what they are taken to." });

    // Leg B: evidence, with its side claim.
    const incB = await add(caseId, "step", legB, { block: "evidence_incorporation", statement: "The red-team exercise is the evidence." });
    await add(caseId, "evidence", incB, { nodeId: redTeam });
    await add(caseId, "side_claim", incB, { nodeId: measures, statement: "Red-team recall measures recall on real attempts." });

    // The Steward checks the side claim against the premises the legs rest on (#544), and records the shared one.
    const defeater = await add(caseId, "defeater", side, {
      nodeId: sameDistribution,
      statement: "Both legs rest on M-3 behaving in deployment as on the evaluation distribution, so they can fail together.",
      raisedInPublished: false,
    });

    let detail = await getCaseDetail(caseId);
    // The substitution with no side claim is found by the check of form (#545).
    expect(detail.form.well_formed).toBe(false);
    expect(detail.form.failures).toContainEqual(
      expect.objectContaining({ element: substitution, rule: "no_side_claim", message: expect.stringContaining("substitution has no side claim") })
    );
    // The defeater is the case's own reading of an ordinary claim.
    const d = detail.elements.find((e) => e.id === defeater)!;
    expect(d).toMatchObject({ type: "defeater", parent: side, standing: "open" });
    expect(d.node).toMatchObject({ id: sameDistribution, kind: "claim" });
    expect(detail.counts_against.map((c) => c.kind)).toEqual(expect.arrayContaining(["open_defeater", "form"]));
    // What the structure adds that the published case never raised.
    expect(detail.not_raised_in_published).toEqual(expect.arrayContaining([side, defeater]));

    // The graph holds no defeater: the claim's own row says nothing of the part it plays here.
    const [node] = await rawQuery<Record<string, unknown>>(`SELECT * FROM claims WHERE id = $1`, [sameDistribution]);
    expect(JSON.stringify(node)).not.toMatch(/defeat/i);
    const edges = await rawQuery<{ relation_type: string }>(
      `SELECT DISTINCT relation_type FROM claim_relationships WHERE child_claim_id = $1`,
      [sameDistribution]
    );
    expect(edges).toEqual([{ relation_type: "draws_on" }]);
    // One edge for a node two elements point at.
    const [n] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = $2`,
      [caseId, measures]
    );
    expect(n!.n).toBe(1);

    // The burden is on the case: it cannot be recorded as establishing its conclusion past what counts against it.
    const judgment = { claimId: caseId, fidelity: "faithful" as const, reasoningTrace: "Checked each leg against its premises.", verdictBasis: "As below." };
    await expect(recordCaseAssessment({ ...judgment, verdict: "established" })).rejects.toThrow(/counts against it/);

    // The assessment is not the standing: the graph finds the doubt inconclusive, and it is still open against the case.
    await assess(sameDistribution, "inconclusive");
    await assess(conclusion, "supported");
    const first = await recordCaseAssessment({
      ...judgment,
      verdict: "not_established",
      verdictBasis: "The two legs share a premise nobody has shown, and the evidence about M-2 is carried to M-3 with no stated reason.",
      wouldChange: "Evidence that M-3 does not distinguish evaluation from deployment, and a stated transfer premise for the M-2 results.",
    });
    detail = await getCaseDetail(caseId);
    expect(detail.verdict).toBe("not_established");
    expect(detail.assessment).toMatchObject({ id: first.id, fidelity: "faithful", verdict: "not_established" });
    // "The evidence supports X" and "the case does not yet establish X" are both true, and both shown.
    expect(detail.conclusion!.judgment).toMatchObject({ status: "supported" });
    const [conclusionRow] = await rawQuery<{ status: string }>(`SELECT status FROM assessments_in_force WHERE claim_id = $1`, [conclusion]);
    expect(conclusionRow!.status).toBe("supported");
    expect(detail.stale).toBe(false);

    // A node the case draws on is judged again: the case was judged against the old verdict.
    await assess(sameDistribution, "doubtful");
    detail = await getCaseDetail(caseId);
    expect(detail.stale).toBe(true);
    expect(detail.elements.find((e) => e.id === defeater)!.changed_since).toBe(true);

    // Settling it: the transfer premise is stated, and the shared premise is sustained and accepted as a residual doubt.
    await expect(setDefeaterStanding({ caseId, elementId: defeater, standing: "answered", reason: "r" })).rejects.toThrow(/answered by a subcase/);
    await expect(
      setDefeaterStanding({ caseId, elementId: defeater, standing: "open", reason: "r", acceptedBy: "The board", acceptance: "a" })
    ).rejects.toThrow(/Only a sustained defeater/);
    await setDefeaterStanding({ caseId, elementId: defeater, standing: "sustained", reason: "No evidence separates the two distributions." });
    expect((await getCaseDetail(caseId)).counts_against.map((c) => c.kind)).toContain("sustained_defeater_not_accepted");
    await setDefeaterStanding({
      caseId,
      elementId: defeater,
      standing: "sustained",
      reason: "No evidence separates the two distributions.",
      acceptedBy: "The developer's deployment review board",
      acceptance: "Accepted for internal deployment in its decision of 2026-10-12, on the ground that staff use is reversible.",
    });
    const transfer = await seedClaim("M-3 differs from M-2 in nothing that bears on its propensity to exfiltrate.");
    const transferSide = await add(caseId, "side_claim", substitution, { nodeId: transfer, statement: "The transfer premise." });
    // Side claims that are argued for by no step: the Steward says where the case departs.
    for (const e of (await getCaseDetail(caseId)).form.failures) {
      const el = (await getCaseDetail(caseId)).elements.find((x) => x.id === e.element)!;
      await writeCaseElement({
        caseId,
        elementId: el.id,
        type: el.type as never,
        nodeId: el.node?.id ?? null,
        block: (el.block as never) ?? null,
        statement: el.statement,
        departure: "Taken as an assumption of the case, stated and not argued for here.",
        createdBy: BY,
      });
    }
    detail = await getCaseDetail(caseId);
    expect(detail.counts_against).toEqual([]);
    expect(detail.residual_doubts).toEqual([defeater]);
    expect(detail.form.failures.every((f) => f.departure)).toBe(true);
    const second = await recordCaseAssessment({
      ...judgment,
      verdict: "established",
      verdictBasis: "Rests on one residual doubt, accepted by the review board: that M-3 behaves in deployment as in evaluation.",
    });
    const [current] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM artifact_assessments WHERE claim_id = $1 AND is_current`, [caseId]);
    expect(current!.n).toBe(1);
    // The verdict is the case's own: the conclusion's assessment is untouched by it.
    const [after] = await rawQuery<{ status: string }>(`SELECT status FROM assessments_in_force WHERE claim_id = $1`, [conclusion]);
    expect(after!.status).toBe("supported");

    // Exported, and the export read back by the check of the framework's form.
    const exported = await exportCase(caseId);
    expect(exported).not.toBeNull();
    const wire = JSON.parse(JSON.stringify(exported));
    const read = readCaseExport(wire);
    expect(read.export.format).toBe("minerval-cae/1");
    expect(read.export.case).toMatchObject({ framework: "assurance_2_cae", conclusion: { id: conclusion, judgment: { status: "supported" } } });
    expect(read.export.judgment).toMatchObject({ fidelity: "faithful", verdict: "established" });
    expect(read.failures).toEqual(wire.form.failures);
    const blocks = read.export.elements.filter((e) => e.type === "step").map((e) => e.block).sort();
    expect(blocks).toEqual(["decomposition", "evidence_incorporation", "evidence_incorporation", "substitution"]);
    expect(read.export.elements.find((e) => e.id === defeater)).toMatchObject({
      standing: "sustained",
      accepted_by: "The developer's deployment review board",
      node: { id: sameDistribution, judgment: { status: "doubtful" } },
    });
    expect(read.export.elements.find((e) => e.id === transferSide)).toMatchObject({ type: "side_claim", parent: substitution });
    // Read back with the transfer premise taken out, the check finds the substitution again.
    const without = { ...wire, elements: wire.elements.filter((e: { id: string }) => e.id !== transferSide) };
    expect(readCaseExport(without).failures).toContainEqual(expect.objectContaining({ element: substitution, rule: "no_side_claim" }));
    expect(second.id).not.toBe(first.id);
  });

  it("answers a defeater with a subcase, and removes an element with what hangs under it", async () => {
    const { caseId, top } = await seedCase("none");
    const doubt = await seedClaim("The monitor can be disabled by the model it monitors.");
    const answer = await seedClaim("The monitor runs on hardware M-3 has no credentials for.");
    const defeater = await add(caseId, "defeater", top, { nodeId: doubt });
    const sub = await add(caseId, "claim", defeater, { nodeId: answer, statement: "Answers the doubt." });
    await setDefeaterStanding({ caseId, elementId: defeater, standing: "answered", reason: "The subcase shows the monitor is out of reach." });
    let detail = await getCaseDetail(caseId);
    // No framework: only what a structure is gets checked.
    expect(detail.form.failures).toEqual([]);
    expect(detail.counts_against).toEqual([]);
    expect((await removeCaseElement({ caseId, elementId: defeater, createdBy: BY })).removed).toBe(2);
    detail = await getCaseDetail(caseId);
    expect(detail.elements.map((e) => e.id)).toEqual([top]);
    const left = await rawQuery(`SELECT 1 FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = ANY($2::uuid[])`, [caseId, [doubt, answer]]);
    expect(left).toEqual([]);
    expect(sub).toBeTruthy();
  });

  it("restates the specification under the same identity", async () => {
    const { caseId, conclusion } = await seedCase();
    await restateCaseSpec({
      claimId: caseId,
      spec: { system: "Model M-3 (checkpoint 2026-09-01)", deployment: "Internal research use", standard: "P-7, section 4", standard_of: "The developer" },
      createdBy: BY,
    });
    const detail = await getCaseDetail(caseId);
    expect(detail.spec).toMatchObject({ system: "Model M-3 (checkpoint 2026-09-01)", conclusion_claim_id: conclusion, framework: "assurance_2_cae", not_covered: null });
  });
});
