/**
 * A deployment's own judgments beside the mirrored public graph
 * (docs/mirror.md, "Beside a deployment's own rows").
 *
 * Two databases, as in mirror-round-trip.test.ts: a publisher (the public
 * graph, one label) and a private deployment, which is the app's own
 * database here, with the labels `public`, `pm-a`, `pm-b` and `pm-c`:
 * `pm-a` and `pm-b` read `public`, `pm-c` reads `pm-a` and `public`, and
 * `pm-a` and `pm-b` do not read each other. Work with nothing in context is
 * a connection that reads `public` alone, as in a deployment.
 *
 * What is held here: a public claim arrives through the mirror while
 * members read; a run at `pm-a` records its own version on it, resting on
 * material at `pm-a`; nothing local records or opens work at `public` on
 * it; when the public graph replaces its assessment the `pm-a` version is
 * shown as made against an earlier one and its reassessment is opened at
 * `pm-a` and nowhere else; no row of the deployment's own, at any label,
 * stops a batch; a merge and a withdrawal upstream leave what the
 * deployment recorded where it was and tell the Stewards concerned; the
 * Steward's tools on a mirrored node either write at the run's label or
 * refuse with one message; a node of the deployment's own that the public
 * graph later states can be folded into the public one; and a run is told
 * all of it in its brief.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import pg from "pg";
import { rawQuery } from "../../src/db/client.js";
import { asGiven } from "./helpers.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { runClaimSteward } from "../../src/llm/agents/claim-steward.js";
import { loadChangesBelowNote } from "../../src/llm/agents/changes-below-note.js";
import { labelNote, mirrorNote } from "../../src/llm/label-note.js";
import { executeCuratorTool } from "../../src/llm/tools/curator-tools.js";
import { executeKindTool } from "../../src/llm/tools/kind-tools.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { runAtLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { ASSESS_GROUP, ensureAssessActions, reconcileActions } from "../../src/services/action-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { createContribution } from "../../src/services/contribution-service.js";
import { requestCuration } from "../../src/services/curation-service.js";
import { executeLeaveStandingTool } from "../../src/llm/tools/leave-standing-tool.js";
import { nodeVersions } from "../../src/services/judgment-version-service.js";
import {
  ROW_REFUSAL_FOR_MEMBERS,
  applyBatch,
  mirrorStatus,
  syncMirror,
  type ApplyResult,
  type BatchSource,
} from "../../src/services/mirror-apply-service.js";
import { poolDb, type MirrorDb } from "../../src/services/mirror-db.js";
import { replicatedTables } from "../../src/services/mirror-manifest.js";
import { cutBatches, getBatchText, listBatches } from "../../src/services/mirror-feed-service.js";
import { afterMirrorApplied } from "../../src/services/mirror-upkeep.js";
import {
  PublicGraphNodeError,
  mirroredRowMessage,
  publicContributionRefusal,
  publicGraphAsOf,
  publicJudgmentMessage,
  publicWorkNotDoneHereMessage,
  sourceMirrorFacts,
} from "../../src/services/mirrored-node-service.js";
import { createOrder } from "../../src/services/order-service.js";
import { getQuantityDetail, getThresholdOf } from "../../src/services/quantity-service.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { insertRelationshipEdge } from "../../src/services/relationship-service.js";
import { findSimilarClaims } from "../../src/services/search-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { mirrorDatabaseUrl } from "./urls.js";

const A = "pm-a";
const B = "pm-b";
const C = "pm-c";
const tag = randomUUID().slice(0, 8);
const signing = generateKeyPairSync("ed25519");
const trustedKeys = [signing.publicKey];
const DIM = 1536;

let pubPool: pg.Pool;
let pub: MirrorDb;

const system = <T>(fn: () => Promise<T>) =>
  withSystemClearance("A test of the mirror beside private rows seeds and checks rows at every label.", fn);
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
const caught = async (fn: () => Promise<unknown>): Promise<unknown> => fn().then(() => null, (e: unknown) => e);

/** A unit vector along one axis; vectors on different axes are orthogonal. */
function vec(axis: number): string {
  const v = Array.from({ length: DIM }, () => 0);
  v[axis] = 1;
  return `[${v.join(",")}]`;
}

/** Insert one row from an object. */
async function ins(db: MirrorDb, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    columns.map((c) => row[c])
  );
}

// ---- the public graph -------------------------------------------------------------

const id = {
  parent: randomUUID(),
  child: randomUUID(),
  other: randomUUID(),
  absorbed: randomUUID(),
  survivor: randomUUID(),
  withdrawn: randomUUID(),
  quantity: randomUUID(),
  late: randomUUID(),
  edgeChild: randomUUID(),
  edgeLater: randomUUID(),
  argument: randomUUID(),
  argumentLater: randomUUID(),
  argumentWithdrawn: randomUUID(),
  paperWithdrawn: randomUUID(),
  paper: randomUUID(),
  paperLater: randomUUID(),
  paperPublicLater: randomUUID(),
  instance: randomUUID(),
  verdict1: randomUUID(),
  verdict2: randomUUID(),
  verdictAbsorbed: randomUUID(),
  verdictWithdrawn: randomUUID(),
  evaluation: randomUUID(),
};
const text = (words: string) => `${words} (${tag})`;
const URL_LATER = `https://journal.example/${tag}/held-privately-first`;
const URL_PUBLIC_LATER = `https://journal.example/${tag}/held-publicly-first`;

async function seedPublicGraph(): Promise<void> {
  const claim = (key: keyof typeof id, words: string, axis: number, more: Record<string, unknown> = {}) =>
    ins(pub, "claims", {
      id: id[key],
      text: text(words),
      embedding: vec(axis),
      importance: 0.6,
      steward_state: "done",
      tagged_at: new Date(),
      ...more,
    });
  await claim("parent", "Coastal wetlands store more carbon per hectare than upland forest", 100);
  await claim("child", "Wetland soils accumulate carbon for centuries without saturating", 101);
  await claim("other", "Upland forest soils reach a carbon equilibrium within decades", 102);
  await claim("absorbed", "Tidal marsh soil keeps accumulating carbon over centuries", 103);
  await claim("survivor", "Tidal marsh soils accumulate carbon over centuries", 104);
  await claim("withdrawn", "A claim the public graph will delete while private work rests on it", 105);
  await claim("quantity", "Carbon stored per hectare of coastal wetland", 106, { kind: "quantity" });
  await ins(pub, "quantity_definitions", {
    claim_id: id.quantity,
    measures: "organic carbon in the top metre of soil",
    unit: { kind: "proportion" },
    created_by: "claim_steward",
  });
  await ins(pub, "claim_relationships", {
    id: id.edgeChild,
    parent_claim_id: id.parent,
    child_claim_id: id.child,
    relation_type: "requires",
    reasoning: "The public graph's reason.",
    confidence: 0.9,
  });
  await ins(pub, "sources", { id: id.paper, url: `https://journal.example/${tag}/wetland-carbon`, title: "Wetland carbon", raw_content: "Wetlands store carbon." });
  await ins(pub, "claim_instances", { id: id.instance, claim_id: id.parent, source_id: id.paper, verbatim_text: "Wetlands store carbon.", stance: "affirms" });
  await ins(pub, "arguments", {
    id: id.argument,
    claim_id: id.parent,
    name: "From soil accumulation",
    stance: "for",
    content: `Because [[claim:${id.child}]], the stock keeps growing.`,
    created_by: "claim_steward",
  });
  await ins(pub, "argument_subclaims", { argument_id: id.argument, relationship_id: id.edgeChild });
  await ins(pub, "arguments", { id: id.argumentWithdrawn, claim_id: id.withdrawn, name: "An argument that goes with its node", stance: "for", content: "It goes with its node.", created_by: "claim_steward" });
  await ins(pub, "sources", { id: id.paperWithdrawn, url: `https://journal.example/${tag}/soon-gone`, title: "A paper the public graph will drop" });
  const verdict = (key: keyof typeof id, claimId: string, status: string, words: string) =>
    ins(pub, "assessments", { id: id[key], claim_id: claimId, status, confidence: 0.6, summary: words, reasoning_trace: `${words} The reasoning.` });
  await verdict("verdict1", id.parent, "inconclusive", "The first public reading.");
  await verdict("verdictAbsorbed", id.absorbed, "supported", "The public reading of the marsh claim.");
  await verdict("verdictWithdrawn", id.withdrawn, "doubtful", "The public reading of a claim soon gone.");
  await ins(pub, "argument_evaluations", { id: id.evaluation, argument_id: id.argument, verdict: "likely", content: "It follows if the premise holds.", assessment_id: id.verdict1 });
}

const cut = () => cutBatches({ db: pub, signingKey: signing.privateKey, webBaseUrl: "https://public.example" });
const feed = (): BatchSource => ({
  name: "the publisher's database",
  head: async () => (await listBatches({}, pub)).head,
  latestSnapshot: async () => (await listBatches({}, pub)).latest_snapshot,
  fetch: (sequence) => getBatchText(sequence, pub),
});

const refusals: string[] = [];
/** Cut what changed on the public graph, bring the mirror up to it, and do what follows. Nothing is ever refused. */
async function publishAndApply(): Promise<{ applied: ApplyResult[]; upkeep: Awaited<ReturnType<typeof afterMirrorApplied>> }> {
  await cut();
  const result = await syncMirror(feed(), { trustedKeys });
  if (result.refusal) refusals.push(result.refusal.message);
  expect(result.refusal?.message ?? null).toBeNull();
  return { applied: result.applied, upkeep: await afterMirrorApplied(result.applied) };
}

// ---- the private deployment ---------------------------------------------------------

const made: { claims: string[]; sources: string[]; users: string[] } = { claims: [], sources: [], users: [] };

async function seedOwnNode(label: string, words: string, axis?: number): Promise<string> {
  const [row] = await system(() =>
    rawQuery<{ id: string }>(
      `INSERT INTO claims (text, steward_state, decomposition_status, tagged_at, embedding, sensitivity_label)
       VALUES ($1, 'done', 'complete', now(), $2, $3) RETURNING id`,
      [text(words), axis === undefined ? null : vec(axis), label]
    )
  );
  made.claims.push(row!.id);
  return row!.id;
}

