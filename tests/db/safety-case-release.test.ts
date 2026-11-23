/**
 * A private safety case released through a gate (constitution §7b, §31,
 * #1211), against real Postgres with more than one label.
 *
 * The case is written at finance: its node, its specification, its
 * structure and its judgment. A reader at company does not read that
 * label, so the case's page and its export are not served to them. What
 * reaches them is the page released through the gate between the two
 * labels: the case's verdict in what is always shown, and its structure as
 * parts, each element one part.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { setGateMode, type GateAuthority } from "../../src/services/gate-settings-service.js";
import { ensureBoundaryPolicy } from "../../src/services/redaction-policy.js";
import { receivedPage, type GateActor } from "../../src/services/release-gate-service.js";
import { askRelease } from "../../src/services/release-service.js";
import {
  exportCase,
  getCaseDetail,
  proposeCase,
  recordCaseAssessment,
  setDefeaterStanding,
  writeCaseElement,
} from "../../src/services/safety-case-service.js";
import { A, C, asPerson, seedNode, seedUser, stewardAt, system, unwall, wall } from "./review-3-common.js";

const COMPANY = A;
const FINANCE = C;
const id: Record<string, string> = {};
let admin: GateAuthority;
let director: GateActor;

const atCompany = <T>(fn: () => Promise<T>) => asPerson([COMPANY, "public"], fn);
const atFinance = <T>(fn: () => Promise<T>) => asPerson([FINANCE, COMPANY, "public"], fn);

beforeAll(async () => {
  await wall();
  await system(async () => {
    const [existing] = await rawQuery<{ id: string }>(`SELECT id FROM parties WHERE is_own_organization`);
    id.org = existing?.id ?? (await rawQuery<{ id: string }>(`INSERT INTO parties (name, is_own_organization) VALUES ('The organization', true) RETURNING id`))[0]!.id;
    if (!existing) id.orgMadeHere = "yes";
  });
  admin = { id: await seedUser(), holding: ["administer"], administer: true, consentParties: [] };
  director = { id: await seedUser(), holding: ["direct"], clearance: [FINANCE, COMPANY, "public"], consentParties: [], direct: true };

  // The conclusion and the nodes the case draws on, at finance; the case is its Steward's work there.
  id.conclusion = await seedNode(FINANCE, "The ledger service will not release funds without two approvals in the March deployment");
  id.control = await seedNode(FINANCE, "Every release path in the ledger service checks for two approvals");
  id.review = await seedNode(FINANCE, "The code review of the release paths covered all of them");
  id.bypass = await seedNode(FINANCE, "The batch settlement job releases funds without the approval check");
  await stewardAt(FINANCE, async () => {
    const { id: caseId } = await proposeCase({
      title: "Safety case: the ledger service, March deployment, dual approval",
      spec: {
        system: "The ledger service, release 4.2",
        deployment: "The March production deployment",
        conclusion_claim_id: id.conclusion!,
        standard: "The standard the payments policy requires for production",
        standard_of: "The organization's payments policy",
        framework: "assurance_2_cae",
      },
      createdBy: "dbtest",
      confirmNew: true,
    });
    id.case = caseId!;
    const top = (await getCaseDetail(id.case)).elements[0]!.id;
    const add = (type: Parameters<typeof writeCaseElement>[0]["type"], parentId: string, rest: Partial<Parameters<typeof writeCaseElement>[0]>) =>
      writeCaseElement({ caseId: id.case!, type, parentId, statement: "s", createdBy: "dbtest", ...rest }).then((r) => r.id);
    const step = await add("step", top, { block: "concretion", statement: "No release without two approvals means every release path checks for them." });
    await add("claim", step, { nodeId: id.control!, statement: "The concrete form of the conclusion." });
    id.side = await add("side_claim", step, { nodeId: id.review!, statement: "The paths reviewed are all the paths there are." });
    id.defeater = await add("defeater", id.side, { nodeId: id.bypass!, statement: "A path the review did not cover would release funds unchecked." });
    await setDefeaterStanding({ caseId: id.case!, elementId: id.defeater, standing: "sustained", reason: "The batch job was outside the review's scope." });
    await recordCaseAssessment({
      claimId: id.case!,
      fidelity: "faithful",
      verdict: "not_established",
      verdictBasis: "One release path was never reviewed, and nobody has accepted that doubt.",
      wouldChange: "A review of the batch settlement job.",
      summary: "The case covers the interactive release paths and not the batch job.",
      reasoningTrace: "Each path named in the design was checked against the review's record.",
    });
  });
}, 180_000);

afterAll(async () => {
  await unwall([id.case!].filter(Boolean));
  if (id.orgMadeHere) await system(() => rawQuery(`DELETE FROM parties WHERE id = $1`, [id.org])).catch(() => undefined);
}, 180_000);

describe("a safety case written at a private label", () => {
  it("is read, and exported, only by readers of its label", async () => {
    const whole = await atFinance(() => exportCase(id.case!));
    expect(whole).not.toBeNull();
    expect(whole!.judgment).toMatchObject({ verdict: "not_established" });
    expect(whole!.elements).toHaveLength(5);
    // A reader who does not read finance is served nothing by the export: what reaches them goes through the gate.
    expect(await atCompany(() => exportCase(id.case!))).toBeNull();
    expect((await atCompany(() => getCaseDetail(id.case!))).elements).toEqual([]);
  });

  it("is released through the gate as its page: the verdict always shown, the structure as parts", async () => {
    const policy = await ensureBoundaryPolicy({ from: FINANCE, to: COMPANY });
    await setGateMode({ boundaryId: policy.boundary_id, kind: "page", scope: "under", scopeRef: id.case!, mode: "open", actor: admin });
    const asked = await askRelease({ nodeId: id.case!, pageLabel: FINANCE, toLabel: COMPANY, form: "once", scope: "node", actor: director });
    const [item] = await system(() =>
      rawQuery<{ id: string; judgment_kind: string }>(`SELECT id, judgment_kind FROM release_pages WHERE release_id = $1`, [asked.release_id])
    );
    expect(item!.judgment_kind).toBe("artifact_assessment");
    const page = (await atCompany(() => receivedPage(item!.id)))! as Record<string, any>;
    expect(page.state).toBe("released_whole");
    expect(page.verification).toMatchObject({ ok: true });
    // The case's judgment, in what is always shown: its fidelity, and whether it establishes its conclusion.
    expect(page.always_released.node_kind).toBe("artifact");
    expect(page.always_released.verdict).toMatchObject({ fidelity: "faithful", case_verdict: "not_established" });
    const texts = (page.parts as Array<{ text: string; descriptor: string }>).map((p) => p.text);
    const elements = (page.parts as Array<{ text: string; descriptor: string }>).filter((p) => p.descriptor === "case_element").map((p) => p.text);
    expect(elements).toHaveLength(5);
    expect(elements[0]).toMatch(/^Case element 1 \(claim; the case's top claim\)/);
    expect(elements.some((t) => /\(step: concretion; under element 1\)/.test(t))).toBe(true);
    const defeater = elements.find((t) => /\(defeater; under element/.test(t))!;
    expect(defeater).toContain("The batch settlement job releases funds without the approval check");
    expect(defeater).toContain("Standing in the case: sustained. The batch job was outside the review's scope.");
    expect(texts).toContain("One release path was never reviewed, and nobody has accepted that doubt.");
    expect(texts).toContain("A review of the batch settlement job.");
    // The edges that carry propagation to the case do not say its nodes a second time.
    expect(texts.filter((t) => /^(Entry|Subclaim)/.test(t))).toEqual([]);
  });
});
