/**
 * A label's overlay on the structure below it, against a real database
 * with its wall up (src/services/overlay-service.ts; docs/architecture.md,
 * "A label's overlay on the structure below").
 *
 * The labels: `ov-co` reads `public` (a company-wide label), `ov-fin` and
 * `ov-legal` each read `ov-co` and not each other (two departments), and
 * `ov-desk` reads `ov-fin`. So public <- ov-co <- ov-fin <- ov-desk is a
 * chain, with `ov-legal` beside `ov-fin`. A node the public graph holds is
 * a row with origin 'mirror', written as the mirror's applier writes it.
 *
 * For each kind of divergence: it is recorded at the label that made it,
 * the labels that read that label see it composed with their own, and a
 * run at each label below is given, to the byte, what it was given before.
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
import { loadChangesBelowNote } from "../../src/llm/agents/changes-below-note.js";
import { labelNote } from "../../src/llm/label-note.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { getStewardStructureToolDefinitions } from "../../src/llm/tools/steward-structure-tools.js";
import { runAtLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { addArgument, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { getArgumentView } from "../../src/services/argument-view-service.js";
import { getClaimById } from "../../src/services/claim-service.js";
import { linkClaims } from "../../src/services/claim-link-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { compareAssessments, listPartitions } from "../../src/services/consistency-service.js";
import { getJudgmentInputs, recordJudgmentInputs } from "../../src/services/judgment-inputs-service.js";
import { noteMirrorApplied, resetMirrorHeldForTests } from "../../src/services/mirrored-node-service.js";
import { importanceSql, overlaid, setAsideSql } from "../../src/services/overlay-service.js";
import { getPriorityBreakdown } from "../../src/services/priority-service.js";
import { getQuantityDetail, getThresholdOf, recordCut } from "../../src/services/quantity-service.js";
import { mergeClaims } from "../../src/services/reconciliation-service.js";
import { attachEdgeToArgument, insertRelationshipEdge } from "../../src/services/relationship-service.js";
import { getClaimSourceMap, recordInstanceReading } from "../../src/services/source-map-service.js";
import { deepenChildren } from "../../src/services/standing-order-service.js";
import { findOrCreateTag, getTagsForSubject, listTags, setSubjectTags } from "../../src/services/tag-service.js";
import { getClaimTree } from "../../src/services/tree-service.js";

const PUBLIC = "public";
const CO = "ov-co";
const FIN = "ov-fin";
const LEGAL = "ov-legal";
const DESK = "ov-desk";
const LABELS = [CO, FIN, LEGAL, DESK];
const tag = randomUUID().slice(0, 8);
const seeded: { claims: string[]; sources: string[] } = { claims: [], sources: [] };

const system = <T>(fn: () => Promise<T>) => withSystemClearance("The overlay test seeds and checks rows at every label.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "the overlay test", fn);
const stewardAt = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "the overlay test's run", () => withAgent("steward", fn));
const asPerson = <T>(clearance: string[], fn: () => Promise<T>) => runWithUsageContext({ clearance }, fn);

type Answer = { success: boolean; message: string } & Record<string, unknown>;
const call = async (label: string, name: string, input: Record<string, unknown>): Promise<Answer> => {
  const raw = await stewardAt(label, () => executeStewardTool(name, input));
  try {
    return JSON.parse(raw) as Answer;
  } catch {
    return { success: false, message: raw };
  }
};

async function seedNode(label: string, text: string, opts: { kind?: string; importance?: number; mirrored?: boolean } = {}): Promise<string> {
  const id = await system(() =>
    withTransaction(async (tx) => {
      if (opts.mirrored) await tx.query(`SET LOCAL minerval.mirror_applier = 'on'`);
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, importance, sensitivity_label, origin)
         VALUES ($1, $2, 'done', 'complete', now(), $3, $4, $5) RETURNING id`,
        [`${text} (${tag} ${randomUUID().slice(0, 6)})`, opts.kind ?? "claim", opts.importance ?? 0.3, label, opts.mirrored ? "mirror" : "local"]
      );
      return row!.id;
    })
  );
  seeded.claims.push(id);
  return id;
}

const edge = (label: string, parentId: string, childId: string, relationType = "requires", reasoning = "It needs it.") =>
  at(label, () => insertRelationshipEdge({ parentId, childId, relationType, reasoning, createdBy: "claim_steward" }));

const version = (node: string, label: string, status: string, words: string) =>
  system(async () => {
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label)
       VALUES ($1, $2, 0.9, $3, $3, true, $4) RETURNING id`,
      [node, status, words, label]
    );
    return row!.id;
  });

async function attachSource(node: string, label: string): Promise<{ source: string; instance: string }> {
  return system(async () => {
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'A document', $2) RETURNING id`,
      [`https://overlay.example/${tag}/${randomUUID()}`, label]
    );
    seeded.sources.push(source!.id);
    const [instance] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, sensitivity_label) VALUES ($1, $2, 'What it says.', 'affirms', $3) RETURNING id`,
      [node, source!.id, label]
    );
    return { source: source!.id, instance: instance!.id };
  });
}

/** The live and ended overlays on rows of these nodes, as the owner sees them. */
const overlaysOn = (node: string) =>
  system(() =>
    rawQuery<{ kind: string; value: number; label: string; ended_because: string | null; target_table: string; reason: string | null }>(
      `SELECT kind, value, sensitivity_label AS label, ended_because, target_table, reason FROM overlays WHERE claim_id = $1 ORDER BY created_at, id`,
      [node]
    )
  );