/** A source at `label`, attached to the node by an instance at the same label: material at that label. */
async function attachSource(node: string, label: string, url?: string): Promise<{ source: string; instance: string }> {
  return system(async () => {
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'A document held at a label', $2) RETURNING id`,
      [url ?? `https://intranet.example/${tag}/${randomUUID()}`, label]
    );
    made.sources.push(source!.id);
    const [instance] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, sensitivity_label)
       VALUES ($1, $2, 'What the document says.', 'affirms', $3) RETURNING id`,
      [node, source!.id, label]
    );
    return { source: source!.id, instance: instance!.id };
  });
}

type ToolAnswer = { success: boolean; message: string };
const tool = async (name: string, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const raw = await executeStewardTool(name, input);
  try {
    return JSON.parse(raw) as ToolAnswer;
  } catch {
    return { success: !raw.startsWith("Error"), message: raw };
  }
};
const assess = (node: string, status = "supported", words = "Judged.") =>
  tool("update_claim_assessment", { claim_id: node, status, confidence: 0.7, assessment: words, reasoning_trace: `${words} The reasoning.` });

/** The current versions on a node, as the owner sees them. */
const current = (node: string) =>
  system(() =>
    rawQuery<{ label: string; origin: string; status: string }>(
      `SELECT sensitivity_label AS label, origin, status FROM assessments WHERE claim_id = $1 AND is_current ORDER BY sensitivity_label`,
      [node]
    )
  );

/** Every mirrored row of the tables a Steward's tools touch, whole: to show that nothing changed one. */
const mirroredRows = () =>
  system(async () => {
    const out: Record<string, string> = {};
    for (const table of ["claims", "claim_relationships", "claim_links", "arguments", "argument_subclaims", "claim_instances", "sources", "assessments", "argument_evaluations", "quantity_definitions"]) {
      const columns = table === "claims" ? "to_jsonb(x) - 'updated_at' - 'steward_state' - 'steward_trigger' - 'steward_requeued' - 'queue_priority'" : "to_jsonb(x)";
      const [row] = await rawQuery<{ h: string }>(
        `SELECT md5(COALESCE(string_agg(md5((${columns})::text), '' ORDER BY md5((${columns})::text)), '')) AS h FROM "${table}" x WHERE x.origin = 'mirror'`
      );
      out[table] = row!.h;
    }
    return out;
  });

const ledger = (node: string) =>
  system(() =>
    rawQuery<{ exclusion_group: string; l: string; status: string }>(
      `SELECT DISTINCT exclusion_group, sensitivity_label AS l, status FROM actions WHERE claim_id = $1 ORDER BY 1`,
      [node]
    )
  );
const inbox = (node: string) =>
  system(() =>
    rawQuery<{ l: string; trigger: string; body: string }>(
      `SELECT sensitivity_label AS l, trigger, body FROM node_messages WHERE node_id = $1 ORDER BY sensitivity_label, created_at`,
      [node]
    )
  );

/**
 * Leave this database holding no mirror at all: every mirrored row and the
 * applier's bookkeeping go, as the applier itself would remove them.
 */
async function forgetTheMirror(): Promise<void> {
  await system(async () => {
    const { withTransaction } = await import("../../src/db/client.js");
    const { replicatedTables } = await import("../../src/services/mirror-manifest.js");
    await withTransaction(async (tx) => {
      await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
      for (const table of [...replicatedTables()].reverse()) {
        await tx.query(`DELETE FROM "${table.name}" WHERE origin = 'mirror'`);
      }
      await tx.query(`TRUNCATE mirror_applied_batches, mirror_snapshot_rows, mirror_refusals, node_changes`);
    });
  });
}

beforeAll(async () => {
  setNoContextSessionForTests(null);
  // A publisher of this file's own (tests/db/urls.ts), and a mirror that
  // has followed nothing: whatever another file's feed left here is cleared,
  // as this file's is at the end.
  pubPool = new pg.Pool({ connectionString: mirrorDatabaseUrl("c"), max: 4 });
  pub = poolDb(pubPool);
  await forgetTheMirror();
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
  await seedPublicGraph();
}, 120_000);

afterAll(async () => {
  await system(async () => {
    const nodes = [...made.claims, ...Object.values(id)];
    await rawQuery(`DELETE FROM curation_requests WHERE anchor_claim_id = ANY($1::uuid[]) OR other_claim_id = ANY($1::uuid[])`, [nodes]);
    await rawQuery(`DELETE FROM reconciliation_events WHERE sensitivity_label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM action_allocations WHERE claim_id = ANY($1::uuid[])`, [nodes]);
    await rawQuery(`DELETE FROM assessment_orders WHERE claim_id = ANY($1::uuid[])`, [nodes]);
    await rawQuery(`DELETE FROM actions WHERE claim_id = ANY($1::uuid[])`, [nodes]);
    await rawQuery(`DELETE FROM audit_log WHERE sensitivity_label = ANY($1::text[])`, [[A, B, C]]);
    for (const table of ["judgment_inputs", "argument_evaluations", "assessments", "quantity_estimates", "node_messages", "steward_slots", "argument_instances", "claim_instances", "argument_subclaims", "claim_links", "claim_relationships", "arguments", "request_targets", "requests", "enqueue_events"]) {
      await rawQuery(`DELETE FROM ${table} WHERE sensitivity_label = ANY($1::text[])`, [[A, B, C]]).catch(() => undefined);
    }
    await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [made.claims]);
    await rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[]) OR (origin = 'local' AND sensitivity_label = ANY($2::text[]))`, [made.sources, [A, B, C]]);
    await rawQuery(`DELETE FROM contributors WHERE id = ANY($1::uuid[])`, [made.users]);
  }).catch((err: unknown) => console.warn("[private-on-mirror] cleanup:", err instanceof Error ? err.message : err));
  await forgetTheMirror().catch((err: unknown) => console.warn("[private-on-mirror] cleanup:", err instanceof Error ? err.message : err));
  await system(async () => {
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B, C]]);
  }).catch((err: unknown) => console.warn("[private-on-mirror] cleanup:", err instanceof Error ? err.message : err));
  await pubPool?.end();
}, 120_000);

// ---------------------------------------------------------------------------

describe("a public claim, mirrored into a deployment with private labels", () => {
  let first: ApplyResult[] = [];

  it("arrives while members at a and at b read, applied at system clearance by work that has nothing in context", async () => {
    await cut();
    // The applier is a worker: nothing in its context, so by itself it would
    // read `public` alone and could add no row. It says it is system work.
    const [synced] = await Promise.all([
      syncMirror(feed(), { trustedKeys }),
      person([A], () => rawQuery(`SELECT count(*) FROM claims`)),
      person([B], () => rawQuery(`SELECT count(*) FROM assessments_in_force`)),
    ]);
    expect(synced.refusal).toBeNull();
    first = synced.applied;
    expect(first.length).toBeGreaterThan(0);
    const rows = await system(() =>
      rawQuery<{ origin: string; l: string; steward_state: string }>(
        `SELECT origin, sensitivity_label AS l, steward_state FROM claims WHERE id = ANY($1::uuid[])`,
        [[id.parent, id.child, id.absorbed, id.survivor, id.withdrawn, id.quantity]]
      )
    );
    expect(rows).toHaveLength(6);
    // Everything it wrote is public and the mirror's, and joins no queue.
    expect(new Set(rows.map((r) => `${r.origin}/${r.l}/${r.steward_state}`))).toEqual(new Set(["mirror/public/deferred"]));
    for (const table of ["assessments", "arguments", "claim_relationships", "sources", "claim_instances", "argument_evaluations"]) {
      const labels = await system(() =>
        rawQuery<{ l: string }>(`SELECT DISTINCT sensitivity_label AS l FROM ${table} WHERE origin = 'mirror'`)
      );
      expect(labels, table).toEqual([{ l: PUBLIC_LABEL }]);
    }
    // Nothing was opened by its arrival.
    expect(await afterMirrorApplied(first)).toEqual({ versions: 0, merges: 0, withdrawals: 0, convergence: 0 });
    expect(await ledger(id.parent)).toEqual([]);
  });

  it("is read by every member with its public assessment, and the read says it is mirrored and as of when", async () => {
    const status = await mirrorStatus();
    expect(status.public_graph_as_of).toBe(first.at(-1)!.cut_at);
    expect(await publicGraphAsOf()).toBe(status.public_graph_as_of);
    for (const held of [[], [A], [B], [C]]) {
      const view = (await person(held, () => getClaimView(id.parent)))!;
      expect((view.claim as { label: string }).label).toBe(PUBLIC_LABEL);
      expect(view.mirrored).toEqual({
        public_graph_as_of: status.public_graph_as_of,
        public_page_url: `https://public.example/claims/${id.parent}`,
      });
      expect((view.versions as Array<{ label: string }>).map((v) => v.label)).toEqual([PUBLIC_LABEL]);
      expect((view.assessment as { status: string }).status).toBe("inconclusive");
    }
    // A node of the deployment's own says nothing of the kind.
    const own = await seedOwnNode(A, "A node of the deployment's own");
    expect((await person([A], () => getClaimView(own)))!.mirrored).toBeUndefined();
  });

  it("is found by the Matcher's search beside the deployment's own nodes, at the run's clearance", async () => {
    const mine = await seedOwnNode(A, "Wetland soils keep accumulating carbon, on our own cores", 101);
    const found = async (label: string) =>
      (await runAt(label, () => findSimilarClaims(JSON.parse(vec(101)) as number[], 10, { threshold: 0.9 }))).map((c) => c.id);
    expect((await found(A)).sort()).toEqual([id.child, mine].sort());
    expect(await found(C)).toContain(mine);
    // A run that does not read a sees the public node and not a's.
    expect(await found(B)).toEqual([id.child]);
    expect(await found(PUBLIC_LABEL)).toEqual([id.child]);
  });
});

