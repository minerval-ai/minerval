/**
 * The claim exports at a label that set structure aside (docs/mira.md and
 * docs/scasp.md, "At a label"; src/services/overlay-service.ts), against a
 * real database with its wall up.
 *
 * The labels: `ex-co` reads `public`, and `ex-fin` and `ex-legal` each read
 * `ex-co` and not each other. The company decomposes a claim; finance sets
 * one of its edges and one of its arguments aside. Then:
 *
 *  - the nanopublication at finance leaves the edge out of its assertion and
 *    records the edge and the argument in its provenance, marked;
 *  - the MIRA export at finance keeps both on their mv: nodes, marked, and
 *    lends them none of MIRA's own relations;
 *  - the s(CASP) program at finance encodes neither;
 *  - every export at the company and at legal is, to the byte, what it was.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/services/embedding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/embedding-service.js")>()),
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this test");
  }),
}));

import { rawQuery, withTransaction } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { runAtLabel, withAgent } from "../../src/llm/usage-context.js";
import { addArgument, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { assembleEvidenceRecord, citationUrl } from "../../src/services/citation-service.js";
import { assembleClaimMira, type JsonLdNode, type MiraDocument } from "../../src/services/mira-service.js";
import { assembleClaimNanopub } from "../../src/services/nanopub-service.js";
import { markQuestion } from "../../src/services/question-service.js";
import { attachEdgeToArgument, insertRelationshipEdge } from "../../src/services/relationship-service.js";
import { assembleClaimScasp, claimAtom } from "../../src/services/scasp-service.js";
import { validateMira } from "../mira-shacl.js";

const CO = "ex-co";
const FIN = "ex-fin";
const LEGAL = "ex-legal";
const LABELS = [CO, FIN, LEGAL];
const tag = randomUUID().slice(0, 8);
const seeded: string[] = [];
const WHEN = new Date("2026-11-01T00:00:00.000Z");

const system = <T>(fn: () => Promise<T>) => withSystemClearance("The export test seeds and checks rows at every label.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "the export test", fn);

async function call(label: string, name: string, input: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
  const raw = await runAtLabel(label, "the export test's run", () => withAgent("steward", () => executeStewardTool(name, input)));
  return JSON.parse(raw) as { success: boolean; message: string };
}

async function seedNode(label: string, text: string, kind = "claim"): Promise<string> {
  const [row] = await system(() =>
    rawQuery<{ id: string }>(
      `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label)
       VALUES ($1, $2, 'done', 'complete', now(), $3) RETURNING id`,
      [`${text} (${tag} ${randomUUID().slice(0, 6)})`, kind, label]
    )
  );
  seeded.push(row!.id);
  return row!.id;
}

const edge = (parentId: string, childId: string, relationType: string) =>
  at(CO, () => insertRelationshipEdge({ parentId, childId, relationType, reasoning: "The company's reading.", createdBy: "claim_steward" }));

const assess = (node: string, status: string) =>
  system(() =>
    rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label)
       VALUES ($1, $2, 0.9, 'The company''s judgment.', 'The company''s reasoning.', true, $3)`,
      [node, status, CO]
    )
  );

/** Every export of the node, as a reader at `label` is given it. */
const exportsAt = (label: string, node: string) =>
  at(label, async () => ({
    trig: (await assembleClaimNanopub(node, "trig", WHEN))!.body,
    jsonld: (await assembleClaimNanopub(node, "jsonld", WHEN))!.body,
    mira: JSON.stringify(await assembleClaimMira(node, WHEN)),
    scasp: (await assembleClaimScasp(node, 3, WHEN))!,
  }));

/** One named graph of a TriG document. */
const graphOf = (trig: string, node: string, name: string) => {
  const start = trig.indexOf(`<${citationUrl(node)}#${name}> {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return trig.slice(start, trig.indexOf("\n}", start));
};
const byId = (doc: MiraDocument, id: string) => doc["@graph"].find((n) => n["@id"] === id) as JsonLdNode | undefined;
const argumentNamed = (doc: MiraDocument, name: string) => doc["@graph"].find((n) => n["@type"] === "mv:Argument" && n["rdfs:label"] === name)!;

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'The whole company.'), ($2, 'Finance.'), ($3, 'Legal.') ON CONFLICT (name) DO NOTHING`,
      LABELS
    );
    await rawQuery(
      `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, $1), ($2, 'public'), ($3, $1), ($3, 'public') ON CONFLICT DO NOTHING`,
      LABELS
    );
  });
  await ensureEnforcement();
}, 120_000);