/**
 * Everything a run at `label` is given about these nodes: each node's full
 * read, its tree, its judgment's inputs, the note of what changed, the
 * orders in which work on its children waits, the sweep's partitions and
 * its comparison, and the rows themselves. Two runs given the same thing
 * produce the same text, byte for byte.
 */
async function whatARunIsGiven(label: string, nodes: string[]): Promise<string> {
  return at(label, async () => {
    const out: Record<string, unknown> = {};
    for (const node of nodes) {
      out[node] = {
        view: await getClaimView(node, { include: ["arguments", "subclaims", "provenance", "dependents", "related", "judgment_inputs"] }),
        byId: await getClaimById(node),
        tree: await getClaimTree(node, 2),
        inputs: await getJudgmentInputs(node),
        note: await loadChangesBelowNote(node, "claim"),
        waits: await deepenChildren(node),
        priority: await getPriorityBreakdown(node),
        threshold: await getThresholdOf(node),
        tags: await getTagsForSubject("claim", node),
        rows: {
          node: await rawQuery(`SELECT to_jsonb(c) - 'updated_at' AS row FROM claims c WHERE id = $1`, [node]),
          edges: await rawQuery(`SELECT * FROM claim_relationships WHERE parent_claim_id = $1 OR child_claim_id = $1 ORDER BY created_at, id`, [node]),
          arguments: await rawQuery(`SELECT * FROM arguments WHERE claim_id = $1 ORDER BY created_at, id`, [node]),
          evaluations: await rawQuery(
            `SELECT e.* FROM argument_evaluations e JOIN arguments a ON a.id = e.argument_id WHERE a.claim_id = $1 ORDER BY e.created_at, e.id`,
            [node]
          ),
          cuts: await rawQuery(`SELECT * FROM quantity_cuts WHERE claim_id = $1 OR quantity_id = $1 ORDER BY sensitivity_label`, [node]),
          readings: await rawQuery(
            `SELECT r.* FROM claim_instance_readings r JOIN claim_instances ci ON ci.id = r.instance_id WHERE ci.claim_id = $1 ORDER BY r.created_at, r.id`,
            [node]
          ),
          overlays: await rawQuery(`SELECT * FROM overlays WHERE claim_id = $1 ORDER BY created_at, id`, [node]),
          changes: await rawQuery(`SELECT * FROM node_changes WHERE claim_id = $1 ORDER BY applied_at, id`, [node]),
          log: await rawQuery(`SELECT action, reasoning, sensitivity_label FROM audit_log WHERE claim_id = $1 ORDER BY created_at, id`, [node]),
          slots: await rawQuery(`SELECT * FROM steward_slots WHERE claim_id = $1 ORDER BY sensitivity_label`, [node]),
        },
      };
    }
    out.compared = await compareAssessments(nodes);
    out.partitions = (await listPartitions(1)).map((p) => ({ ...p, last_swept_at: null }));
    out.tags = (await listTags({ q: tag, includeUnused: true })).map((t) => ({ ...t, created_at: null }));
    return canonical(out);
  });
}

/** JSON with every object's keys in order: a read that fills its sections concurrently adds them in no fixed order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/** The two texts are the same to the byte; where they are not, the failure shows where they part. */
function expectSame(now: string, before: string): void {
  if (now === before) return;
  let i = 0;
  while (i < now.length && i < before.length && now[i] === before[i]) i++;
  expect(`...${now.slice(Math.max(0, i - 200), i + 300)}`).toBe(`...${before.slice(Math.max(0, i - 200), i + 300)}`);
}

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'The whole company.'), ($2, 'Finance.'), ($3, 'Legal.'), ($4, 'A desk inside finance.')
       ON CONFLICT (name) DO NOTHING`,
      LABELS
    );
    await rawQuery(
      `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, $1), ($2, 'public'), ($3, $1), ($3, 'public'), ($4, $2), ($4, $1), ($4, 'public')
       ON CONFLICT DO NOTHING`,
      LABELS
    );
  });
  await ensureEnforcement();
  noteMirrorApplied();
}, 120_000);

afterAll(async () => {
  resetMirrorHeldForTests();
  await system(async () => {
    const tables = (
      await rawQuery<{ t: string }>(
        `SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)`
      )
    ).map((r) => r.t);
    await rawQuery(`DELETE FROM taggings WHERE tag_id IN (SELECT id FROM tags WHERE slug LIKE $1)`, [`%${tag}%`]).catch(() => undefined);
    await rawQuery(`DELETE FROM tags WHERE slug LIKE $1`, [`%${tag}%`]).catch(() => undefined);
    for (let pass = 0; pass < 6; pass++) {
      let removed = 0;
      for (const table of tables) {
        removed += (await rawQuery(`DELETE FROM "${table}" WHERE sensitivity_label = ANY($1::text[]) RETURNING 1`, [LABELS]).catch(() => [])).length;
      }
      for (const table of ["node_changes", "audit_log", "actions", "node_messages", "judgment_inputs"]) {
        const column = table === "node_messages" || table === "judgment_inputs" ? "node_id" : "claim_id";
        removed += (await rawQuery(`DELETE FROM "${table}" WHERE ${column} = ANY($1::uuid[]) RETURNING 1`, [seeded.claims]).catch(() => [])).length;
      }
      removed += (
        await withTransaction(async (tx) => {
          await tx.query(`SET LOCAL minerval.mirror_applier = 'on'`);
          return tx.query(`DELETE FROM claims WHERE id = ANY($1::uuid[]) RETURNING 1`, [seeded.claims]);
        }).catch(() => [])
      ).length;
      removed += (await rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[]) RETURNING 1`, [seeded.sources]).catch(() => [])).length;
      if (removed === 0) break;
    }
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [LABELS]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [LABELS]);
  }).catch((err: unknown) => console.warn("[overlay] cleanup:", err instanceof Error ? err.message : err));
  await ensureEnforcement().catch(() => undefined);
}, 120_000);