// ---------------------------------------------------------------------------

describe("a version at a on a mirrored claim", () => {
  it("may be left unmade: a examines the node and leaves the public graph's judgment standing, which is recorded at a", async () => {
    const left = JSON.parse((await runAt(A, () => executeLeaveStandingTool("leave_judgment_standing", { claim_id: id.parent, reasoning: "Nothing a holds changes the public reading." })))!);
    expect(left).toMatchObject({ success: true, left_standing: [PUBLIC_LABEL], retired_own: false });
    const forA = (await person([A], () => nodeVersions(id.parent, "claim")))!;
    expect(forA.left_standing.map((e) => [e.label, e.judgments, e.open_again])).toEqual([[A, [{ label: PUBLIC_LABEL, replaced: false }], false]]);
    expect(forA.versions.map((v) => [v.label, v.in_force])).toEqual([[PUBLIC_LABEL, true]]);
    // The mirrored row is untouched, and at the node's own label there is nothing to leave standing.
    expect(await current(id.parent)).toEqual([{ label: PUBLIC_LABEL, origin: "mirror", status: "inconclusive" }]);
    const atPublic = JSON.parse((await runAt(PUBLIC_LABEL, () => executeLeaveStandingTool("leave_judgment_standing", { claim_id: id.parent, reasoning: "x" })))!);
    expect(atPublic.success).toBe(false);
    expect(atPublic.message).toContain("This node carries this run's own label, `public`");
  });

  it("is recorded beside the public one, with or without a source at a attached to the node", async () => {
    const without = await runAt(A, () => assess(id.parent));
    expect(without.success).toBe(true);
    await attachSource(id.parent, A);
    const recorded = await runAt(A, () => assess(id.parent, "supported", "With a's cores."));
    expect(recorded.success).toBe(true);
    expect(await current(id.parent)).toEqual([
      { label: A, origin: "local", status: "supported" },
      { label: PUBLIC_LABEL, origin: "mirror", status: "inconclusive" },
    ]);
    // Each reader goes by the version made with sight of the most they may read.
    const forA = (await person([A], () => nodeVersions(id.parent, "claim")))!;
    expect(forA.versions.map((v) => [v.label, v.in_force])).toEqual([[A, true], [PUBLIC_LABEL, false]]);
    expect(forA.versions[0]!.made_beside).toEqual([{ label: PUBLIC_LABEL, replaced: false }]);
    const forB = (await person([B], () => nodeVersions(id.parent, "claim")))!;
    expect(forB.versions.map((v) => v.label)).toEqual([PUBLIC_LABEL]);
  });

  it("is never one at public: the public judgment of a mirrored node is the mirrored row", async () => {
    const before = await mirroredRows();
    const refused = await runAt(PUBLIC_LABEL, () => assess(id.parent, "verified", "A local public reading."));
    expect(refused.success).toBe(false);
    expect(refused.message).toBe(await runAt(PUBLIC_LABEL, async () => publicJudgmentMessage("An assessment of it")));
    expect(refused.message).toContain("is the public graph's own, which arrives with the mirror");
    const evaluated = await runAt(PUBLIC_LABEL, () =>
      tool("evaluate_argument", { argument_id: id.argument, verdict: "certain", evaluation: `A local public evaluation: it rests on [[claim:${id.child}]].` })
    );
    expect(evaluated.success).toBe(false);
    expect(evaluated.message).toContain("An evaluation of this argument at `public` is the public graph's own");
    const estimated = await runAt(PUBLIC_LABEL, () =>
      executeKindTool(
        "update_quantity_estimate",
        { claim_id: id.quantity, estimate: { form: "point", central: 0.5 }, assessment: "A local estimate.", work: "None." },
        { role: "claim_steward", claimId: id.quantity }
      )
    );
    expect(JSON.parse(estimated!)).toMatchObject({ success: false });
    expect(estimated).toContain("belongs to the public graph");
    expect(await mirroredRows()).toEqual(before);
    expect((await current(id.parent)).filter((v) => v.label === PUBLIC_LABEL)).toEqual([
      { label: PUBLIC_LABEL, origin: "mirror", status: "inconclusive" },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("work at public on a mirrored node", () => {
  it("is not opened: no message, no slot, no ledger row, by a note, the sweep or a request to the Curator", async () => {
    await runAt(PUBLIC_LABEL, () => enqueueSteward({ claimId: id.parent, trigger: "steward_note", context: "A public note." }));
    await runAt(PUBLIC_LABEL, () => ensureAssessActions(id.parent));
    // A slot left pending by anything else is not turned into a row by the sweep either.
    await system(() => rawQuery(`UPDATE claims SET steward_state = 'pending' WHERE id = $1`, [id.child]));
    await system(() => reconcileActions());
    expect(await ledger(id.child)).toEqual([]);
    await system(() => rawQuery(`UPDATE claims SET steward_state = 'deferred' WHERE id = $1`, [id.child]));
    const curated = await runAt(PUBLIC_LABEL, () =>
      requestCuration({ anchorClaimId: id.parent, source: "steward_escalation", defect: "other", concern: "Its structure looks off." })
    );
    expect(curated).toMatchObject({ ok: false });
    expect((curated as { problem: string }).problem).toContain("belongs to the public graph and is read here through the mirror");
    expect(await ledger(id.parent)).toEqual([]);
    expect(await inbox(id.parent)).toEqual([]);
    const [row] = await system(() => rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [id.parent]));
    expect(row!.steward_state).toBe("deferred");
  });

  it("is not offered to a member, who is told why and what to do instead", async () => {
    const [who] = await system(() =>
      rawQuery<{ id: string }>(`INSERT INTO contributors (external_id, display_name) VALUES ($1, 'A member') RETURNING id`, [`pm-${tag}`])
    );
    made.users.push(who!.id);
    const atPublic = await runWithUsageContext({ label: PUBLIC_LABEL }, () => createOrder({ userId: who!.id, claimId: id.parent }));
    expect(atPublic).toMatchObject({ ok: false, code: "PUBLIC_GRAPH_NODE" });
    expect((atPublic as { message: string }).message).toBe(
      publicWorkNotDoneHereMessage(PUBLIC_LABEL, `https://public.example/claims/${id.parent}`)
    );
    expect((atPublic as { message: string }).message).toBe(
      `This node belongs to the public graph and is read here through the mirror, so its assessment at "public" is ` +
        `the public graph's own and no work is done on it here at "public". A fresh public assessment is ordered or ` +
        `funded on the public graph (https://public.example/claims/${id.parent}), which shows the public graph that ` +
        `someone asked. To have the node assessed on this deployment's own material, name a label that reads ` +
        `"public" in "label": that work records a version of its own beside the public one, and stays here.`
    );
    // The same person, naming a label they hold that reads the node's: an order for a pass at a.
    const atA = await runWithUsageContext({ label: A }, () => createOrder({ userId: who!.id, claimId: id.parent }));
    expect(atA).toMatchObject({ ok: true });
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM assessment_orders WHERE claim_id = $1`, [id.parent]))
    ).toEqual([{ l: A }]);
    await system(() => rawQuery(`DELETE FROM assessment_orders WHERE claim_id = $1`, [id.parent]));
  });

  it("is not started by a member's contribution, which is not taken and is told where to contribute (review 3)", async () => {
    const [who] = await system(() =>
      rawQuery<{ id: string }>(`INSERT INTO contributors (external_id, display_name) VALUES ($1, 'A contributing member') RETURNING id`, [`pm-c-${tag}`])
    );
    made.users.push(who!.id);
    const contribution = { claimId: id.parent, contributorId: who!.id, contributionType: "challenge", content: "A member's challenge to a mirrored claim." };
    // What POST /contributions and submit_contribution ask first, at the node's label with the member's clearance.
    const asked = await runWithUsageContext({ clearance: [PUBLIC_LABEL], label: PUBLIC_LABEL }, () => publicContributionRefusal(id.parent));
    expect(asked).toBe(
      `This node belongs to the public graph and is read here through the mirror, so its assessment at "public" is ` +
        `the public graph's own. A contribution to it at "public" would be reviewed and acted on by work at "public" ` +
        `on the node, which is not done here, so it was not taken and nothing was recorded. Contribute on the public ` +
        `graph (https://public.example/claims/${id.parent}), where the node's Steward weighs it; that shows the public ` +
        `graph what you sent. What this deployment holds about the node is weighed here by an assessment at a label ` +
        `that reads "public", which you can order or fund by naming that label.`
    );
    // The service refuses whatever calls it, and no row is written.
    const err = await caught(() => runWithUsageContext({ clearance: [PUBLIC_LABEL], label: PUBLIC_LABEL }, () => createContribution(contribution)));
    expect(err).toBeInstanceOf(PublicGraphNodeError);
    expect((err as Error).message).toBe(asked);
    expect(await system(() => rawQuery(`SELECT 1 FROM contributions WHERE claim_id = $1`, [id.parent]))).toEqual([]);
    // A node of the deployment's own takes one as before.
    const own = await seedOwnNode(A, "A node of the deployment's own that a member contributes to");
    const taken = await runWithUsageContext({ clearance: [A, PUBLIC_LABEL], label: A }, () => createContribution({ ...contribution, claimId: own }));
    expect(taken.sensitivityLabel).toBe(A);
    await system(() => rawQuery(`DELETE FROM contributions WHERE id = $1`, [taken.id]));
  });

  it("is not run: a Steward's pass at the node's own label stops before anything is sent to a model", async () => {
    const err = await caught(() =>
      runAtLabel(PUBLIC_LABEL, "a test", () => runClaimSteward({ trigger: "staleness_check", claimId: id.parent, context: "" }))
    );
    expect(err).toBeInstanceOf(PublicGraphNodeError);
    expect(await system(() => rawQuery(`SELECT 1 FROM agent_runs WHERE claim_id = $1`, [id.parent]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the public assessment replaced upstream", () => {
  it("shows the a version as made against an earlier one, and opens its reassessment at a and nowhere else", async () => {
    await pub.query(`UPDATE assessments SET is_current = false WHERE id = $1`, [id.verdict1]);
    await ins(pub, "assessments", { id: id.verdict2, claim_id: id.parent, status: "supported", confidence: 0.8, summary: "The second public reading.", reasoning_trace: "New evidence." });
    const { applied, upkeep } = await publishAndApply();
    expect(applied.at(-1)!.nodes.judged).toContain(id.parent);
    expect(await current(id.parent)).toEqual([
      { label: A, origin: "local", status: "supported" },
      { label: PUBLIC_LABEL, origin: "mirror", status: "supported" },
    ]);
    const own = (await person([A], () => nodeVersions(id.parent, "claim")))!.versions.find((v) => v.label === A)!;
    expect(own.made_beside).toEqual([{ label: PUBLIC_LABEL, replaced: true }]);
    expect(own.made_against_earlier).toBe(true);
    // The upkeep ran for the nodes the batch touched, as soon as it was in.
    expect(upkeep).toEqual({ versions: 1, merges: 0, withdrawals: 0, convergence: 0 });
    const messages = await inbox(id.parent);
    expect(messages.map((m) => [m.l, m.trigger])).toEqual([[A, "version_beside_changed"]]);
    expect(messages[0]!.body).toContain("- `public`: the version yours was made beside has been replaced by a newer one.");
    expect(await ledger(id.parent)).toEqual([{ exclusion_group: ASSESS_GROUP(id.parent, A), l: A, status: "open" }]);
    expect(
      await system(() => rawQuery<{ l: string; steward_state: string }>(`SELECT sensitivity_label AS l, steward_state FROM steward_slots WHERE claim_id = $1`, [id.parent]))
    ).toEqual([{ l: A, steward_state: "pending" }]);
    // Nothing at public: the node's own slot is where the mirror left it, and nothing ran or was paid for.
    const [row] = await system(() => rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [id.parent]));
    expect(row!.steward_state).toBe("deferred");
    expect(await system(() => rawQuery(`SELECT 1 FROM action_allocations WHERE claim_id = $1`, [id.parent]))).toEqual([]);
    expect(await system(() => rawQuery(`SELECT 1 FROM agent_runs WHERE claim_id = $1`, [id.parent]))).toEqual([]);
    // Asked once: applying nothing new opens nothing more.
    expect(await afterMirrorApplied(applied)).toMatchObject({ versions: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("one identity for a public thing", () => {
  it("lets a source the deployment recorded and the public graph's later row for the same address both stand, and reads them once", async () => {
    const mineAtA = await attachSource(id.child, A, URL_LATER);
    const [minePublic] = await system(() =>
      rawQuery<{ id: string }>(`INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'Recorded here at public', 'public') RETURNING id`, [URL_PUBLIC_LATER])
    );
    made.sources.push(minePublic!.id);
    await ins(pub, "sources", { id: id.paperLater, url: URL_LATER, title: "The public graph's record of it", raw_content: "Public text." });
    await ins(pub, "sources", { id: id.paperPublicLater, url: URL_PUBLIC_LATER, title: "The public graph's record of the other" });
    await publishAndApply();
    for (const url of [URL_LATER, URL_PUBLIC_LATER]) {
      const rows = await system(() => rawQuery<{ origin: string; l: string }>(`SELECT origin, sensitivity_label AS l FROM sources WHERE url = $1 ORDER BY origin`, [url]));
      expect(rows.map((r) => r.origin), url).toEqual(["local", "mirror"]);
    }
    // One row for the address: a's own for a run at a (what a wrote), the public graph's for everyone else.
    expect((await runAt(A, () => getOrCreateSource({ url: URL_LATER }))).id).toBe(mineAtA.source);
    expect((await runAt(B, () => getOrCreateSource({ url: URL_LATER }))).id).toBe(id.paperLater);
    expect((await runAt(C, () => getOrCreateSource({ url: URL_LATER }))).id).toBe(id.paperLater);
    expect((await runAt(PUBLIC_LABEL, () => getOrCreateSource({ url: URL_LATER }))).id).toBe(id.paperLater);
    expect((await runAt(PUBLIC_LABEL, () => getOrCreateSource({ url: URL_PUBLIC_LATER }))).id).toBe(minePublic!.id);
    expect((await runAt(B, () => getOrCreateSource({ url: URL_PUBLIC_LATER }))).id).toBe(id.paperPublicLater);
    // A read of either says how it stands to the other.
    expect(await person([A], () => sourceMirrorFacts(mineAtA.source))).toEqual({ public_graph_source_id: id.paperLater });
    expect(await person([A], () => sourceMirrorFacts(id.paperLater))).toEqual({ mirrored: { public_graph_as_of: await publicGraphAsOf() } });
    // And a's instance still points at a's own row.
    expect(
      await system(() => rawQuery<{ source_id: string }>(`SELECT source_id FROM claim_instances WHERE id = $1`, [mineAtA.instance]))
    ).toEqual([{ source_id: mineAtA.source }]);
  });

  it("lets an edge recorded at a between two public claims and the public graph's later edge both stand, listed once", async () => {
    const mine = await runAt(A, () =>
      insertRelationshipEdge({ parentId: id.parent, childId: id.other, relationType: "supports", reasoning: "Why a thinks it bears.", createdBy: "claim_steward" })
    );
    expect(mine.created).toBe(true);
    await ins(pub, "claim_relationships", { id: id.edgeLater, parent_claim_id: id.parent, child_claim_id: id.other, relation_type: "supports", reasoning: "The public graph's reason.", confidence: 0.8 });
    // And an argument's grouping of a mirrored edge, recorded at a and then by the public graph.
    await system(() =>
      rawQuery(`INSERT INTO argument_subclaims (argument_id, relationship_id, sensitivity_label) VALUES ($1, $2, $3)`, [id.argument, id.edgeChild, A])
    ).then(
      () => undefined,
      // The public graph already groups that edge: the row of a's own beside it is what is under test.
      (err: unknown) => {
        throw err;
      }
    );
    await publishAndApply();
    const edges = await system(() =>
      rawQuery<{ id: string; origin: string; l: string }>(
        `SELECT id, origin, sensitivity_label AS l FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = $2 ORDER BY origin`,
        [id.parent, id.other]
      )
    );
    expect(edges).toEqual([
      { id: mine.id, origin: "local", l: A },
      { id: id.edgeLater, origin: "mirror", l: PUBLIC_LABEL },
    ]);
    expect(
      await system(() => rawQuery<{ origin: string }>(`SELECT origin FROM argument_subclaims WHERE argument_id = $1 AND relationship_id = $2 ORDER BY origin`, [id.argument, id.edgeChild]))
    ).toEqual([{ origin: "local" }, { origin: "mirror" }]);
    // A reader at a is shown the edge once: the public graph's row, and what a wrote beside it.
    const forA = (await person([A], () => getClaimView(id.parent, { include: ["subclaims"] })))!;
    const listed = (forA.subclaims as Array<{ id: string; edge_id: string; reasoning: string; also_recorded_here?: { edge_id: string; reasoning: string } }>).filter((s) => s.id === id.other);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      edge_id: id.edgeLater,
      reasoning: "The public graph's reason.",
      also_recorded_here: { edge_id: mine.id, reasoning: "Why a thinks it bears." },
    });
    // A reader who does not read a sees the public graph's edge and no sign of a's.
    const forB = (await person([B], () => getClaimView(id.parent, { include: ["subclaims"] })))!;
    const publicOnly = (forB.subclaims as Array<Record<string, unknown>>).filter((s) => s.id === id.other);
    expect(publicOnly).toHaveLength(1);
    expect(publicOnly[0]!.also_recorded_here).toBeUndefined();
    // An edge the public graph already holds is the edge: a run that records it again is given that one.
    const again = await runAt(B, () =>
      insertRelationshipEdge({ parentId: id.parent, childId: id.child, relationType: "requires", reasoning: "Why b thinks so.", createdBy: "claim_steward" })
    );
    expect(again).toEqual({ id: id.edgeChild, created: false });
  });

  it("retires, and does not delete, a judgment someone recorded at a mirrored node's own label, so that the public graph's applies", async () => {
    // Nothing in the application writes one; a row written past it is the case.
    const stray = randomUUID();
    await system(async () => {
      await rawQuery(`SELECT set_config('minerval.mirror_applier', 'off', false)`);
      await rawQuery(
        `INSERT INTO assessments (id, claim_id, status, confidence, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, $2, 'verified', 0.9, 'A stray local public verdict.', true, 'public')`,
        [stray, id.child]
      );
    });
    await ins(pub, "assessments", { id: randomUUID(), claim_id: id.child, status: "supported", confidence: 0.7, summary: "The public reading of the child.", reasoning_trace: "Reasons." });
    const { applied } = await publishAndApply();
    expect(applied.at(-1)!.notes.local_judgments_retired).toEqual([{ table: "assessments", count: 1, ids: [stray] }]);
    expect(await current(id.child)).toEqual([{ label: PUBLIC_LABEL, origin: "mirror", status: "supported" }]);
    expect(await system(() => rawQuery<{ is_current: boolean }>(`SELECT is_current FROM assessments WHERE id = $1`, [stray]))).toEqual([{ is_current: false }]);
    await system(() => rawQuery(`DELETE FROM assessments WHERE id = $1`, [stray]));
  });
});

// ---------------------------------------------------------------------------

describe("the Steward's tools on a mirrored node, for a run at a", () => {
  /** What each tool did, as the table in docs/mirror.md has it. */
  const outcome: Record<string, "at the run's label" | "refused">= {};
  let ownInstance = "";
  let ownArgument = "";
  const refusal = () => runAt(A, async () => mirroredRowMessage());

  it("write at a where they add something, and refuse with one message where they would change what the public graph holds", async () => {
    const before = await mirroredRows();
    const say = await refusal();
    const expectRefused = (name: string, answer: ToolAnswer, what?: string) => {
      expect(answer.success, `${name}: ${answer.message}`).toBe(false);
      // One message, whichever guard would have fired: it differs only in naming what would have changed.
      expect(answer.message.startsWith("Not changed. What this would change"), `${name}: ${answer.message}`).toBe(true);
      expect(answer.message.endsWith(say.slice(say.indexOf("belongs to the public graph"))), `${name}: ${answer.message}`).toBe(true);
      if (what) expect(answer.message).toContain(`(${what})`);
      outcome[name] = "refused";
    };
    const expectWritten = (name: string, answer: ToolAnswer) => {
      expect(answer.success, `${name}: ${answer.message}`).toBe(true);
      outcome[name] = "at the run's label";
    };

    await runAt(A, async () => {
      // What would change the node itself.
      expectRefused("update_canonical_form", await tool("update_canonical_form", { claim_id: id.parent, new_text: "A wording from a.", reasoning: "It reads better." }), "the node's wording and type");
      expectRefused("set_claim_domains", await tool("set_claim_domains", { claim_id: id.parent, domains: ["earth-science"], reasoning: "Its field." }), "the node's domains");
      // What would change a row recorded on it by the public graph.
      expectRefused("write_argument", await tool("write_argument", { argument_id: id.argument, content: `A rewriting from a: because [[claim:${id.child}]], the stock grows.` }));
      expectRefused("revise_argument", await tool("revise_argument", { argument_id: id.argument, name: "A name from a", reasoning: "Clearer." }));
      expectRefused("update_claim_instance", await tool("update_claim_instance", { claim_id: id.parent, instance_id: id.instance, stance: "denies", reasoning: "It reads otherwise." }));
      expectRefused("detach_claim_instance", await tool("detach_claim_instance", { claim_id: id.parent, instance_id: id.instance, reason: "Not about this." }));
      expectRefused("ungroup_subclaim", await tool("ungroup_subclaim", { argument_id: id.argument, child_id: id.child, reasoning: "It is not a premise of it." }));
      expectRefused("set_instance_order", await tool("set_instance_order", { claim_id: id.parent, instance_ids: [id.instance], reasoning: "The page should lead with it." }));

      // What the label holds differently for its own readers is a row of its own over the public graph's row
      // (services/overlay-service.ts): its importance for the node, and an argument or an edge it sets aside.
      // The mirrored rows are untouched, which the comparison below holds to the byte.
      const importance = await tool("set_claim_importance", { claim_id: id.parent, importance: 0.9, reasoning: "It matters to us." });
      expectWritten("set_claim_importance", importance);
      expect(importance.message).toContain(`Importance of ${id.parent} is 0.9 at \`${A}\`.`);
      expect(importance.message).toContain("The node is at the public graph, which keeps its own value");
      const retired = await tool("retire_argument", { argument_id: id.argument, reasoning: "It no longer belongs." });
      expectWritten("retire_argument", retired);
      expect(retired.message).toContain(`Set aside at \`${A}\`: argument`);
      expect(retired.message).toContain("It is at the public graph, which this run reads and does not change");
      const removed = await tool("remove_subclaim_edge", { parent_id: id.parent, child_id: id.child, relation: "requires", reasoning: "It no longer bears." });
      expectWritten("remove_subclaim_edge", removed);
      expect(removed.message).toContain(`Set aside at \`${A}\`: the requires edge`);
      const retyped = await tool("set_edge_relation", { parent_id: id.parent, child_id: id.child, relation: "supports", from_relation: "requires", reasoning: "It supports, no more." });
      expectWritten("set_edge_relation", retyped);
      expect(retyped.message).toContain(`At \`${A}\` the edge from ${id.parent} to ${id.child} is now supports, a row of its own.`);
      // Each is taken back, so the cases after this one meet the node as the public graph has it.
      expectWritten("remove_subclaim_edge (its own)", await tool("remove_subclaim_edge", { parent_id: id.parent, child_id: id.child, relation: "supports", reasoning: "On reflection." }));
      for (const input of [{ claim_id: id.parent }, { claim_id: id.parent, child_id: id.child, relation: "requires" }, { claim_id: id.parent, argument_id: id.argument }]) {
        expectWritten("restore_below", await tool("restore_below", { ...input, reasoning: "The public graph has it right." }));
      }

      // What adds a row of the run's own.
      // The run was given the address it records a source at (given-addresses.ts).
      const recorded = await tool("record_claim_instance", { claim_id: id.parent, url: await asGiven(`https://intranet.example/${tag}/field-notes`), verbatim_text: "Our cores show it.", stance: "affirms" });
      expectWritten("record_claim_instance", recorded);
      expectWritten("add_argument", await tool("add_argument", { claim_id: id.parent, name: "From our own cores", stance: "for", description: "Our cores show continued accumulation." }));
      expectWritten("add_relationship_edge", await tool("add_relationship_edge", { parent_id: id.parent, child_id: id.survivor, relation: "supports", reasoning: "Marsh soils are one case." }));
      expectWritten("add_related_claim", await tool("add_related_claim", { claim_id: id.parent, other_claim_id: id.other, kind: "related", reasoning: "The upland comparison." }));
      expectWritten("log_stewardship_decision", await tool("log_stewardship_decision", { claim_id: id.parent, action_taken: "no_change", reasoning: "Looked, and the version at a stands." }));
      expectWritten("escalate_to_curator", await tool("escalate_to_curator", { claim_id: id.parent, defect: "duplicate", concern: "Two of our nodes under it look like one." }));
      expectWritten("record_argument_instance", await tool("record_argument_instance", { argument_id: id.argument, url: `https://intranet.example/${tag}/field-notes`, verbatim_text: "Our cores show the soil still accumulating.", stance: "advances", reading: "full" }));
      expectWritten("notify_steward", await tool("notify_steward", { claim_id: id.other, target_ids: [id.parent], message: "Our upland cores bear on this." }));
      // A mirrored node it thinks is wrong is a request, which stays at the run's label.
      const filed = JSON.parse(
        (await executeKindTool(
          "file_request",
          { ask: "Reword the node: it says per hectare and means per hectare of soil surface.", why: "The public wording is ambiguous.", satisfied_by: "A reworded node on the public graph.", claim_ids: [id.parent] },
          { role: "claim_steward", claimId: id.parent }
        ))!
      ) as ToolAnswer;
      expectWritten("file_request", filed);
      expectWritten("update_claim_assessment", await assess(id.parent, "supported", "With a's cores, against the second public reading."));
      expectWritten("evaluate_argument", await tool("evaluate_argument", { argument_id: id.argument, verdict: "likely", evaluation: `With a's cores [[claim:${id.child}]] holds, and the rest follows.` }));
    });

    const own = await system(() =>
      rawQuery<{ instance: string; argument: string }>(
        `SELECT (SELECT id FROM claim_instances WHERE claim_id = $1 AND sensitivity_label = $2 AND verbatim_text = 'Our cores show it.') AS instance,
                (SELECT id FROM arguments WHERE claim_id = $1 AND sensitivity_label = $2) AS argument`,
        [id.parent, A]
      )
    );
    ownInstance = own[0]!.instance;
    ownArgument = own[0]!.argument;
    // Its own rows are its own to change, on a mirrored node as anywhere.
    await runAt(A, async () => {
      expectWritten("update_claim_instance (its own)", await tool("update_claim_instance", { claim_id: id.parent, instance_id: ownInstance, stance: "mentions", reasoning: "On a second reading." }));
      expectWritten("write_argument (its own)", await tool("write_argument", { argument_id: ownArgument, content: "Our cores show the soil still accumulating after two centuries, so the stock per hectare keeps growing." }));
    });

    // Everything it wrote is at a, and no mirrored row is a byte different.
    for (const table of ["claim_instances", "arguments", "claim_relationships", "claim_links", "audit_log", "curation_requests"]) {
      const column = table === "claim_links" ? "claim_a_id = $1 OR claim_b_id = $1" : table === "claim_relationships" ? "parent_claim_id = $1" : table === "curation_requests" ? "anchor_claim_id = $1" : "claim_id = $1";
      const labels = await system(() =>
        rawQuery<{ l: string }>(
          `SELECT DISTINCT sensitivity_label AS l FROM ${table} WHERE (${column})${["audit_log", "curation_requests"].includes(table) ? "" : " AND origin = 'local'"} ORDER BY 1`,
          [id.parent]
        )
      );
      expect(labels, table).toEqual([{ l: A }]);
    }
    expect(await mirroredRows()).toEqual(before);
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT DISTINCT r.sensitivity_label AS l FROM requests r JOIN request_targets t ON t.request_id = r.id WHERE t.claim_id = $1`, [id.parent]))
    ).toEqual([{ l: A }]);
    expect(outcome).toEqual({
      update_canonical_form: "refused",
      set_claim_domains: "refused",
      write_argument: "refused",
      revise_argument: "refused",
      update_claim_instance: "refused",
      detach_claim_instance: "refused",
      ungroup_subclaim: "refused",
      set_instance_order: "refused",
      set_claim_importance: "at the run's label",
      retire_argument: "at the run's label",
      remove_subclaim_edge: "at the run's label",
      set_edge_relation: "at the run's label",
      "remove_subclaim_edge (its own)": "at the run's label",
      restore_below: "at the run's label",
      record_claim_instance: "at the run's label",
      add_argument: "at the run's label",
      add_relationship_edge: "at the run's label",
      add_related_claim: "at the run's label",
      log_stewardship_decision: "at the run's label",
      escalate_to_curator: "at the run's label",
      record_argument_instance: "at the run's label",
      notify_steward: "at the run's label",
      file_request: "at the run's label",
      update_claim_assessment: "at the run's label",
      evaluate_argument: "at the run's label",
      "update_claim_instance (its own)": "at the run's label",
      "write_argument (its own)": "at the run's label",
    });
  });

  it("refuse the same way for a mirrored quantity, and record a's estimate beside the public graph's", async () => {
    const before = await mirroredRows();
    const kind = (name: string, input: Record<string, unknown>) =>
      runAt(A, async () => JSON.parse((await executeKindTool(name, input, { role: "claim_steward", claimId: id.quantity }))!) as ToolAnswer);
    const redefined = await kind("set_quantity_definition", { claim_id: id.quantity, measures: "carbon in the top two metres", unit: { kind: "proportion" } });
    expect(redefined.success).toBe(false);
    expect(redefined.message).toContain("belongs to the public graph and is read here through the mirror");
    await attachSource(id.quantity, A);
    const estimated = await kind("update_quantity_estimate", {
      claim_id: id.quantity,
      estimate: { form: "point", central: 0.4 },
      assessment: "From a's cores.",
      work: "Bulk density times carbon fraction, per core.",
    });
    expect(estimated.success, estimated.message).toBe(true);
    expect(
      await system(() => rawQuery<{ l: string; origin: string }>(`SELECT sensitivity_label AS l, origin FROM quantity_estimates WHERE claim_id = $1 AND is_current`, [id.quantity]))
    ).toEqual([{ l: A, origin: "local" }]);
    expect(await mirroredRows()).toEqual(before);
  });

  it("add a subclaim under a mirrored node, and a parent above one, as nodes and edges at a (review 3: add_decomposition_edge, add_parent_claim)", async () => {
    const before = await mirroredRows();
    const publicLedgerBefore = (await ledger(id.parent)).filter((r) => r.l === PUBLIC_LABEL);
    const publicInboxBefore = (await inbox(id.parent)).filter((m) => m.l === PUBLIC_LABEL);
    const under = await runAt(A, () =>
      tool("add_decomposition_edge", {
        parent_id: id.parent,
        child_text: text("A-ONLY: the partner's cores show accumulation continuing"),
        relation: "requires",
        reasoning: "What a's cores add.",
        importance: 0.6,
      })
    );
    expect(under.success, under.message).toBe(true);
    const above = await runAt(A, () =>
      tool("add_parent_claim", {
        claim_id: id.parent,
        parent_text: text("A-ONLY: the partner's wetland program stores more carbon than its forestry program"),
        relation: "requires",
        reasoning: "What a's program rests on.",
      })
    );
    expect(above.success, above.message).toBe(true);
    const minted = await system(() =>
      rawQuery<{ id: string; l: string; origin: string; role: string; edge_l: string; edge_origin: string }>(
        `SELECT c.id, c.sensitivity_label AS l, c.origin,
                CASE WHEN r.parent_claim_id = $1 THEN 'under' ELSE 'above' END AS role,
                r.sensitivity_label AS edge_l, r.origin AS edge_origin
           FROM claim_relationships r
           JOIN claims c ON c.id = CASE WHEN r.parent_claim_id = $1 THEN r.child_claim_id ELSE r.parent_claim_id END
          WHERE (r.parent_claim_id = $1 OR r.child_claim_id = $1) AND c.text LIKE 'A-ONLY: the partner''s%' ORDER BY role`,
        [id.parent]
      )
    );
    expect(minted.map(({ id: _id, ...rest }) => rest)).toEqual([
      { l: A, origin: "local", role: "above", edge_l: A, edge_origin: "local" },
      { l: A, origin: "local", role: "under", edge_l: A, edge_origin: "local" },
    ]);
    made.claims.push(...minted.map((m) => m.id));
    // Nothing the public graph holds changed, and a reader of public alone is given neither node nor edge.
    expect(await mirroredRows()).toEqual(before);
    expect(
      await person([PUBLIC_LABEL], () =>
        rawQuery(
          `SELECT 1 FROM claims WHERE id = ANY($1::uuid[]) UNION ALL
           SELECT 1 FROM claim_relationships WHERE parent_claim_id = ANY($1::uuid[]) OR child_claim_id = ANY($1::uuid[])`,
          [minted.map((m) => m.id)]
        )
      )
    ).toEqual([]);
    // No work at public was opened on the mirrored node by either.
    expect((await ledger(id.parent)).filter((r) => r.l === PUBLIC_LABEL)).toEqual(publicLedgerBefore);
    expect((await inbox(id.parent)).filter((m) => m.l === PUBLIC_LABEL)).toEqual(publicInboxBefore);
  });

  it("record a's cut of a mirrored quantity, which stands beside the public graph's later cut for the claim and never stops the mirror (review 3, finding 2)", async () => {
    const kind = (name: string, input: Record<string, unknown>) =>
      runAt(A, async () => JSON.parse((await executeKindTool(name, input, { role: "claim_steward", claimId: id.other }))!) as ToolAnswer);
    const cutInput = { claim_id: id.other, quantity_id: id.quantity, direction: "above", value: 2 };
    const recorded = await kind("record_cut", cutInput);
    expect(recorded.success, recorded.message).toBe(true);
    const rows = () =>
      system(() =>
        rawQuery<{ origin: string; l: string; value: number }>(
          `SELECT origin, sensitivity_label AS l, value::float8 AS value FROM quantity_cuts WHERE claim_id = $1 ORDER BY origin`,
          [id.other]
        )
      );
    expect(await rows()).toEqual([{ origin: "local", l: A, value: 2 }]);

    // The public graph records its own cut for that claim, and then
    // something else changes: both batches apply.
    await ins(pub, "quantity_cuts", { claim_id: id.other, quantity_id: id.quantity, direction: "above", value: 0.25, created_by: "claim_steward" });
    await publishAndApply();
    expect(await rows()).toEqual([
      { origin: "local", l: A, value: 2 },
      { origin: "mirror", l: PUBLIC_LABEL, value: 0.25 },
    ]);
    const reworded = text("Carbon stored per hectare of coastal wetland soil");
    await pub.query(`UPDATE claims SET text = $2, updated_at = now() WHERE id = $1`, [id.quantity, reworded]);
    await publishAndApply();
    expect((await system(() => rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [id.quantity])))[0]!.text).toBe(reworded);
    const status = await person([PUBLIC_LABEL], () => mirrorStatus());
    expect(status.last_refusal).toBeNull();

    // A read shows one cut for the claim: a's own to work at a, the public
    // graph's to everyone else.
    const cutsRead = async () => {
      const detail = await getQuantityDetail(id.quantity);
      return { listed: detail.cuts.filter((c) => c.id === id.other).map((c) => Number(c.value)), of: Number((await getThresholdOf(id.other))?.value) };
    };
    expect(await runAt(A, cutsRead)).toEqual({ listed: [2], of: 2 });
    expect(await person([PUBLIC_LABEL], cutsRead)).toEqual({ listed: [0.25], of: 0.25 });
    expect(await runAt(B, cutsRead)).toEqual({ listed: [0.25], of: 0.25 });

    // The label's cut is its own row beside the public graph's, and stays its own to revise: its readers go by
    // it, and a read gives the public graph's beside it as what it diverges from.
    const again = await kind("record_cut", { ...cutInput, value: 3 });
    expect(again.success, again.message).toBe(true);
    expect(await rows()).toEqual([
      { origin: "local", l: A, value: 3 },
      { origin: "mirror", l: PUBLIC_LABEL, value: 0.25 },
    ]);
    expect(await runAt(A, () => getThresholdOf(id.other))).toMatchObject({ value: 3, label: A, below: [{ label: PUBLIC_LABEL, value: 0.25 }] });
    expect(await runAt(B, cutsRead)).toEqual({ listed: [0.25], of: 0.25 });
  });

  it("leaves no key on a replicated table that a row at a private label could hold against a mirrored row", async () => {
    // Every unique index on a replicated table either ends with origin, is
    // the row's own id, or is the one current judgment at a label, where a
    // mirrored row is at public and a private row never is.
    const withoutOrigin = await system(() =>
      rawQuery<{ tbl: string; def: string }>(
        `SELECT t.relname AS tbl, pg_get_indexdef(x.indexrelid) AS def
           FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = current_schema()
          WHERE x.indisunique AND t.relname = ANY($1) AND pg_get_indexdef(x.indexrelid) !~ 'origin'`,
        [replicatedTables().map((t) => t.name)]
      )
    );
    const other = withoutOrigin.filter((i) => !/\(id\)$/.test(i.def) && !/_current_at_label .*, sensitivity_label\) WHERE \(is_current = true\)$/.test(i.def));
    expect(other).toEqual([]);
  });

  it("tells a member only that a row could not be written when the database refuses a batch, and the operator which", async () => {
    await system(() =>
      rawQuery(
        `INSERT INTO mirror_refusals (sequence, code, message) VALUES (999999, 'row_refused', 'Batch 999999 was not applied: the database refused one of its rows (table quantity_cuts): Key (claim_id)=(${id.other}) already exists.')`
      )
    );
    try {
      const member = await person([PUBLIC_LABEL], () => mirrorStatus());
      expect(member.last_refusal).toMatchObject({ code: "row_refused", message: ROW_REFUSAL_FOR_MEMBERS });
      expect(JSON.stringify(member)).not.toContain(id.other);
      const operator = await system(() => mirrorStatus(undefined, { detail: true }));
      expect(operator.last_refusal!.message).toContain(id.other);
    } finally {
      await system(() => rawQuery(`DELETE FROM mirror_refusals WHERE sequence = 999999`));
    }
  });

  it("are refused by the database with the same answer when a write reaches a mirrored row without asking first", async () => {
    for (const statement of [
      `UPDATE claims SET text = 'Changed from a' WHERE id = $1`,
      `UPDATE claims SET importance = 0.9 WHERE id = $1`,
      `DELETE FROM claims WHERE id = $1`,
    ]) {
      for (const label of [A, PUBLIC_LABEL]) {
        const err = await caught(() => runAt(label, () => rawQuery(statement, [id.parent])));
        expect(sqlState(err), `${label}: ${statement}`).toBe("MIR01");
      }
    }
    // A note to its Steward at public is a pass nobody here runs; at a it is a note at a.
    const noted = await runAt(PUBLIC_LABEL, () =>
      tool("notify_steward", { claim_id: id.other, target_ids: [id.parent], message: "Please look again." })
    );
    expect(JSON.stringify(noted)).toContain("no pass on it at `public` is opened, paid for or run in this deployment");
    expect((await inbox(id.parent)).filter((m) => m.l === PUBLIC_LABEL)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the monitor's sweep on a mirrored node (review 3, finding 1)", () => {
  it("opens no audit at public of the public graph's judgment, and says nothing there of a's version", async () => {
    // The mirrored node's public judgment is the public graph's. a holds a settled version and instances both ways.
    await pub.query(`UPDATE claims SET importance = 900 WHERE id = $1`, [id.other]);
    await ins(pub, "assessments", { id: randomUUID(), claim_id: id.other, status: "verified", confidence: 0.99, summary: "The public graph is sure.", reasoning_trace: "Reasons." });
    for (const stance of ["affirms", "denies"]) {
      const sourceId = randomUUID();
      await ins(pub, "sources", { id: sourceId, url: `https://journal.example/${tag}/upland-${stance}`, title: `Upland ${stance}` });
      await ins(pub, "claim_instances", { id: randomUUID(), claim_id: id.other, source_id: sourceId, verbatim_text: "A public passage.", stance });
    }
    await publishAndApply();
    const { flagMonitorCandidates } = await import("../../src/workers/monitor-scheduler.js");
    const result = await flagMonitorCandidates({ maxFlags: 100 });
    // Settled, with instances both ways from two sources: a candidate anywhere else. Here it is the public graph's to audit.
    expect(result.flags.filter((f) => f.claimId === id.other)).toEqual([]);
    expect(await system(() => rawQuery(`SELECT 1 FROM audit_runs WHERE context LIKE '%' || $1 || '%'`, [id.other]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("what the public graph changes on a node a version at a rests on", () => {
  it("is in the Steward's note of what changed since its version, at its next pass", async () => {
    // The version at a on the parent was recorded just above. Now the public graph moves.
    await pub.query(`UPDATE claims SET text = $2 WHERE id = $1`, [id.parent, text("Coastal wetlands hold more carbon per hectare than upland forest")]);
    await pub.query(`UPDATE claims SET text = $2 WHERE id = $1`, [id.child, text("Wetland soils go on accumulating carbon for centuries")]);
    await ins(pub, "arguments", { id: id.argumentLater, claim_id: id.parent, name: "From burial rates", stance: "for", content: "Burial outpaces decay.", created_by: "claim_steward" });
    await pub.query(`UPDATE arguments SET content = 'Because the soil keeps accumulating, the stock keeps growing.' WHERE id = $1`, [id.argument]);
    await publishAndApply();
    const note = await runAt(A, () => loadChangesBelowNote(id.parent, "claim"));
    expect(note).toContain(`What the public graph has changed, as the mirror brought it, since the version at \`${A}\` was recorded on`);
    expect(note).toContain("This node was reworded (1):");
    expect(note).toContain(`It read: "${text("Coastal wetlands store more carbon per hectare than upland forest")}" It now reads: "${text("Coastal wetlands hold more carbon per hectare than upland forest")}"`);
    expect(note).toContain("Arguments on this node (2):");
    expect(note).toContain(`${id.argumentLater} "From burial rates" was added`);
    expect(note).toContain(`${id.argument} "From soil accumulation" was rewritten`);
    expect(note).toContain("Nodes under it reworded (1):");
    expect(note).toContain(`It read: "${text("Wetland soils accumulate carbon for centuries without saturating")}"`);
    // It is for the label that judged the node: a run with no version of its own is told nothing of the kind.
    expect(await runAt(B, () => loadChangesBelowNote(id.parent, "claim"))).toBe("");
    // The rows the applier wrote are the public graph's own words and carry the public label. (A change this
    // deployment's own work makes on a node of its own is written at that node's label, with no batch.)
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT DISTINCT sensitivity_label AS l FROM node_changes WHERE sequence IS NOT NULL`))
    ).toEqual([{ l: PUBLIC_LABEL }]);
  });
});

// ---------------------------------------------------------------------------

describe("a merge and a withdrawal upstream, under private versions", () => {
  let resting = "";
  let restingOnWithdrawn = "";

  beforeAll(async () => {
    // a has its own version on the node the public graph will merge away, and a node of its own that rests on it.
    await attachSource(id.absorbed, A);
    expect((await runAt(A, () => assess(id.absorbed, "doubtful", "a's cores say otherwise for marshes."))).success).toBe(true);
    resting = await seedOwnNode(A, "Our marsh restoration will keep storing carbon");
    await runAt(A, () => insertRelationshipEdge({ parentId: resting, childId: id.absorbed, relationType: "requires", reasoning: "It rests on the marsh claim.", createdBy: "claim_steward" }));
    // And the same on a node the public graph will delete.
    await attachSource(id.withdrawn, A);
    expect((await runAt(A, () => assess(id.withdrawn, "supported", "a's view of the claim soon gone."))).success).toBe(true);
    restingOnWithdrawn = await seedOwnNode(A, "A node of ours that rests on a claim soon gone");
    await runAt(A, () => insertRelationshipEdge({ parentId: restingOnWithdrawn, childId: id.withdrawn, relationType: "supports", reasoning: "It leans on it.", createdBy: "claim_steward" }));
  });

  it("leaves what a recorded on the merged node where it was, and tells the Stewards at a, on the node it was merged into and above", async () => {
    const privateBefore = await system(() =>
      rawQuery<{ n: number }>(
        `SELECT (SELECT count(*) FROM assessments WHERE claim_id = $1 AND origin = 'local')
              + (SELECT count(*) FROM claim_instances WHERE claim_id = $1 AND origin = 'local')
              + (SELECT count(*) FROM claim_relationships WHERE child_claim_id = $1 AND origin = 'local') AS n`,
        [id.absorbed]
      )
    );
    await pub.query(`UPDATE claims SET state = 'merged', merged_into = $2 WHERE id = $1`, [id.absorbed, id.survivor]);
    await pub.query(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [id.absorbed]);
    const { applied, upkeep } = await publishAndApply();
    expect(applied.at(-1)!.nodes.merged).toEqual([{ claim_id: id.absorbed, merged_into: id.survivor }]);
    expect(applied.at(-1)!.notes.merged_with_local_rows!.count).toBe(1);
    // Nothing private was deleted or moved.
    expect(
      await system(() =>
        rawQuery<{ n: number }>(
          `SELECT (SELECT count(*) FROM assessments WHERE claim_id = $1 AND origin = 'local')
                + (SELECT count(*) FROM claim_instances WHERE claim_id = $1 AND origin = 'local')
                + (SELECT count(*) FROM claim_relationships WHERE child_claim_id = $1 AND origin = 'local') AS n`,
          [id.absorbed]
        )
      )
    ).toEqual(privateBefore);
    expect((await current(id.absorbed)).map((v) => [v.label, v.origin])).toEqual([[A, "local"]]);
    // A read of the merged node gives the node it was merged into, and says so.
    const view = (await person([A], () => getClaimView(id.absorbed)))!;
    expect((view.claim as { id: string }).id).toBe(id.survivor);
    expect(view.resolved_from).toBeDefined();
    // A pass at a is opened on the node it was merged into, and on a's node above it. Nowhere else.
    expect(upkeep).toMatchObject({ merges: 2 });
    const onSurvivor = await inbox(id.survivor);
    expect(onSurvivor.map((m) => [m.l, m.trigger])).toEqual([[A, "public_graph_changed"]]);
    expect(onSurvivor[0]!.body).toContain(`The public graph has merged another node into this one: ${id.absorbed} "${text("Tidal marsh soil keeps accumulating carbon over centuries")}"`);
    expect(onSurvivor[0]!.body).toContain(`- A version of its judgment at \`${A}\`, recorded`);
    expect(onSurvivor[0]!.body).toContain(`doubtful. Its summary: "a's cores say otherwise for marshes."`);
    expect(onSurvivor[0]!.body).toContain("- Sources attached at this label: ");
    expect(await ledger(id.survivor)).toEqual([{ exclusion_group: ASSESS_GROUP(id.survivor, A), l: A, status: "open" }]);
    const above = await inbox(resting);
    expect(above.map((m) => [m.l, m.trigger])).toEqual([[A, "public_graph_changed"]]);
    expect(above[0]!.body).toContain(`A node under this one has been merged by the public graph: ${id.absorbed}`);
    expect(above[0]!.body).toContain(`is now part of ${id.survivor}`);
    // b, which reads none of it, is told nothing.
    expect(await person([B], () => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = ANY($1::uuid[])`, [[id.survivor, resting]]))).toEqual([]);
    // Told once.
    expect(await afterMirrorApplied(applied)).toMatchObject({ merges: 0 });
  });

  it("keeps a withdrawn node with what a recorded on it, shows it as withdrawn, and tells the Steward of a's node that rests on it", async () => {
    // a also evaluated the public graph's argument on that node, and read the public graph's source for it.
    const [mineOnTheirs] = await system(() =>
      rawQuery<{ evaluation: string; instance: string }>(
        `WITH e AS (INSERT INTO argument_evaluations (argument_id, verdict, content, sensitivity_label)
                    VALUES ($1, 'slight', 'a''s evaluation of the public argument.', $3) RETURNING id),
              i AS (INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, sensitivity_label)
                    VALUES ($4, $2, 'a''s reading of the public paper.', 'affirms', $3) RETURNING id)
         SELECT e.id AS evaluation, i.id AS instance FROM e, i`,
        [id.argumentWithdrawn, id.paperWithdrawn, A, restingOnWithdrawn]
      )
    );
    await pub.query(`DELETE FROM claims WHERE id = $1`, [id.withdrawn]);
    await pub.query(`DELETE FROM sources WHERE id = $1`, [id.paperWithdrawn]);
    const { applied, upkeep } = await publishAndApply();
    // The argument and the source went upstream, and are kept here with what a recorded on them.
    expect(applied.at(-1)!.notes.kept_rows!.map((k) => [k.table, k.count]).sort()).toEqual([["arguments", 1], ["sources", 1]]);
    expect(
      await system(() => rawQuery<{ retired: boolean; reason: string }>(`SELECT retired_at IS NOT NULL AS retired, retired_reason AS reason FROM arguments WHERE id = $1`, [id.argumentWithdrawn]))
    ).toEqual([{ retired: true, reason: "Withdrawn by the public graph." }]);
    expect(await system(() => rawQuery(`SELECT 1 FROM argument_evaluations WHERE id = $1`, [mineOnTheirs!.evaluation]))).toHaveLength(1);
    expect(await system(() => rawQuery(`SELECT 1 FROM claim_instances WHERE id = $1`, [mineOnTheirs!.instance]))).toHaveLength(1);
    expect(await system(() => rawQuery(`SELECT 1 FROM sources WHERE id = $1 AND origin = 'mirror'`, [id.paperWithdrawn]))).toHaveLength(1);
    expect(applied.at(-1)!.nodes.withdrawn).toEqual([id.withdrawn]);
    expect(applied.at(-1)!.notes.kept_claims!.count).toBe(1);
    const [row] = await system(() => rawQuery<{ state: string; origin: string }>(`SELECT state, origin FROM claims WHERE id = $1`, [id.withdrawn]));
    expect(row).toEqual({ state: "deprecated", origin: "mirror" });
    // The public graph's judgment went with it; a's stands, and is shown as made beside one that is gone.
    expect((await current(id.withdrawn)).map((v) => [v.label, v.origin, v.status])).toEqual([[A, "local", "supported"]]);
    const own = (await person([A], () => nodeVersions(id.withdrawn, "claim")))!.versions.find((v) => v.label === A)!;
    expect(own.made_beside).toEqual([{ label: PUBLIC_LABEL, replaced: true }]);
    const view = (await person([A], () => getClaimView(id.withdrawn)))!;
    expect((view.claim as { state: string }).state).toBe("deprecated");
    expect(view.mirrored).toMatchObject({ withdrawn_as_of: applied.at(-1)!.cut_at });
    // No work is opened on a node that is not active; the node above it is told, at a.
    expect(upkeep).toMatchObject({ withdrawals: 1, versions: 0 });
    expect(await ledger(id.withdrawn)).toEqual([]);
    const above = await inbox(restingOnWithdrawn);
    expect(above.map((m) => [m.l, m.trigger])).toEqual([[A, "public_graph_changed"]]);
    expect(above[0]!.body).toContain(`A node under this one has been withdrawn by the public graph: ${id.withdrawn}`);
    expect(await ledger(restingOnWithdrawn)).toEqual([{ exclusion_group: ASSESS_GROUP(restingOnWithdrawn, A), l: A, status: "open" }]);
  });
});

// ---------------------------------------------------------------------------

describe("a node of the deployment's own that the public graph later states", () => {
  let mine = "";
  let mineSource = { source: "", instance: "" };

  it("is put to the Curator at its own label when the public node arrives", async () => {
    mine = await seedOwnNode(A, "Seagrass meadows bury carbon faster than tidal marsh", 110);
    mineSource = await attachSource(mine, A);
    expect((await runAt(A, () => assess(mine, "supported", "a's own reading of its own node."))).success).toBe(true);
    await runAt(A, () => tool("add_argument", { claim_id: mine, name: "From our transects", stance: "for", description: "Our transects show it." }));
    await ins(pub, "claims", { id: id.late, text: text("Seagrass meadows bury carbon faster than tidal marshes"), embedding: vec(110), importance: 0.5, steward_state: "done", tagged_at: new Date() });
    const { applied, upkeep } = await publishAndApply();
    expect(applied.at(-1)!.nodes.arrived).toEqual([id.late]);
    expect(upkeep).toMatchObject({ convergence: 1 });
    const asked = await system(() =>
      rawQuery<{ anchor_claim_id: string; other_claim_id: string; l: string; concern: string }>(
        `SELECT anchor_claim_id, other_claim_id, sensitivity_label AS l, concern FROM curation_requests WHERE other_claim_id = $1`,
        [id.late]
      )
    );
    expect(asked.map((r) => [r.anchor_claim_id, r.l])).toEqual([[mine, A]]);
    expect(asked[0]!.concern).toContain("The public graph now holds a node unusually like this one");
    expect(asked[0]!.concern).toContain("merge_claims with the public node as the survivor");
    // Not raised twice, and not visible to a reader who does not read a.
    expect(await afterMirrorApplied(applied)).toMatchObject({ convergence: 0 });
    expect(await person([B], () => rawQuery(`SELECT 1 FROM curation_requests WHERE other_claim_id = $1`, [id.late]))).toEqual([]);
  });

  it("is folded into the public node by the Curator's ordinary merge, with what it carried kept at its label", async () => {
    const before = await mirroredRows();
    // The public node is never the one merged away.
    const wrongWay = await runAtLabel(A, "a test", () =>
      withAgent("curator", () => executeCuratorTool("merge_claims", { survivor_id: mine, loser_id: id.late, stance_relation: "same", reasoning: "They are one." }))
    );
    expect(wrongWay).toContain(`${id.late} belongs to the public graph and is read here through the mirror`);
    expect(wrongWay).toContain(`name ${id.late} as the survivor`);
    const merged = JSON.parse(
      await runAtLabel(A, "a test", () =>
        withAgent("curator", () => executeCuratorTool("merge_claims", { survivor_id: id.late, loser_id: mine, stance_relation: "same", reasoning: "They are one claim." }))
      )
    ) as { success: boolean };
    expect(merged.success).toBe(true);
    // The deployment's node is now an alias of the public one, and its source and argument stand on the public node at a.
    expect(await system(() => rawQuery<{ state: string; merged_into: string }>(`SELECT state, merged_into FROM claims WHERE id = $1`, [mine]))).toEqual([
      { state: "merged", merged_into: id.late },
    ]);
    expect(
      await system(() => rawQuery<{ claim_id: string; l: string }>(`SELECT claim_id, sensitivity_label AS l FROM claim_instances WHERE id = $1`, [mineSource.instance]))
    ).toEqual([{ claim_id: id.late, l: A }]);
    expect(
      await system(() => rawQuery<{ name: string; l: string; origin: string }>(`SELECT name, sensitivity_label AS l, origin FROM arguments WHERE claim_id = $1`, [id.late]))
    ).toEqual([{ name: "From our transects", l: A, origin: "local" }]);
    // The public node itself is untouched, and so is every other mirrored row.
    expect(await mirroredRows()).toEqual(before);
    // The material that came with it lets a record its version on the public node.
    expect((await runAt(A, () => assess(id.late, "supported", "a's reading, now of the public node."))).success).toBe(true);
    expect((await current(id.late)).map((v) => [v.label, v.origin])).toEqual([[A, "local"]]);
    // A reader who does not read a sees the public node with nothing of a's on it.
    const forB = (await person([B], () => getClaimView(id.late, { include: ["arguments"] })))!;
    expect(forB.arguments).toEqual([]);
    expect((forB.versions as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("what a run is told", () => {
  it("is in its brief: which nodes are the public graph's and as of when, that it cannot change them and why, and what it can do", async () => {
    const asOf = (await publicGraphAsOf())!;
    const stamp = `${asOf.slice(0, 10)} ${asOf.slice(11, 16)} UTC`;
    const steward = labelNote(A, [A, PUBLIC_LABEL], { writesJudgments: true, mirror: { publicGraphAsOf: asOf } });
    expect(steward).toContain(
      `Part of what is labeled \`public\` is the public graph itself, copied here by a mirror that follows it. The ` +
        `copy shows the public graph as of ${stamp}, not as of now, and a node's full read says so under \`mirrored\`.`
    );
    expect(steward).toContain(
      `No run here changes a mirrored row, and a tool that would refuses: the next batch from the public graph ` +
        `would overwrite the change, and until then readers would take it for the public graph's own.`
    );
    expect(steward).toContain(
      `On a mirrored node the judgment at \`public\` is the public graph's own. None is made or paid for in this ` +
        `deployment, because readers would take it for the public graph's; a fresh one is funded on the public graph.`
    );
    expect(steward).toContain(
      `so a point against its judgment or its structure is recorded as a request (file_request), which the people who direct this ` +
        `graph can act on. That holds for a mirrored node you judge the public graph has wrong, in its wording, its ` +
        `structure or its assessment: the request stays in this deployment, since raising it on the public graph ` +
        `would show what this deployment is working on, which is for the people who direct it to decide.`
    );
    // Told once: each of those sentences appears a single time in the whole note.
    for (const once of ["copied here by a mirror", "No run here changes a mirrored row", "the request stays in this deployment"]) {
      expect(steward.split(once).length - 1, once).toBe(1);
    }
    // Without a mirror the note is word for word what it was.
    const plain = labelNote(A, [A, PUBLIC_LABEL], { writesJudgments: true });
    expect(plain).not.toContain("mirror");
    expect(labelNote(A, [A, PUBLIC_LABEL], { writesJudgments: true, mirror: null })).toBe(plain);
    // A deployment that mirrors and has one label has no label note: the passage stands alone.
    expect(mirrorNote({ publicGraphAsOf: asOf })).toContain(
      "On a mirrored node the judgment at `public` is the public graph's own. None is made or paid for in this deployment"
    );
  });
});

// ---------------------------------------------------------------------------

describe("the mirror, through all of it", () => {
  it("never refused a batch because of a row of the deployment's own", async () => {
    expect(refusals).toEqual([]);
    expect(await system(() => rawQuery(`SELECT code, message FROM mirror_refusals`))).toEqual([]);
    const status = await mirrorStatus();
    expect(status).toMatchObject({ applied: true, complete: true, last_refusal: null });
    expect(status.sequence).toBe((await listBatches({}, pub)).head);
    // One batch applied by hand, as an operator would, is applied the same way.
    await pub.query(`UPDATE claims SET importance = 0.7 WHERE id = $1`, [id.parent]);
    const result = await cut();
    const applied = await applyBatch(await getBatchText(result.batches.at(-1)!.sequence, pub), { trustedKeys, receivedFrom: "by hand" });
    expect(applied.status).toBe("applied");
  });
});