afterAll(async () => {
  await system(async () => {
    const tables = (
      await rawQuery<{ t: string }>(
        `SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)`
      )
    ).map((r) => r.t);
    for (let pass = 0; pass < 6; pass++) {
      let removed = 0;
      for (const table of tables) {
        removed += (await rawQuery(`DELETE FROM "${table}" WHERE sensitivity_label = ANY($1::text[]) RETURNING 1`, [LABELS]).catch(() => [])).length;
      }
      for (const table of ["node_changes", "audit_log", "actions", "node_messages", "judgment_inputs"]) {
        const column = table === "node_messages" || table === "judgment_inputs" ? "node_id" : "claim_id";
        removed += (await rawQuery(`DELETE FROM "${table}" WHERE ${column} = ANY($1::uuid[]) RETURNING 1`, [seeded]).catch(() => [])).length;
      }
      removed += (await withTransaction((tx) => tx.query(`DELETE FROM claims WHERE id = ANY($1::uuid[]) RETURNING 1`, [seeded])).catch(() => [])).length;
      if (removed === 0) break;
    }
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [LABELS]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [LABELS]);
  }).catch((err: unknown) => console.warn("[export-set-aside] cleanup:", err instanceof Error ? err.message : err));
  await ensureEnforcement().catch(() => undefined);
}, 120_000);