describe("importance and contestation at a label", () => {
  it("is recorded at the label, composed for the labels that read it, and changes nothing below", async () => {
    const parent = await seedNode(CO, "A parent at the company label");
    const first = await seedNode(CO, "The first child", { importance: 0.8 });
    const second = await seedNode(CO, "The second child", { importance: 0.2 });
    await edge(CO, parent, first);
    await edge(CO, parent, second);
    // Both children wait for a pass at each label.
    await system(async () => {
      await rawQuery(`UPDATE claims SET steward_state = 'pending' WHERE id = ANY($1::uuid[])`, [[first, second]]);
      for (const label of [FIN, LEGAL, DESK]) {
        await rawQuery(
          `INSERT INTO steward_slots (claim_id, sensitivity_label, steward_state) VALUES ($1, $3, 'pending'), ($2, $3, 'pending')`,
          [first, second, label]
        );
      }
    });
    const nodes = [parent, first, second];
    const before = { [PUBLIC]: await whatARunIsGiven(PUBLIC, nodes), [CO]: await whatARunIsGiven(CO, nodes), [LEGAL]: await whatARunIsGiven(LEGAL, nodes) };

    // Finance holds the second child to matter more than the company does.
    const set = await call(FIN, "set_claim_importance", { claim_id: second, importance: 0.95, contestation: 0.7, reasoning: "Finance's close turns on it." });
    expect(set.success).toBe(true);
    expect(set.message).toBe(
      `Importance of ${second} is 0.95 at \`${FIN}\`. Contestation is 0.7 at \`${FIN}\`. The node is at \`${CO}\`, which keeps its own value ` +
        `(importance 0.2) for its readers and its work. What reads importance at \`${FIN}\` goes by yours: the order work waits in, ` +
        `what a mandate is shown, and the sweeps. restore_below takes this back.`
    );
    // Recorded at finance, and the node's own row is as it was.
    expect((await overlaysOn(second)).map((o) => [o.kind, Number(o.value), o.label])).toEqual([
      ["importance", 0.95, FIN],
      ["contestation", 0.7, FIN],
    ]);
    expect((await system(() => rawQuery<{ importance: number }>(`SELECT importance FROM claims WHERE id = $1`, [second])))[0]!.importance).toBeCloseTo(0.2);

    // Nothing a run below, or beside, is given has changed.
    for (const label of [PUBLIC, CO, LEGAL]) expectSame(await whatARunIsGiven(label, nodes), before[label as keyof typeof before]);

    // At finance the node is given with finance's value, and each label's is listed.
    const view = (await at(FIN, () => getClaimView(second))) as { claim: Record<string, unknown> };
    expect(view.claim.importance).toBeCloseTo(0.95);
    expect(view.claim.contestation).toBeCloseTo(0.7);
    expect(view.claim.importance_by_label).toEqual([
      { label: FIN, value: expect.closeTo(0.95), in_effect: true },
      { label: CO, value: expect.closeTo(0.2), in_effect: false },
    ]);
    // The order work waits in at finance follows it; the company's is unchanged.
    expect((await at(FIN, () => deepenChildren(parent))).toOrder).toEqual([second, first]);
    expect((await at(CO, () => deepenChildren(parent))).toOrder).toEqual([first, second]);
    expect((await at(LEGAL, () => deepenChildren(parent))).toOrder).toEqual([first, second]);
    expect((await at(FIN, () => getPriorityBreakdown(second)))!.importance).toBeCloseTo(0.95);
    expect((await at(CO, () => getPriorityBreakdown(second)))!.importance).toBeCloseTo(0.2);
    // The sweep's partitions at finance weigh it by finance's value.
    const mass = async (label: string) =>
      (await at(label, () => rawQuery<{ m: number }>(`SELECT SUM(${importanceSql("c")})::real AS m FROM claims c WHERE c.id = ANY($1::uuid[])`, [[first, second]])))[0]!.m;
    expect(await mass(FIN)).toBeCloseTo(1.75);
    expect(await mass(CO)).toBeCloseTo(1.0);
    // A person who reads finance and the company is given finance's; one who reads the company, the company's.
    expect((await asPerson([FIN, CO, PUBLIC], () => getClaimById(second)))!.importance).toBeCloseTo(0.95);
    expect((await asPerson([CO, PUBLIC], () => getClaimById(second)))!.importance).toBeCloseTo(0.2);

    // Three layers: the desk reads finance and goes by finance's value until it holds its own.
    expect((await at(DESK, () => getClaimById(second)))!.importance).toBeCloseTo(0.95);
    expect((await call(DESK, "set_claim_importance", { claim_id: second, importance: 0.5, reasoning: "The desk's work is elsewhere." })).success).toBe(true);
    const desk = (await at(DESK, () => getClaimView(second))) as { claim: Record<string, unknown> };
    expect(desk.claim.importance).toBeCloseTo(0.5);
    // Its contestation is still finance's: the two compose kind by kind.
    expect(desk.claim.contestation).toBeCloseTo(0.7);
    expect((desk.claim.importance_by_label as { label: string }[]).map((o) => o.label)).toEqual([DESK, FIN, CO]);
    expect((await at(FIN, () => getClaimById(second)))!.importance).toBeCloseTo(0.95);
    // A system sweep that asks for a label's value by name gets that label's.
    const byName = await system(() =>
      rawQuery<{ fin: number; co: number; legal: number; desk: number }>(
        `SELECT ${importanceSql("c", `'${FIN}'`)} AS fin, ${importanceSql("c", `'${CO}'`)} AS co,
                ${importanceSql("c", `'${LEGAL}'`)} AS legal, ${importanceSql("c", `'${DESK}'`)} AS desk FROM claims c WHERE c.id = $1`,
        [second]
      )
    );
    expect(byName[0]!.fin).toBeCloseTo(0.95);
    expect(byName[0]!.co).toBeCloseTo(0.2);
    expect(byName[0]!.legal).toBeCloseTo(0.2);
    expect(byName[0]!.desk).toBeCloseTo(0.5);

    // Legal holds its own, and finance does not see it.
    expect((await call(LEGAL, "set_claim_importance", { claim_id: second, importance: 0.05, reasoning: "No legal exposure." })).success).toBe(true);
    expect((await at(FIN, () => getClaimById(second)))!.importance).toBeCloseTo(0.95);
    expect((await at(LEGAL, () => getClaimById(second)))!.importance).toBeCloseTo(0.05);
    expectSame(await whatARunIsGiven(CO, nodes), before[CO]);

    // The desk takes its own back and goes by finance's again.
    const back = await call(DESK, "restore_below", { claim_id: second, reasoning: "Finance has it right." });
    expect(back.message).toBe(`\`${DESK}\` no longer holds its own importance for ${second}; its readers and work go by the layer below.`);
    expect((await at(DESK, () => getClaimById(second)))!.importance).toBeCloseTo(0.95);
    // A node at the run's own label is changed in place, as it always was.
    expect((await call(CO, "set_claim_importance", { claim_id: second, importance: 0.25, reasoning: "A little more." })).message).toBe(
      `Importance of claim ${second} set to 0.25.`
    );
    expect((await at(FIN, () => getClaimView(second)) as { claim: { importance_by_label: unknown[] } }).claim.importance_by_label[1]).toEqual({
      label: CO,
      value: expect.closeTo(0.25),
      in_effect: false,
    });
  });

  it("holds over a node the public graph holds, and ends when the node is merged away below", async () => {
    const mirrored = await seedNode(PUBLIC, "A claim the public graph holds", { mirrored: true, importance: 0.1 });
    const before = await whatARunIsGiven(PUBLIC, [mirrored]);
    const set = await call(CO, "set_claim_importance", { claim_id: mirrored, importance: 0.8, reasoning: "The company's plan rests on it." });
    expect(set.success).toBe(true);
    expect(set.message).toContain("The node is at the public graph, which keeps its own value (importance 0.1)");
    expect((await at(CO, () => getClaimById(mirrored)))!.importance).toBeCloseTo(0.8);
    expect((await at(FIN, () => getClaimById(mirrored)))!.importance).toBeCloseTo(0.8);
    expectSame(await whatARunIsGiven(PUBLIC, [mirrored]), before);
    // Work at `public` in this deployment does not lay its own value over the public graph's node.
    expect((await call(PUBLIC, "set_claim_importance", { claim_id: mirrored, importance: 0.9, reasoning: "x" })).success).toBe(false);

    // A node at the company label, with finance's own importance, merged into another by the company's Curator.
    const loser = await seedNode(CO, "A node the company will fold away");
    const survivor = await seedNode(CO, "The node it is folded into");
    await call(FIN, "set_claim_importance", { claim_id: loser, importance: 0.9, reasoning: "Finance's audit names it." });
    await version(survivor, FIN, "supported", "Finance's own judgment of the survivor.");
    const publicBefore = await whatARunIsGiven(CO, [survivor]);
    await at(CO, () => mergeClaims({ survivorId: survivor, loserId: loser, stanceRelation: "same", reasoning: "One claim." }));
    const ended = (await overlaysOn(loser)).filter((o) => o.label === FIN);
    expect(ended.map((o) => [o.kind, o.ended_because])).toEqual([["importance", "merged_below"]]);
    // The survivor's Steward at finance is told, in the note of what the layer below changed.
    const note = await stewardAt(FIN, () => loadChangesBelowNote(survivor, "claim"));
    expect(note).toContain(`What \`${FIN}\` held over rows at the labels below it, ended because the row was changed there:`);
    expect(note).toContain(`\`${FIN}\` held its own importance (0.9) for ${loser}`);
    expect(note).toContain(`which was merged into ${survivor}`);
    // The company's Steward of the survivor is told nothing of it.
    expect(await stewardAt(CO, () => loadChangesBelowNote(survivor, "claim"))).not.toContain("held its own importance");
    void publicBefore;
  });
});

describe("an edge or an argument below, set aside at a label", () => {
  it("an edge: marked for the label's readers, not rested on, unseen below, and ended when the layer below removes it", async () => {
    const parent = await seedNode(CO, "A claim the company decomposed");
    const kept = await seedNode(CO, "A premise everyone keeps");
    const doubted = await seedNode(CO, "A premise finance does not think bears");
    await edge(CO, parent, kept, "requires");
    const lower = await edge(CO, parent, doubted, "supports", "The company thinks it supports it.");
    for (const n of [parent, kept, doubted]) await version(n, CO, "supported", "The company's judgment.");
    const nodes = [parent, kept, doubted];
    const before = { [PUBLIC]: await whatARunIsGiven(PUBLIC, nodes), [CO]: await whatARunIsGiven(CO, nodes), [LEGAL]: await whatARunIsGiven(LEGAL, nodes) };

    const removed = await call(FIN, "remove_subclaim_edge", { parent_id: parent, child_id: doubted, reasoning: "Finance's ledger shows it is unrelated." });
    expect(removed.success).toBe(true);
    expect(removed.message).toBe(
      `Set aside at \`${FIN}\`: the supports edge, in the basis, from ${parent} to ${doubted}. It is at \`${CO}\`, which this run reads and does not change, ` +
        `and readers there see no difference. At \`${FIN}\` it is shown as set aside with your reason, and the judgment at \`${FIN}\` does not rest on it. ` +
        `restore_below takes this back.`
    );
    // The edge is where it was, and what the labels below and beside are given is what it was.
    expect((await system(() => rawQuery(`SELECT 1 FROM claim_relationships WHERE id = $1`, [lower.id]))).length).toBe(1);
    for (const label of [PUBLIC, CO, LEGAL]) expectSame(await whatARunIsGiven(label, nodes), before[label as keyof typeof before]);

    // At finance, and at the desk that reads finance, it is listed and marked.
    for (const label of [FIN, DESK]) {
      const view = (await at(label, () => getClaimView(parent, { include: ["subclaims"] }))) as { subclaims: Record<string, unknown>[] };
      const row = view.subclaims.find((s) => s.id === doubted)!;
      expect(row.label).toBe(CO);
      expect(row.set_aside).toMatchObject({ at: FIN, reason: "Finance's ledger shows it is unrelated." });
      expect(view.subclaims.find((s) => s.id === kept)!.set_aside).toBeUndefined();
      const tree = await at(label, () => getClaimTree(parent, 1));
      expect(tree!.children.find((c) => c.id === doubted)!.set_aside).toEqual({ at: FIN, reason: "Finance's ledger shows it is unrelated." });
    }
    // The judgment at finance does not rest on it: its record of inputs leaves it out, and the sweep reads no commitment from it.
    const finVersion = await version(parent, FIN, "doubtful", "Finance's own judgment.");
    await at(FIN, () => recordJudgmentInputs(rawQuery, "assessment", finVersion, parent));
    const inputs = await at(FIN, () => getJudgmentInputs(parent));
    expect(JSON.stringify(inputs)).toContain(kept);
    expect(JSON.stringify(inputs)).not.toContain(doubted);
    const compared = await at(FIN, () => compareAssessments(nodes));
    expect(compared.relations.map((r) => r.to).sort()).toEqual([kept]);
    expect((await at(CO, () => compareAssessments(nodes))).relations.map((r) => r.to).sort()).toEqual([doubted, kept].sort());
    // The sweep at finance is given the company's judgment of the parent beside finance's own.
    expect(compared.claims.find((c) => c.claim_id === parent)!.status).toBe("doubtful");
    expect(compared.claims.find((c) => c.claim_id === parent)!.also_judged_at).toEqual([
      expect.objectContaining({ label: CO, status: "supported", summary: "The company's judgment." }),
    ]);
    expect((await at(CO, () => compareAssessments(nodes))).claims.find((c) => c.claim_id === parent)!.also_judged_at).toBeUndefined();

    // The desk counts it again, over finance's setting aside; finance still has it set aside.
    const counted = await call(DESK, "restore_below", { claim_id: parent, child_id: doubted, reasoning: "The desk's trades depend on it." });
    expect(counted.message).toBe(`The supports edge to ${doubted} counts again at \`${DESK}\`; it stays set aside at \`${FIN}\`, whose readers see no difference.`);
    expect(await at(DESK, () => rawQuery<{ aside: boolean }>(`SELECT ${setAsideSql("claim_relationships", "$1::uuid")} AS aside`, [lower.id]))).toEqual([{ aside: false }]);
    expect(await at(FIN, () => rawQuery<{ aside: boolean }>(`SELECT ${setAsideSql("claim_relationships", "$1::uuid")} AS aside`, [lower.id]))).toEqual([{ aside: true }]);
    expect(await at(LEGAL, () => rawQuery<{ aside: boolean }>(`SELECT ${setAsideSql("claim_relationships", "$1::uuid")} AS aside`, [lower.id]))).toEqual([{ aside: false }]);
    // Adding the edge again at finance is handed the company's row, and told it is set aside.
    const again = await call(FIN, "add_relationship_edge", { parent_id: parent, child_id: doubted, relation: "supports", reasoning: "Again." });
    expect(again.message).toContain(`It is set aside at \`${FIN}\` ("Finance's ledger shows it is unrelated.")`);

    // The company removes the edge. What finance and the desk held over it ends, and each Steward is told.
    const gone = await call(CO, "remove_subclaim_edge", { parent_id: parent, child_id: doubted, reasoning: "It was a mistake." });
    expect(gone.success).toBe(true);
    expect(gone.message).toContain("Removed the supports edge");
    expect((await overlaysOn(parent)).map((o) => [o.label, Number(o.value), o.ended_because])).toEqual([
      [FIN, 1, "removed_below"],
      [DESK, 0, "removed_below"],
    ]);
    const note = await stewardAt(FIN, () => loadChangesBelowNote(parent, "claim"));
    expect(note).toContain(
      `- The supports edge to ${doubted} "A premise finance does not think bears`
    );
    expect(note).toContain(`which \`${FIN}\` had set aside ("Finance's ledger shows it is unrelated."), was removed on `);
    expect(note).toContain(`Each ended when its row changed, and nothing else at \`${FIN}\` was changed.`);
    // Nothing of finance's is in what the company's Steward is told.
    expect(await stewardAt(CO, () => loadChangesBelowNote(parent, "claim"))).not.toContain("set aside");
  });

  it("an edge the label reads with another relation: its own edge beside the one below, which it sets aside", async () => {
    const parent = await seedNode(CO, "Another claim the company decomposed");
    const child = await seedNode(CO, "A premise whose bearing finance reads differently");
    await edge(CO, parent, child, "requires", "The company says it is required.");
    const before = await whatARunIsGiven(CO, [parent, child]);
    const retyped = await call(FIN, "set_edge_relation", { parent_id: parent, child_id: child, relation: "supports", reasoning: "It helps, and the claim stands without it." });
    expect(retyped.success).toBe(true);
    expect(retyped.message).toContain(`At \`${FIN}\` the edge from ${parent} to ${child} is now supports, a row of its own.`);
    expectSame(await whatARunIsGiven(CO, [parent, child]), before);
    const view = (await at(FIN, () => getClaimView(parent, { include: ["subclaims"] }))) as { subclaims: Record<string, unknown>[] };
    expect(view.subclaims.map((s) => [s.relation, s.label, Boolean(s.set_aside)])).toEqual([
      ["requires", CO, true],
      ["supports", FIN, false],
    ]);
    // Its own edge is its own to remove outright.
    const own = await call(FIN, "remove_subclaim_edge", { parent_id: parent, child_id: child, relation: "supports", reasoning: "On reflection." });
    expect(own.message).toContain("Removed the supports edge");
  });

  it("an argument: set aside at the label with its reason, and ended when the layer below retires it", async () => {
    const node = await seedNode(CO, "A claim with an argument the company wrote");
    const argument = await at(CO, () => addArgument({ claimId: node, stance: "for", name: `From the audit ${tag}`, content: "The audit found it.", createdBy: "claim_steward" }));
    const other = await at(CO, () => addArgument({ claimId: node, stance: "against", name: `From the forecast ${tag}`, content: "The forecast denies it.", createdBy: "claim_steward" }));
    const before = { [CO]: await whatARunIsGiven(CO, [node]), [LEGAL]: await whatARunIsGiven(LEGAL, [node]) };

    const aside = await call(FIN, "retire_argument", { argument_id: argument.id, reasoning: "Finance has the audit, and it says no such thing." });
    expect(aside.message).toBe(
      `Set aside at \`${FIN}\`: argument "From the audit ${tag}". It is at \`${CO}\`, which this run reads and does not change, and readers there see no ` +
        `difference. At \`${FIN}\` it is shown as set aside with your reason, and the judgment at \`${FIN}\` does not rest on it. restore_below takes this back.`
    );
    expectSame(await whatARunIsGiven(CO, [node]), before[CO]);
    expectSame(await whatARunIsGiven(LEGAL, [node]), before[LEGAL]);
    const view = (await at(FIN, () => getClaimView(node, { include: ["arguments"] }))) as { arguments: Record<string, unknown>[] };
    expect(view.arguments.map((a) => [a.id, a.label, (a.set_aside as { at?: string } | undefined)?.at])).toEqual([
      [argument.id, CO, FIN],
      [other.id, CO, undefined],
    ]);
    expect(((await at(FIN, () => getArgumentView(argument.id))) as { argument: Record<string, unknown> }).argument.set_aside).toMatchObject({ at: FIN });
    expect(((await at(CO, () => getArgumentView(argument.id))) as { argument: Record<string, unknown> }).argument.set_aside).toBeUndefined();

    // Finance takes it back, then sets it aside again and evaluates the other; the company then retires the first.
    expect((await call(FIN, "restore_below", { claim_id: node, argument_id: argument.id, reasoning: "A second audit does say it." })).message).toBe(
      `Argument "From the audit ${tag}" counts again at \`${FIN}\`.`
    );
    await call(FIN, "retire_argument", { argument_id: argument.id, reasoning: "The second audit was withdrawn." });
    await at(FIN, () => setArgumentEvaluation({ argumentId: argument.id, verdict: "no_support", decisive: false, content: "Finance's evaluation.", createdBy: "claim_steward" }));
    const retired = await call(CO, "retire_argument", { argument_id: argument.id, reasoning: "The company withdrew it." });
    expect(retired.message).toContain("Retired argument");
    const rows = await overlaysOn(node);
    expect(rows.map((o) => o.ended_because)).toEqual(["taken_back", "retired_below"]);
    const note = await stewardAt(FIN, () => loadChangesBelowNote(node, "claim"));
    expect(note).toContain(`which \`${FIN}\` had set aside ("The second audit was withdrawn."), was retired on `);
    expect(note).toContain("(The company withdrew it.)");
    // Finance's evaluation of the retired argument is kept as it was written and is no longer on the node's page.
    const finView = (await at(FIN, () => getClaimView(node, { include: ["arguments"] }))) as { arguments: { id: string }[]; retired_arguments: { id: string }[] };
    expect(finView.arguments.map((a) => a.id)).toEqual([other.id]);
    expect(finView.retired_arguments.map((a) => a.id)).toEqual([argument.id]);
    expect(
      (await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM argument_evaluations WHERE argument_id = $1`, [argument.id]))).map((r) => r.l)
    ).toEqual([FIN]);
  });

  it("is refused where the row is not below the run's label, and the tool is not offered on a graph with one label", async () => {
    const mine = await seedNode(FIN, "A node at finance");
    const child = await seedNode(FIN, "A child at finance");
    await edge(FIN, mine, child);
    // Its own edge: removed outright, no overlay.
    expect((await call(FIN, "remove_subclaim_edge", { parent_id: mine, child_id: child, reasoning: "Mine to remove." })).message).toContain("Removed the requires edge");
    expect(await overlaysOn(mine)).toEqual([]);
    expect((await call(FIN, "restore_below", { claim_id: mine, reasoning: "x" })).success).toBe(false);
    // Here the deployment has more than one label, so the tool is among the Steward's.
    expect(overlaid()).toBe(true);
    expect(getStewardStructureToolDefinitions().map((t) => t.name)).toContain("restore_below");
  });
});

describe("a cut or a reading of its own beside one below", () => {
  it("a cut: the label's own is what its readers go by, shown as its divergence from the one below", async () => {
    const claim = await seedNode(CO, "Revenue grew by more than a tenth");
    const quantity = await seedNode(CO, "Revenue growth last year", { kind: "quantity" });
    await at(CO, () => recordCut({ claimId: claim, quantityId: quantity, direction: "above", value: 10, createdBy: "claim_steward" }));
    const before = { [CO]: await whatARunIsGiven(CO, [claim, quantity]), [LEGAL]: await whatARunIsGiven(LEGAL, [claim, quantity]) };
    // Finance judges that the claim cuts elsewhere, and records its own.
    await at(FIN, () => recordCut({ claimId: claim, quantityId: quantity, direction: "above", value: 12, createdBy: "claim_steward" }));
    expectSame(await whatARunIsGiven(CO, [claim, quantity]), before[CO]);
    expectSame(await whatARunIsGiven(LEGAL, [claim, quantity]), before[LEGAL]);
    const fin = await at(FIN, () => getThresholdOf(claim));
    expect(fin).toMatchObject({ value: 12, label: FIN, below: [{ label: CO, direction: "above", value: 10, quantity_id: quantity }] });
    // The desk reads finance and goes by finance's; legal reads the company's.
    expect(await at(DESK, () => getThresholdOf(claim))).toMatchObject({ value: 12, label: FIN });
    const legal = await at(LEGAL, () => getThresholdOf(claim));
    expect(legal).toMatchObject({ value: 10, label: CO });
    expect(legal!.below).toBeUndefined();
    // The quantity's page lists the claim once, with the cut the reader goes by.
    expect((await at(FIN, () => getQuantityDetail(quantity))).cuts.map((c) => [c.id, c.value, c.label])).toEqual([[claim, 12, FIN]]);
    expect((await at(CO, () => getQuantityDetail(quantity))).cuts.map((c) => [c.id, c.value, c.label])).toEqual([[claim, 10, CO]]);
    // Finance revises its own; the company's is untouched.
    await at(FIN, () => recordCut({ claimId: claim, quantityId: quantity, direction: "above", value: 11, createdBy: "claim_steward" }));
    expect(await at(FIN, () => getThresholdOf(claim))).toMatchObject({ value: 11, below: [{ value: 10 }] });
    expectSame(await whatARunIsGiven(CO, [claim, quantity]), before[CO]);
  });

  it("which row stands where the higher label recorded first: each reader's nearest, the lower one beside it", async () => {
    const claim = await seedNode(PUBLIC, "Costs fell below a fifth of revenue");
    const quantity = await seedNode(PUBLIC, "Costs as a share of revenue", { kind: "quantity" });
    await at(FIN, () => recordCut({ claimId: claim, quantityId: quantity, direction: "below", value: 20, createdBy: "claim_steward" }));
    const alone = await at(CO, () => getThresholdOf(claim));
    expect(alone).toBeNull();
    await at(CO, () => recordCut({ claimId: claim, quantityId: quantity, direction: "below", value: 25, createdBy: "claim_steward" }));
    expect(await at(CO, () => getThresholdOf(claim))).toMatchObject({ value: 25, label: CO });
    expect((await at(CO, () => getThresholdOf(claim)))!.below).toBeUndefined();
    expect(await at(FIN, () => getThresholdOf(claim))).toMatchObject({ value: 20, label: FIN, below: [{ label: CO, value: 25 }] });
    expect(await asPerson([FIN, CO, PUBLIC], () => getThresholdOf(claim))).toMatchObject({ value: 20, label: FIN, below: [{ label: CO, value: 25 }] });
    expect(await asPerson([LEGAL, CO, PUBLIC], () => getThresholdOf(claim))).toMatchObject({ value: 25, label: CO });
  });

  it("a reading of a passage: the label's own beside the one below", async () => {
    const node = await seedNode(CO, "A claim with a passage read twice");
    const { instance } = await attachSource(node, CO);
    await at(CO, () => recordInstanceReading({ claimId: node, instanceId: instance, support: "supports", note: "The company's reading.", createdBy: "claim_steward" }));
    const before = await whatARunIsGiven(CO, [node]);
    await at(FIN, () => recordInstanceReading({ claimId: node, instanceId: instance, support: "overstates", note: "Finance's reading.", createdBy: "claim_steward" }));
    expectSame(await whatARunIsGiven(CO, [node]), before);
    const fin = (await at(FIN, () => getClaimSourceMap(node))).readings[instance]!;
    expect(fin).toMatchObject({ label: FIN, support: "overstates", note: "Finance's reading.", below: [{ label: CO, support: "supports", note: "The company's reading." }] });
    const co = (await at(CO, () => getClaimSourceMap(node))).readings[instance]!;
    expect(co).toMatchObject({ label: CO, support: "supports" });
    expect(co.below).toBeUndefined();
    // An instance says which label it is at.
    const view = (await at(FIN, () => getClaimView(node, { include: ["provenance"] }))) as { instances: Record<string, unknown>[] };
    expect(view.instances.map((i) => i.label)).toEqual([CO]);
  });
});

describe("a thing held at two layers is given once", () => {
  it("a tag recorded at a higher label and then at a lower one is listed once, with the nodes tagged under either", async () => {
    const name = `Overlay topic ${tag}`;
    const upper = await seedNode(FIN, "A node finance tagged first");
    const lower = await seedNode(CO, "A node the company tagged later");
    await at(FIN, () => setSubjectTags({ kind: "claim", subjectId: upper, source: "steward", assignments: [{ name }] }));
    const theirs = await at(CO, () => findOrCreateTag({ name, createdBy: "tagger" }));
    await at(CO, () => setSubjectTags({ kind: "claim", subjectId: lower, source: "steward", assignments: [{ tagId: theirs.tag.id }] }));
    await at(FIN, () => setSubjectTags({ kind: "claim", subjectId: lower, source: "steward", assignments: [{ name }] }));
    const listed = await at(FIN, () => listTags({ q: tag, includeUnused: true }));
    expect(listed.map((t) => [t.id, t.claim_count])).toEqual([[theirs.tag.id, 2]]);
    expect((await at(CO, () => listTags({ q: tag, includeUnused: true }))).map((t) => [t.id, t.claim_count])).toEqual([[theirs.tag.id, 1]]);
    // A node tagged under both rows of the slug carries the tag once.
    await system(() =>
      rawQuery(
        `INSERT INTO taggings (tag_id, subject_kind, subject_id, source, sensitivity_label)
         SELECT t.id, 'claim', $1, 'steward', $2 FROM tags t WHERE t.slug = $3 AND t.sensitivity_label = $2 ON CONFLICT DO NOTHING`,
        [lower, FIN, theirs.tag.slug]
      )
    );
    expect((await at(FIN, () => getTagsForSubject("claim", lower))).map((t) => t.slug)).toEqual([theirs.tag.slug]);
  });

  it("a link recorded at a higher label and then at a lower one is listed once, by the lower row", async () => {
    const a = await seedNode(PUBLIC, "One claim");
    const b = await seedNode(PUBLIC, "A claim beside it");
    await at(FIN, () => linkClaims({ claimId: a, otherClaimId: b, kind: "related", reasoning: "Finance linked them.", createdBy: "curator" }));
    await at(CO, () => linkClaims({ claimId: a, otherClaimId: b, kind: "related", reasoning: "The company linked them.", createdBy: "curator" }));
    const view = (await at(FIN, () => getClaimView(a, { include: ["related"] }))) as { related: Record<string, unknown>[] };
    expect(view.related.map((r) => [r.id, r.label, r.reasoning])).toEqual([[b, CO, "The company linked them."]]);
  });

  it("an edge grouped under an argument says which label each is at", async () => {
    const parent = await seedNode(PUBLIC, "A public claim");
    const child = await seedNode(CO, "A premise the company added");
    const argument = await at(FIN, () => addArgument({ claimId: parent, stance: "for", name: `Finance's line ${tag}`, content: "c", createdBy: "claim_steward" }));
    const made = await edge(CO, parent, child, "supports");
    await at(FIN, () => attachEdgeToArgument(argument.id, made.id));
    const tree = await at(FIN, () => getClaimTree(parent, 1));
    expect(tree!.children.map((c) => [c.id, c.label, c.argument_label])).toEqual([[child, CO, FIN]]);
    // A reader of the company label alone sees the edge and not finance's argument.
    const co = await at(CO, () => getClaimTree(parent, 1));
    expect(co!.children.map((c) => [c.id, c.label, c.argument_id])).toEqual([[child, CO, null]]);
  });
});

describe("the Curator at a label, on nodes below it", () => {
  it("cannot merge away a node at a label below: refused, and nothing is changed", async () => {
    const one = await seedNode(CO, "A company node");
    const two = await seedNode(CO, "Another company node, much like it");
    const before = await whatARunIsGiven(CO, [one, two]);
    const err = await at(FIN, () => mergeClaims({ survivorId: one, loserId: two, stanceRelation: "same", reasoning: "One claim." })).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).not.toBeNull();
    expectSame(await whatARunIsGiven(CO, [one, two]), before);
    expect((await system(() => rawQuery<{ state: string }>(`SELECT state FROM claims WHERE id = $1`, [two])))[0]!.state).toBe("active");
  });
});

describe("what a Steward is told", () => {
  it("in its brief: what it may record over a row below, in the passage on judgments", () => {
    const note = labelNote(FIN, [FIN, CO, PUBLIC], { writesJudgments: true });
    expect(note).toContain(
      `A node that carries another label keeps its wording, which is its own Steward's. What you add to it (an argument, a subclaim, a source) is ` +
        `recorded at \`${FIN}\`, and so is what you hold differently for readers at \`${FIN}\`: on a row at a label below, set_claim_importance ` +
        `records your importance for the node, and remove_subclaim_edge, set_edge_relation and retire_argument set the edge or argument aside, ` +
        `at \`${FIN}\` only.`
    );
    expect(note).toContain(`What carries another label is not this run's to change, and no tool changes or removes it.`);
  });
});