describe("a claim's exports at a label that set an edge and an argument aside", () => {
  it("leave the edge and the argument out of live structure there, and change nothing for any other label", async () => {
    const parent = await seedNode(CO, "Revenue grew last year");
    const kept = await seedNode(CO, "Sales rose");
    const doubted = await seedNode(CO, "A one-off sale counted");
    const against = await seedNode(CO, "Returns rose");
    const keptEdge = await edge(parent, kept, "requires");
    const doubtedEdge = await edge(parent, doubted, "supports");
    const againstEdge = await edge(parent, against, "requires");
    const forName = `From the ledger ${tag}`;
    const againstName = `From the returns ${tag}`;
    const forArg = await at(CO, () => addArgument({ claimId: parent, stance: "for", name: forName, content: "The ledger shows it.", createdBy: "claim_steward" }));
    const againstArg = await at(CO, () =>
      addArgument({ claimId: parent, stance: "against", name: againstName, content: "Returns undo it.", createdBy: "claim_steward" })
    );
    await at(CO, async () => {
      await attachEdgeToArgument(forArg.id, keptEdge.id);
      await attachEdgeToArgument(forArg.id, doubtedEdge.id);
      await attachEdgeToArgument(againstArg.id, againstEdge.id);
      await setArgumentEvaluation({ argumentId: forArg.id, verdict: "certain", content: "It follows.", createdBy: "claim_steward" });
      await setArgumentEvaluation({ argumentId: againstArg.id, verdict: "certain", content: "It follows.", createdBy: "claim_steward" });
    });
    for (const n of [parent, kept, doubted]) await assess(n, "supported");
    await assess(against, "inconclusive");

    const before = { [CO]: await exportsAt(CO, parent), [LEGAL]: await exportsAt(LEGAL, parent) };
    // Before finance does anything, its exports are the company's.
    expect(await exportsAt(FIN, parent)).toEqual(before[CO]);
    // Both arguments are rules, and every edge is asserted.
    expect(before[CO].scasp).toContain(`holds(${claimAtom(parent)}) :-`);
    expect(before[CO].scasp).toContain(`-holds(${claimAtom(parent)}) :-`);
    expect(graphOf(before[CO].trig, parent, "assertion")).toContain(doubted);

    const reason = "Finance's ledger shows it is unrelated.";
    expect((await call(FIN, "remove_subclaim_edge", { parent_id: parent, child_id: doubted, reasoning: reason })).success).toBe(true);
    expect((await call(FIN, "retire_argument", { argument_id: againstArg.id, reasoning: "Finance has the returns, and they net out." })).success).toBe(true);

    // At the company and at legal, every export is, to the byte, what it was.
    for (const label of [CO, LEGAL] as const) expect(await exportsAt(label, parent)).toEqual(before[label]);

    // The evidence record at finance marks both.
    const record = (await at(FIN, () => assembleEvidenceRecord(parent)))!;
    const forRecord = record.arguments.find((a) => a.id === forArg.id)!;
    expect(forRecord.set_aside).toBeUndefined();
    expect(forRecord.subclaims.find((s) => s.id === doubted)!.set_aside).toMatchObject({ at: FIN, reason });
    expect(forRecord.subclaims.find((s) => s.id === kept)!.set_aside).toBeUndefined();
    expect(record.arguments.find((a) => a.id === againstArg.id)!.set_aside).toMatchObject({ at: FIN });
    // The disagreement is read off live structure: the set-aside argument on an inconclusive premise is not in it.
    expect(record.disagreement.arguments_on_unsettled_premises).toEqual([]);
    expect(
      (await at(CO, () => assembleEvidenceRecord(parent)))!.disagreement.arguments_on_unsettled_premises.map((a) => a.id)
    ).toEqual([againstArg.id]);

    const fin = await exportsAt(FIN, parent);

    // Nanopublication: the edge is out of the assertion and in the provenance, marked; so is the argument.
    const assertion = graphOf(fin.trig, parent, "assertion");
    expect(assertion).toContain(kept);
    expect(assertion).toContain(against);
    expect(assertion).not.toContain(doubted);
    const provenance = graphOf(fin.trig, parent, "provenance");
    expect(provenance).toContain(`<${citationUrl(parent)}#edge-supports-${doubted}> a mv:Edge`);
    expect(provenance).toContain(`mv:setAsideReason "${reason}"`);
    expect(provenance.match(/mv:setAsideAt "ex-fin"/g)).toHaveLength(2);
    expect(fin.jsonld).toContain("mv:setAsideAt");

    // MIRA: valid, both kept on their mv: nodes and marked, and neither lends a MIRA relation.
    const mira = JSON.parse(fin.mira) as MiraDocument;
    const report = await validateMira(mira);
    expect(report.messages).toEqual([]);
    expect(byId(mira, citationUrl(kept))).toMatchObject({ supports: citationUrl(parent) });
    expect(byId(mira, citationUrl(doubted))).not.toHaveProperty("supports");
    expect(byId(mira, citationUrl(against))).not.toHaveProperty("opposes");
    expect(byId(JSON.parse(before[CO].mira) as MiraDocument, citationUrl(against))).toMatchObject({ opposes: citationUrl(parent) });
    expect(byId(mira, `${citationUrl(parent)}#edge-supports-${doubted}`)).toMatchObject({ "mv:setAsideAt": FIN, "mv:setAsideReason": reason });
    expect(byId(mira, `${citationUrl(parent)}#edge-requires-${kept}`)).not.toHaveProperty("mv:setAsideAt");
    expect(argumentNamed(mira, againstName)).toMatchObject({ "mv:setAsideAt": FIN });
    expect(argumentNamed(mira, forName)).not.toHaveProperty("mv:setAsideAt");

    // s(CASP): the set-aside edge and what lies only beyond it are not in the program, and neither
    // argument is a rule: one is set aside, the other lost a premise's edge and stays a comment.
    expect(fin.scasp).not.toContain(claimAtom(doubted));
    expect(fin.scasp).not.toContain(againstName);
    expect(fin.scasp).toContain(`% "${forName}" (for, certain) on:`);
    expect(fin.scasp).toContain(`% Not encoded: the edge to one of its premises is set aside at ${FIN}, so the rule would be incomplete.`);
    expect(fin.scasp).not.toMatch(new RegExp(`^-?holds\\(${claimAtom(parent)}\\) :-$`, "m"));
    // The set-aside argument's edge is the edge's own, and stays.
    expect(fin.scasp).toContain(`edge(${claimAtom(parent)}, ${claimAtom(against)}, 'requires').`);
    expect(fin.scasp).toContain("% Left out: 1 edge and 1 argument set aside for whoever asked for this export.");

    // Taken back, finance's exports are the company's again.
    await call(FIN, "restore_below", { claim_id: parent, child_id: doubted, reasoning: "A second ledger." });
    await call(FIN, "restore_below", { claim_id: parent, argument_id: againstArg.id, reasoning: "The returns were miscounted." });
    expect(await exportsAt(FIN, parent)).toEqual(before[CO]);
  });

  it("a question's MIRA export marks a subquestion edge set aside there", async () => {
    const question = await seedNode(CO, "Why did revenue grow?", "question");
    const sub = await seedNode(CO, "Which region grew?", "question");
    await at(CO, () => markQuestion(question)).catch(() => undefined);
    await edge(question, sub, "part_of");
    const before = await at(CO, () => assembleClaimMira(question, WHEN));
    expect((await call(FIN, "remove_subclaim_edge", { parent_id: question, child_id: sub, reasoning: "Not finance's question." })).success).toBe(true);
    expect(await at(CO, () => assembleClaimMira(question, WHEN))).toEqual(before);
    const fin = (await at(FIN, () => assembleClaimMira(question, WHEN)))!;
    expect((await validateMira(fin)).messages).toEqual([]);
    expect(byId(fin, `${citationUrl(question)}#edge-part_of-${sub}`)).toMatchObject({ "mv:setAsideAt": FIN, "mv:setAsideReason": "Not finance's question." });
  });
});
