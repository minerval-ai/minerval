/**
 * The mirror, end to end: a small public graph in one database, published
 * as signed batches, applied into another, and compared row for row
 * (docs/mirror.md).
 *
 * Two databases, both empty copies of the migrated schema made by the global
 * setup: "a" is the publisher, reached through its own pool; "b" is the
 * private deployment, and is this file's app database, so that the code
 * under test on that side (the applier, the drains, the Matcher's searches)
 * runs exactly as it does in a deployment.
 *
 * The tests run in order and build on each other: a first snapshot, local
 * rows beside the mirror, then changes on the public side (a reworded claim,
 * a new verdict, a merge, an edge removed and added again, deletions), and
 * what a mirror must refuse.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

// This file's app database is the private side. Set before anything loads config.
vi.hoisted(() => {
  const base = process.env.TEST_DATABASE_URL ?? "postgresql://episteme:episteme@localhost:5432/episteme_dbtest";
  const url = new URL(base);
  url.pathname = `${url.pathname}_mirror_b`;
  process.env.DATABASE_URL = url.toString();
  // The unfunded Steward lane, so that the drain's own claim-taking
  // statement is what the test runs.
  process.env.BACKGROUND_FALLBACK_LANE_ENABLED = "true";
});

import { rawQuery } from "../../src/db/client.js";
import { migrationHead } from "../../src/db/migration-head.js";
import { reconcileActions } from "../../src/services/action-service.js";
import {
  MirrorRefusal,
  batchHash,
  feedGenesisHash,
  parsePublicKey,
  publicKeyString,
  readBatch,
  signBatch,
  verifyBatch,
  keyIdOf,
  type MirrorBatch,
} from "../../src/services/mirror-batch.js";
import {
  applyBatch,
  directorySource,
  mirrorStatus,
  syncMirror,
  type BatchSource,
} from "../../src/services/mirror-apply-service.js";
import { appDb, poolDb, type MirrorDb } from "../../src/services/mirror-db.js";
import {
  MirrorPublishError,
  buildPublishedSets,
  cutBatches,
  exportBatches,
  getBatchText,
  keyText,
  listBatches,
  rowJson,
} from "../../src/services/mirror-feed-service.js";
import { replicatedTables } from "../../src/services/mirror-manifest.js";
import { findSimilarClaims, keywordClaimSearch } from "../../src/services/search-service.js";
import { processNextStewardTask } from "../../src/workers/steward-pipeline.js";
import { processNextTaggingTask } from "../../src/workers/tagging-pipeline.js";
import { mirrorDatabaseUrl } from "./urls.js";

const signing = generateKeyPairSync("ed25519");
const trustedKeys = [signing.publicKey];
const DIM = 1536;

let pubPool: pg.Pool;
/** The publisher's database. */
let pub: MirrorDb;
/** The private deployment's database: the app's own. */
const priv = appDb;

/**
 * A vector that points along one axis, with small values everywhere else
 * that are awkward as decimals, so that the round trip is tested on floats
 * that could lose a digit. Vectors on different axes are nearly orthogonal.
 */
function vec(axis: number): string {
  const v = Array.from({ length: DIM }, (_, i) => Math.fround(Math.sin(i * 12.9898 + axis * 78.233) * 0.0004));
  v[axis] = 1;
  return `[${v.join(",")}]`;
}

/** Insert one row from an object; jsonb members are passed as objects, vectors as text. */
async function ins(db: MirrorDb, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await db.query(
    `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    columns.map((c) => row[c])
  );
}

/** Every row of a replicated table as key → hash of its replicated columns. */
async function replicated(db: MirrorDb, where: string): Promise<Record<string, Record<string, string>>> {
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Record<string, Record<string, string>> = {};
    for (const table of replicatedTables()) {
      const rows = await tx.query<{ k: string; h: string }>(
        `SELECT ${keyText(table, "x")} AS k, md5(${rowJson(table, "x")}::text) AS h FROM "${table.name}" x ${where}`
      );
      out[table.name] = Object.fromEntries(rows.map((r) => [r.k, r.h]));
    }
    return out;
  });
}

/** Every local row of every replicated table on the private side, whole: key → hash of all its columns. */
async function localRows(): Promise<Record<string, Record<string, string>>> {
  return priv.transaction(async (tx) => {
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Record<string, Record<string, string>> = {};
    for (const table of replicatedTables()) {
      const rows = await tx.query<{ k: string; h: string }>(
        `SELECT ${keyText(table, "x")} AS k, md5(to_jsonb(x)::text) AS h FROM "${table.name}" x WHERE x.origin = 'local'`
      );
      out[table.name] = Object.fromEntries(rows.map((r) => [r.k, r.h]));
    }
    return out;
  });
}

const cut = (options: Parameters<typeof cutBatches>[0] = {}) =>
  cutBatches({ db: pub, signingKey: signing.privateKey, webBaseUrl: "https://public.example", ...options });

const apply = (input: unknown, options: Parameters<typeof applyBatch>[1] = {}) =>
  applyBatch(input, { trustedKeys, receivedFrom: "test", ...options });

/** The publisher's feed, read straight from its database. */
const feed = (): BatchSource => ({
  name: "the publisher's database",
  head: async () => (await listBatches({}, pub)).head,
  latestSnapshot: async () => (await listBatches({}, pub)).latest_snapshot,
  fetch: (sequence) => getBatchText(sequence, pub),
});

const batchAt = async (sequence: number): Promise<MirrorBatch> => readBatch((await getBatchText(sequence, pub))!);

async function refusal(run: () => Promise<unknown>): Promise<MirrorRefusal> {
  try {
    await run();
  } catch (err) {
    if (err instanceof MirrorRefusal) return err;
    throw err;
  }
  throw new Error("expected the batch to be refused, and it was applied");
}

// ---- the public graph -------------------------------------------------------------

const id = {
  // nodes
  parent: randomUUID(),
  child: randomUUID(),
  absorbed: randomUUID(),
  quantity: randomUUID(),
  question: randomUUID(),
  cutClaim: randomUUID(),
  doomed: randomUUID(),
  doomedReferenced: randomUUID(),
  // structure
  edgeChild: randomUUID(),
  edgeAbsorbed: randomUUID(),
  edgeAnswer: randomUUID(),
  edgeAnswer2: randomUUID(),
  link: randomUUID(),
  answerRelation: randomUUID(),
  argument: randomUUID(),
  // sources
  paper: randomUUID(),
  page: randomUUID(),
  section: randomUUID(),
  passage: randomUUID(),
  // instances
  instance: randomUUID(),
  figure: randomUUID(),
  argumentInstance: randomUUID(),
  unplaced: randomUUID(),
  reading: randomUUID(),
  // judgments
  verdictOld: randomUUID(),
  verdict: randomUUID(),
  estimate: randomUUID(),
  standing: randomUUID(),
  evaluation: randomUUID(),
  interest: randomUUID(),
  inputPremise: randomUUID(),
  inputSource: randomUUID(),
  run: randomUUID(),
};

async function seedPublicGraph(): Promise<void> {
  const claim = (key: keyof typeof id, text: string, axis: number, more: Record<string, unknown> = {}) =>
    ins(pub, "claims", {
      id: id[key],
      text,
      embedding: vec(axis),
      importance: 0.6,
      contestation: 0.4,
      domains: ["mathematics"],
      domains_source: "steward",
      steward_state: "done",
      tagged_at: new Date(),
      pipeline_epoch: "test-epoch",
      ...more,
    });
  await claim("parent", "Zebrafish regenerate heart tissue after injury", 0, { decomposition_status: "complete" });
  await claim("child", "Zebrafish cardiomyocytes re-enter the cell cycle after injury", 1, {
    seed_credence: 0.7,
    seed_note: "Seeded from the parent's decomposition.",
    seed_source_claim_id: id.parent,
    canonical_direction_note: "Stated affirmatively, as the literature poses it.",
  });
  await claim("absorbed", "Injured zebrafish heart muscle cells divide again", 2);
  await claim("quantity", "Share of zebrafish ventricle regrown 60 days after resection", 3, { kind: "quantity" });
  await claim("question", "What drives heart regeneration in zebrafish?", 4, { kind: "question" });
  await claim("cutClaim", "More than half of the resected zebrafish ventricle regrows within 60 days", 5);
  await claim("doomed", "A claim the public graph will delete", 6);
  await claim("doomedReferenced", "A claim the public graph will delete while a private edge points to it", 7);

  await ins(pub, "quantity_definitions", {
    claim_id: id.quantity,
    measures: "regrown share of resected ventricular tissue",
    population: "adult zebrafish",
    conditions: "20% apical resection, 60 days",
    unit: { kind: "proportion" },
    created_by: "claim_steward",
  });
  await ins(pub, "quantity_cuts", { claim_id: id.cutClaim, quantity_id: id.quantity, direction: "above", value: 0.5, created_by: "curator" });

  const edge = (key: keyof typeof id, parent: string, child: string, relation: string, more: Record<string, unknown> = {}) =>
    ins(pub, "claim_relationships", {
      id: id[key],
      parent_claim_id: parent,
      child_claim_id: child,
      relation_type: relation,
      reasoning: `why ${relation}`,
      confidence: 0.9,
      ...more,
    });
  await edge("edgeChild", id.parent, id.child, "requires");
  await edge("edgeAbsorbed", id.parent, id.absorbed, "supports");
  await edge("edgeAnswer", id.question, id.child, "answers", { answer_basis: "quality" });
  await edge("edgeAnswer2", id.question, id.absorbed, "answers", { answer_basis: "prominence" });
  const [a, b] = [id.child, id.absorbed].sort();
  await ins(pub, "claim_links", { id: id.link, claim_a_id: a, claim_b_id: b, kind: "related", reasoning: "near-duplicates" });
  await ins(pub, "answer_relations", {
    id: id.answerRelation,
    question_id: id.question,
    claim_a_id: a,
    claim_b_id: b,
    relation: "compatible",
    created_by: "question_steward",
  });

  await ins(pub, "sources", {
    id: id.paper,
    url: "https://journal.example/zebrafish-heart",
    title: "Heart regeneration in zebrafish",
    raw_content: "Abstract. Zebrafish fully regenerate the heart. Methods. We resected 20% of the ventricle.",
    content_hash: "c".repeat(64),
    source_type: "journal_article",
    authors: ["Poss, K.", "Wilson, L."],
    publisher: "A Journal",
    published_date: "2002-12",
    doi: "10.1000/zebrafish",
    facts_checked_at: new Date("2026-01-02T03:04:05.678Z"),
    page_url_hash: "p".repeat(64),
  });
  await ins(pub, "sources", { id: id.page, url: "https://blog.example/fish", title: "A page the public graph will remove", source_type: "blog_post" });
  await ins(pub, "source_segments", { id: id.section, source_id: id.paper, ordinal: 0, label: "Abstract", kind: "section", char_start: 0, char_end: 49, text_hash: "s".repeat(64) });
  await ins(pub, "source_segments", { id: id.passage, source_id: id.paper, parent_id: id.section, ordinal: 1, kind: "passage", char_start: 10, char_end: 49, text_hash: "t".repeat(64) });

  await ins(pub, "arguments", {
    id: id.argument,
    claim_id: id.parent,
    name: "From cell-cycle re-entry",
    stance: "for",
    content: `Because [[claim:${id.child}]], lost muscle is replaced.`,
    created_by: "claim_steward",
  });
  await ins(pub, "argument_subclaims", { argument_id: id.argument, relationship_id: id.edgeChild });

  await ins(pub, "claim_instances", {
    id: id.instance,
    claim_id: id.child,
    source_id: id.paper,
    verbatim_text: "Zebrafish fully regenerate the heart.",
    stance: "affirms",
    stated_probability: 0.9,
    argument_id: id.argument,
    segment_id: id.passage,
    speaker: "Poss",
    source_date: "2002-12",
    display_rank: 1,
  });
  await ins(pub, "claim_instances", {
    id: id.figure,
    claim_id: id.quantity,
    source_id: id.paper,
    verbatim_text: "",
    stance: "states",
    stated_estimate: { form: "point", value: 1 },
    answer_claim_id: null,
  });
  await ins(pub, "argument_instances", {
    id: id.argumentInstance,
    argument_id: id.argument,
    source_id: id.paper,
    verbatim_text: "Cardiomyocytes proliferate to replace the lost tissue.",
    stance: "advances",
    reading: "full",
    created_by: "claim_steward",
    segment_id: id.passage,
  });
  await ins(pub, "argument_instances", {
    id: id.unplaced,
    claim_id: id.parent,
    direction: "against",
    source_id: id.page,
    verbatim_text: "Some say scarring wins.",
    stance: "advances",
    created_by: "matcher",
  });
  await ins(pub, "quantity_readings", {
    id: id.reading,
    claim_id: id.quantity,
    source_id: id.paper,
    measured: "histological area",
    figure: "about 100%",
    bearing: "direct",
    bearing_claim_id: id.child,
    created_by: "claim_steward",
  });

  await ins(pub, "assessments", {
    id: id.verdictOld,
    claim_id: id.parent,
    status: "supported",
    confidence: 0.6,
    claim_credence: 0.8,
    reasoning_trace: "First pass.",
    is_current: false,
    assessed_at: new Date("2026-03-01T00:00:00Z"),
  });
  await ins(pub, "assessments", {
    id: id.verdict,
    claim_id: id.parent,
    status: "verified",
    confidence: 0.85,
    claim_credence: 0.97,
    summary: "Established by repeated resection studies.",
    reasoning_trace: "Second pass, on the resection literature.",
    marginal_yield: 0.1,
    model: "a-model",
    // Money and transcripts stay behind: the job id must not travel, the run id travels bare.
    funded_by_job_id: randomUUID(),
    skills: ["mathematics"],
    run_id: id.run,
    inputs_recorded: true,
    subclaim_summary: { [id.child]: "supported" },
    trigger: "structure_and_assess",
    assessed_at: new Date("2026-04-01T00:00:00Z"),
  });
  await ins(pub, "quantity_estimates", {
    id: id.estimate,
    claim_id: id.quantity,
    estimate: { form: "interval", low: 0.9, high: 1 },
    work: "From the resection series.",
    marginal_yield: 0.2,
  });
  await ins(pub, "question_assessments", {
    id: id.standing,
    claim_id: id.question,
    standing: "leaning",
    favored_claim_ids: [id.child],
    reasoning_trace: "The evidence favors proliferation.",
    confidence: 0.7,
  });
  await ins(pub, "argument_evaluations", {
    id: id.evaluation,
    argument_id: id.argument,
    verdict: "likely",
    decisive: false,
    content: "The inference goes through if proliferation is the source of new muscle.",
    assessment_id: id.verdict,
  });
  await ins(pub, "source_interests", {
    id: id.interest,
    source_id: id.paper,
    claim_id: id.parent,
    party: "The authors' laboratory",
    stake: "Its research program rests on the finding.",
    recorded_by: "claim_steward",
  });
  await ins(pub, "judgment_inputs", {
    id: id.inputPremise,
    judgment_kind: "assessment",
    judgment_id: id.verdict,
    input_kind: "premise",
    node_id: id.child,
    relation_type: "requires",
  });
  await ins(pub, "judgment_inputs", {
    id: id.inputSource,
    judgment_kind: "assessment",
    judgment_id: id.verdict,
    input_kind: "source",
    source_id: id.paper,
    content_hash: "c".repeat(64),
  });
}

/** The mirror holds exactly the publisher's rows, replicated column for replicated column. */
async function expectMirrorEqualsPublic(except: { extraOnMirror?: Record<string, string[]> } = {}): Promise<void> {
  const publicRows = await replicated(pub, "");
  const mirrored = await replicated(priv, "WHERE x.origin = 'mirror'");
  for (const table of replicatedTables()) {
    const extra = new Set(except.extraOnMirror?.[table.name] ?? []);
    const mine = Object.fromEntries(Object.entries(mirrored[table.name]!).filter(([k]) => !extra.has(k)));
    expect(mine, table.name).toEqual(publicRows[table.name]);
  }
}

beforeAll(async () => {
  pubPool = new pg.Pool({ connectionString: mirrorDatabaseUrl("a"), max: 4 });
  pub = poolDb(pubPool);
  await seedPublicGraph();
});

afterAll(async () => {
  await pubPool?.end();
});

describe("publishing: the first cut", () => {
  it("is a snapshot of every public row, split when large, signed, and chained from the feed's genesis", async () => {
    // A small limit, so that the snapshot has to be split into several batches.
    const result = await cut({ maxBatchBytes: 5_000 });
    expect(result.batches.length).toBeGreaterThan(2);
    expect(result.batches.map((b) => b.sequence)).toEqual(result.batches.map((_, i) => i + 1));
    expect(new Set(result.batches.map((b) => b.kind))).toEqual(new Set(["snapshot"]));

    const batches = await Promise.all(result.batches.map((b) => batchAt(b.sequence)));
    const feedId = batches[0]!.feed_id;
    let previous = feedGenesisHash(feedId);
    for (const batch of batches) {
      expect(batch.previous_hash).toBe(previous);
      expect(batchHash(batch)).toBe(batch.hash);
      expect(() => verifyBatch(batch, trustedKeys)).not.toThrow();
      expect(batch.migration).toEqual(migrationHead());
      expect(batch.part.first).toBe(1);
      expect(batch.part.last).toBe(batch.sequence === batches.length);
      expect(batch.public_key).toBe(publicKeyString(signing.publicKey));
      expect(batch.publisher.web_base_url).toBe("https://public.example");
      previous = batch.hash;
    }
    // Every table that holds a row is in it, parents before what points to them.
    const order = batches.flatMap((b) => b.rows.map((r) => r.table));
    const manifest = replicatedTables().map((t) => t.name);
    expect([...new Set(order)]).toEqual(manifest);
    expect(order.map((t) => manifest.indexOf(t))).toEqual([...order.map((t) => manifest.indexOf(t))].sort((x, y) => x - y));

    const listing = await listBatches({}, pub);
    expect(listing).toMatchObject({ feed_id: feedId, head: batches.length, latest_snapshot: 1, has_more: false });
    expect(listing.batches.map((b) => b.hash)).toEqual(batches.map((b) => b.hash));
  });

  it("carries replicated columns only: no queue state, no money, and a judgment's run as a bare id", async () => {
    const listing = await listBatches({}, pub);
    const batches = await Promise.all(listing.batches.map((b) => batchAt(b.sequence)));
    const rowsOf = (table: string) => batches.flatMap((b) => b.rows.filter((r) => r.table === table).flatMap((r) => r.rows));
    const claim = rowsOf("claims").find((r) => r.id === id.child)!;
    expect(Object.keys(claim).sort()).toEqual([...replicatedTables().find((t) => t.name === "claims")!.columns].sort());
    for (const local of ["steward_state", "queue_priority", "tagged_at", "updated_at", "origin", "text_search", "sensitivity_label"]) {
      expect(claim, local).not.toHaveProperty(local);
    }
    const verdict = rowsOf("assessments").find((r) => r.id === id.verdict)!;
    expect(verdict).not.toHaveProperty("funded_by_job_id");
    expect(verdict.run_id).toBe(id.run);
    expect(rowsOf("arguments")[0]).not.toHaveProperty("lean_check_id");
  });

  it("cuts nothing when nothing has changed", async () => {
    expect((await cut()).batches).toEqual([]);
  });

  it("is not triggered by the publisher's own queue moving", async () => {
    await pub.query(
      `UPDATE claims SET steward_state = 'pending', queue_priority = 0.9, updated_at = now(), tagged_at = NULL WHERE id = $1`,
      [id.child]
    );
    expect((await cut()).batches).toEqual([]);
  });
});

describe("applying: a mirror from nothing", () => {
  let dir: string;

  it("refuses to start anywhere but the first batch of a snapshot", async () => {
    const err = await refusal(async () => apply(await getBatchText(2, pub)));
    expect(err.code).toBe("not_a_snapshot");
    expect(err.message).toMatch(/Batch 2 was not applied: this mirror has applied nothing yet/);
    expect(await mirrorStatus()).toMatchObject({ applied: false, public_graph_as_of: null, complete: false });
  });

  it("applies the snapshot from a directory of files and then holds the public graph, row for row", async () => {
    dir = mkdtempSync(join(tmpdir(), "mirror-batches-"));
    try {
      const { written } = await exportBatches(dir, {}, pub);
      expect(written.length).toBeGreaterThan(2);
      const source = directorySource(dir);
      expect(await source.latestSnapshot()).toBe(1);

      // Part way through the snapshot the mirror says it is not whole.
      const first = await syncMirror(source, { trustedKeys, maxBatches: 1 });
      expect(first.applied.map((a) => a.sequence)).toEqual([1]);
      expect(await mirrorStatus()).toMatchObject({ applied: true, complete: false, sequence: 1 });

      const rest = await syncMirror(source, { trustedKeys });
      expect(rest.refusal).toBeNull();
      expect(rest.applied.map((a) => a.sequence)).toEqual(written.slice(1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expectMirrorEqualsPublic();
  });

  it("marks every row it wrote as mirrored and public, and leaves what it does not carry at its default", async () => {
    for (const table of replicatedTables()) {
      const [row] = await rawQuery<{ n: number; local: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE origin <> 'mirror')::int AS local FROM "${table.name}"`
      );
      expect(row!.n, table.name).toBeGreaterThan(0);
      expect(row!.local, table.name).toBe(0);
    }
    const labels = await rawQuery<{ sensitivity_label: string }>(
      `SELECT DISTINCT sensitivity_label FROM assessments UNION SELECT DISTINCT sensitivity_label FROM sources`
    );
    expect(labels.map((l) => l.sensitivity_label)).toEqual(["public"]);
    // The payer's job did not travel; the run's id did, and names nothing here.
    const [verdict] = await rawQuery<{ funded_by_job_id: string | null; run_id: string }>(
      `SELECT funded_by_job_id, run_id FROM assessments WHERE id = $1`,
      [id.verdict]
    );
    expect(verdict).toEqual({ funded_by_job_id: null, run_id: id.run });
    expect(await rawQuery(`SELECT 1 FROM agent_runs WHERE id = $1`, [id.run])).toEqual([]);
  });

  it("says how current it is", async () => {
    const head = (await listBatches({}, pub)).head!;
    const last = await batchAt(head);
    const status = await mirrorStatus();
    expect(status).toMatchObject({
      applied: true,
      complete: true,
      sequence: head,
      batch_hash: last.hash,
      public_graph_as_of: last.cut_at,
      feed_id: last.feed_id,
      key_id: keyIdOf(publicKeyString(signing.publicKey)),
      public_web_base_url: "https://public.example",
      searchable_claims: 8,
      last_refusal: null,
    });
    expect(Date.parse(status.applied_at!)).toBeGreaterThanOrEqual(Date.parse(last.cut_at));
  });
});

describe("mirrored claims and this deployment's own work", () => {
  it("puts a mirrored claim in neither the Steward's drain nor the Tagger's", async () => {
    // Only mirrored rows exist here so far, so a drain that took anything took a mirrored claim.
    const states = await rawQuery<{ steward_state: string; untagged: boolean }>(
      `SELECT DISTINCT steward_state, (tagged_at IS NULL) AS untagged FROM claims`
    );
    expect(states).toEqual([{ steward_state: "deferred", untagged: false }]);
    expect((await processNextStewardTask()).status).toBe("empty");
    expect((await processNextTaggingTask()).status).toBe("empty");
    // And the ledger opens no assessment for one.
    expect((await reconcileActions()).assessEnsured).toBe(0);
    expect(await rawQuery(`SELECT 1 FROM actions`)).toEqual([]);
  });

  it("lets the Matcher's searches find a mirrored claim like any other", async () => {
    const axis = new Array<number>(DIM).fill(0);
    axis[1] = 1;
    const similar = await findSimilarClaims(axis, { minSimilarity: 0.9 });
    expect(similar.map((r) => r.id)).toEqual([id.child]);
    const byWords = await keywordClaimSearch("cardiomyocytes cell cycle");
    expect(byWords.map((r) => r.id)).toContain(id.child);
    // The mirrored verdict is the judgment in force for its claim.
    const [found] = await findSimilarClaims(new Array<number>(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)), { minSimilarity: 0.9 });
    expect(found).toMatchObject({ id: id.parent, assessment_status: "verified" });
  });

  it("lets this deployment move its own queue state on a mirrored claim, and nothing the feed carries", async () => {
    await rawQuery(`UPDATE claims SET steward_state = 'pending', steward_trigger = 'funded', queue_priority = 0.8 WHERE id = $1`, [id.cutClaim]);
    await expect(rawQuery(`UPDATE claims SET text = 'our wording' WHERE id = $1`, [id.cutClaim])).rejects.toThrow(
      /mirrored from the public graph, and only the mirror's applier may change: text/
    );
    await rawQuery(`UPDATE claims SET steward_state = 'deferred', steward_trigger = NULL, queue_priority = 0.5 WHERE id = $1`, [id.cutClaim]);
  });
});

// ---- the private side's own rows --------------------------------------------------

const own = {
  claim: randomUUID(),
  source: randomUUID(),
  edgeToAbsorbed: randomUUID(),
  edgeToDoomed: randomUUID(),
  edgeUnderParent: randomUUID(),
  instanceOfAbsorbed: randomUUID(),
  instanceInPage: randomUUID(),
  verdictOnAbsorbed: randomUUID(),
};

describe("changes on the public graph, with local rows beside the mirror", () => {
  let before: Awaited<ReturnType<typeof localRows>>;
  let head: number;
  let changes: number;
  let later: number;

  it("seeds the private deployment's own rows on and around mirrored ones", async () => {
    // No vector, so the tagger's drain would not take it; its queue state is its own.
    await ins(priv, "claims", { id: own.claim, text: "Our supplier's fish stock is of the regenerating strain", steward_state: "pending", queue_priority: 0.77 });
    await ins(priv, "sources", { id: own.source, title: "Internal memo", raw_content: "The stock regenerates.", source_type: "report" });
    const edge = (key: keyof typeof own, parent: string, child: string) =>
      ins(priv, "claim_relationships", { id: own[key], parent_claim_id: parent, child_claim_id: child, relation_type: "supports", reasoning: "our reasoning" });
    await edge("edgeToAbsorbed", own.claim, id.absorbed);
    await edge("edgeToDoomed", own.claim, id.doomedReferenced);
    await edge("edgeUnderParent", id.parent, own.claim);
    await ins(priv, "claim_instances", { id: own.instanceOfAbsorbed, claim_id: id.absorbed, source_id: own.source, verbatim_text: "The stock regenerates.", stance: "affirms" });
    await ins(priv, "claim_instances", { id: own.instanceInPage, claim_id: own.claim, source_id: id.page, verbatim_text: "A passage in the public page.", stance: "mentions" });
    await ins(priv, "assessments", { id: own.verdictOnAbsorbed, claim_id: id.absorbed, status: "supported", confidence: 0.5, reasoning_trace: "On our memo." });
    before = await localRows();
    expect(Object.keys(before.claims!)).toEqual([own.claim]);
    head = (await mirrorStatus()).sequence!;
  });

  it("publishes a reworded claim, a new verdict, a merge, an edge replaced, and deletions as one batch of changes", async () => {
    // A later change: new wording, and a new verdict that supersedes the current one.
    await pub.query(`UPDATE claims SET text = 'Zebrafish regenerate heart muscle after injury', importance = 0.8 WHERE id = $1`, [id.parent]);
    await pub.query(`UPDATE assessments SET is_current = false WHERE id = $1`, [id.verdict]);
    await ins(pub, "assessments", { id: randomUUID(), claim_id: id.parent, status: "supported", confidence: 0.7, reasoning_trace: "Third pass." });
    // A merge, as the public graph does one: the absorbed claim becomes an
    // alias and what hung off it moves to the survivor or goes.
    await pub.query(`UPDATE claims SET state = 'merged', merged_into = $2 WHERE id = $1`, [id.absorbed, id.child]);
    await pub.query(`DELETE FROM claim_relationships WHERE id = ANY($1::uuid[])`, [[id.edgeAbsorbed, id.edgeAnswer2]]);
    await pub.query(`DELETE FROM claim_links WHERE id = $1`, [id.link]);
    await pub.query(`DELETE FROM answer_relations WHERE id = $1`, [id.answerRelation]);
    // An edge removed and added again under a new id: the same parent, child and relation.
    await pub.query(`DELETE FROM claim_relationships WHERE id = $1`, [id.edgeChild]);
    await ins(pub, "claim_relationships", { id: randomUUID(), parent_claim_id: id.parent, child_claim_id: id.child, relation_type: "requires", reasoning: "restated" });
    // Deletions: a source (its mirrored instance goes with it), and two claims.
    await pub.query(`DELETE FROM sources WHERE id = $1`, [id.page]);
    await pub.query(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [[id.doomed, id.doomedReferenced]]);

    const result = await cut();
    expect(result.batches).toHaveLength(1);
    changes = result.batches[0]!.sequence;
    expect(changes).toBe(head + 1);
    const batch = await batchAt(changes);
    expect(batch.kind).toBe("changes");
    expect(batch.previous_hash).toBe((await batchAt(head)).hash);
    const deleted = Object.fromEntries(batch.deletions.map((d) => [d.table, d.keys]));
    expect(deleted.claims!.sort()).toEqual([id.doomed, id.doomedReferenced].sort());
    expect(deleted.sources).toEqual([id.page]);
    expect(deleted.claim_relationships!.sort()).toEqual([id.edgeAbsorbed, id.edgeAnswer2, id.edgeChild].sort());
    // The argument's grouping of the removed edge went with it, and so did the passage in the removed page.
    expect(deleted.argument_subclaims).toEqual([`${id.argument}/${id.edgeChild}`]);
    expect(deleted.argument_instances).toEqual([id.unplaced]);
    expect(batch.retractions).toEqual([]);
    // Only what changed travels.
    expect(batch.rows.find((r) => r.table === "claims")!.rows.map((r) => r.id).sort()).toEqual([id.absorbed, id.parent].sort());
    expect(batch.rows.find((r) => r.table === "sources")).toBeUndefined();

    // And one more change after it, so that there is a batch to skip to.
    await pub.query(`UPDATE claims SET contestation = 0.9 WHERE id = $1`, [id.child]);
    later = (await cut()).batches[0]!.sequence;
    expect(later).toBe(changes + 1);
  });

  it("refuses a batch that was tampered with, whatever the tamperer recomputed", async () => {
    const mirrorBefore = await replicated(priv, "");
    const original = await batchAt(changes);
    const edit = (batch: MirrorBatch): MirrorBatch => {
      const copy = JSON.parse(JSON.stringify(batch)) as MirrorBatch;
      copy.rows.find((r) => r.table === "claims")!.rows.find((r) => r.id === id.parent)!.text = "Zebrafish do not regenerate";
      return copy;
    };

    // Contents changed, hash left alone.
    const altered = await refusal(() => apply(edit(original)));
    expect(altered.code).toBe("hash_mismatch");
    expect(altered.message).toMatch(/its contents do not match its hash/);

    // Contents changed and the hash recomputed: the signature is over the old hash.
    const rehashed = edit(original);
    rehashed.hash = batchHash(rehashed);
    expect((await refusal(() => apply(rehashed))).code).toBe("bad_signature");

    // Signed afresh with a key of the tamperer's own, which the batch then names.
    const forger = generateKeyPairSync("ed25519");
    const forgedKey = publicKeyString(forger.publicKey);
    const { hash: _h, signature: _s, ...body } = edit(original);
    const forged = signBatch({ ...body, public_key: forgedKey, key_id: keyIdOf(forgedKey) }, forger.privateKey);
    const unknown = await refusal(() => apply(forged));
    expect(unknown.code).toBe("unknown_key");
    expect(unknown.message).toMatch(/not a key this deployment trusts/);
    // The forger naming the real key's id does not help either.
    const forgedAsTrusted = signBatch({ ...body }, forger.privateKey);
    expect((await refusal(() => apply(forgedAsTrusted))).code).toBe("bad_signature");

    expect(await replicated(priv, "")).toEqual(mirrorBefore);
    expect(await localRows()).toEqual(before);
    expect((await mirrorStatus()).last_refusal).toMatchObject({ sequence: changes, code: "bad_signature" });
  });

  it("refuses a batch that skips one", async () => {
    const mirrorBefore = await replicated(priv, "");
    const err = await refusal(async () => apply(await getBatchText(later, pub)));
    expect(err.code).toBe("sequence_gap");
    expect(err.message).toContain(`this mirror is at batch ${head}, so the next batch it can apply is ${head + 1}`);
    expect(await replicated(priv, "")).toEqual(mirrorBefore);
    expect((await mirrorStatus()).sequence).toBe(head);
  });

  it("refuses a batch whose tables have a different shape, and says to upgrade when the batch is the newer side", async () => {
    const mine = migrationHead();
    const mirrorBefore = await replicated(priv, "");
    const otherShape = "e".repeat(64);

    // The batch comes from a newer migration than this deployment's code,
    // and the mirrored tables changed in between: this side has to upgrade.
    const newer = await refusal(async () =>
      apply(await getBatchText(changes, pub), { migration: { number: mine.number - 1, tag: "0000_older" }, shape: otherShape })
    );
    expect(newer.code).toBe("schema_newer");
    expect(newer.message).toBe(
      `Batch ${changes} was not applied: it was cut from schema migration ${mine.number} (${mine.tag}), and this ` +
        `deployment's code is at migration ${mine.number - 1} (0000_older). Between the two the mirrored tables changed ` +
        `(their columns, or what a column's values mean), so its rows do not fit here. Upgrade this deployment to a ` +
        `release that includes migration ${mine.number}, then apply the batch again. The mirror stays at batch ${head} until then.`
    );

    // The batch comes from an older migration, or the same one: upgrading
    // here would not help, and the publisher's next snapshot is the way on.
    for (const ahead of [0, 3]) {
      const older = await refusal(async () =>
        apply(await getBatchText(changes, pub), { migration: { number: mine.number + ahead, tag: "9999_here" }, shape: otherShape })
      );
      expect(older.code).toBe("shape_differs");
      expect(older.message).toBe(
        `Batch ${changes} was not applied: it was cut at schema migration ${mine.number} (${mine.tag}), when the mirrored ` +
          `tables had a different shape (their columns, or what a column's values mean) from the one this deployment's code ` +
          `(migration ${mine.number + ahead}) writes, so its rows do not fit. The publisher cuts a full snapshot once it runs ` +
          `the same schema; the mirror goes on from that snapshot.`
      );
    }

    expect(await replicated(priv, "")).toEqual(mirrorBefore);
    expect((await mirrorStatus()).sequence).toBe(head);
  });

  it("applies a batch cut from a newer migration when the mirrored tables have the same shape", async () => {
    // The publisher is several migrations ahead of this deployment's code,
    // none of which touched a mirrored table: the rows fit, so they are applied.
    const mine = migrationHead();
    const result = await apply(await getBatchText(changes, pub), {
      migration: { number: mine.number - 5, tag: "0000_behind" },
    });
    expect(result.status).toBe("applied");
    // The migration the batch was cut from is recorded with it.
    const [recorded] = await rawQuery<{ migration_number: number }>(
      `SELECT migration_number FROM mirror_applied_batches WHERE sequence = $1`,
      [changes]
    );
    expect(recorded!.migration_number).toBe(mine.number);
    expect((await mirrorStatus()).last_refusal).toBeNull();
    expect(result.counts.claims).toEqual({ inserted: 0, updated: 2, removed: 1, kept: 1 });
    expect(result.counts.claim_relationships).toMatchObject({ inserted: 1, removed: 3 });
    // Which rows moved, for whatever will act on a mirror update.
    expect(result.changed.claims).toEqual({
      written: expect.arrayContaining([id.parent, id.absorbed]),
      removed: [id.doomed],
      kept: [id.doomedReferenced],
    });
    expect(result.changed.claims!.written).toHaveLength(2);
    expect(result.changed.assessments!.written).toHaveLength(2);
    expect(result.changed.sources).toEqual({ written: [], removed: [id.page], kept: [] });
    // And a deployment ahead of the publisher applies the next one the same way.
    await apply(await getBatchText(later, pub), { migration: { number: mine.number + 3, tag: "9999_ahead" } });
    // The one row the mirror holds that the public graph no longer does: the kept claim.
    await expectMirrorEqualsPublic({ extraOnMirror: { claims: [id.doomedReferenced] } });
  });

  it("left every local row exactly as it was, with one stated exception", async () => {
    const after = await localRows();
    // The private instance sat in a source the public graph deleted, and a
    // row cannot outlive the source it quotes: it followed its foreign key.
    const expected = JSON.parse(JSON.stringify(before)) as typeof before;
    delete expected.claim_instances![own.instanceInPage];
    expect(after).toEqual(expected);
    const [mine] = await rawQuery<{ steward_state: string; queue_priority: number }>(
      `SELECT steward_state, queue_priority FROM claims WHERE id = $1`,
      [own.claim]
    );
    expect(mine).toEqual({ steward_state: "pending", queue_priority: expect.closeTo(0.77, 5) });
  });

  it("kept the merged claim as an alias, left what hangs off it alone, and wrote down what that is", async () => {
    const [absorbed] = await rawQuery<{ state: string; merged_into: string; origin: string }>(
      `SELECT state, merged_into, origin FROM claims WHERE id = $1`,
      [id.absorbed]
    );
    expect(absorbed).toEqual({ state: "merged", merged_into: id.child, origin: "mirror" });
    const [edge] = await rawQuery<{ child_claim_id: string }>(`SELECT child_claim_id FROM claim_relationships WHERE id = $1`, [own.edgeToAbsorbed]);
    expect(edge!.child_claim_id).toBe(id.absorbed);

    const [applied] = await rawQuery<{ notes: Record<string, any> }>(`SELECT notes FROM mirror_applied_batches WHERE sequence = $1`, [changes]);
    expect(applied!.notes.merged_with_local_rows).toEqual({
      count: 1,
      claims: [
        {
          claim_id: id.absorbed,
          merged_into: id.child,
          local_rows: expect.arrayContaining([
            { table: "claim_relationships", column: "child_claim_id", on_delete: "cascade", rows: 1 },
            { table: "claim_instances", column: "claim_id", on_delete: "cascade", rows: 1 },
            { table: "assessments", column: "claim_id", on_delete: "cascade", rows: 1 },
          ]),
        },
      ],
    });
  });

  it("kept a deleted claim that a local edge points to, as deprecated, and deleted the one nothing points to", async () => {
    const rows = await rawQuery<{ id: string; state: string; origin: string }>(
      `SELECT id, state, origin FROM claims WHERE id = ANY($1::uuid[])`,
      [[id.doomed, id.doomedReferenced]]
    );
    expect(rows).toEqual([{ id: id.doomedReferenced, state: "deprecated", origin: "mirror" }]);
    expect(await rawQuery(`SELECT 1 FROM claim_relationships WHERE id = $1`, [own.edgeToDoomed])).toHaveLength(1);
    const [applied] = await rawQuery<{ notes: Record<string, any> }>(`SELECT notes FROM mirror_applied_batches WHERE sequence = $1`, [changes]);
    expect(applied!.notes.kept_claims).toEqual({
      count: 1,
      claims: [
        {
          claim_id: id.doomedReferenced,
          reason: "deleted",
          local_rows: [{ table: "claim_relationships", column: "child_claim_id", on_delete: "cascade", rows: 1 }],
        },
      ],
    });
    // The local instance that went with the deleted source is in the notes too.
    expect(applied!.notes.local_rows_followed).toEqual([
      { table: "sources", reason: "deleted", local_rows: [{ table: "claim_instances", column: "source_id", on_delete: "cascade", rows: 1 }] },
    ]);
  });

  it("changes nothing when a batch is replayed", async () => {
    const mirrorBefore = await replicated(priv, "");
    const applied = await rawQuery(`SELECT sequence, applied_at FROM mirror_applied_batches ORDER BY sequence`);
    for (const sequence of [1, changes, later]) {
      const result = await apply(await getBatchText(sequence, pub));
      expect(result.status).toBe("already_applied");
      expect(result.counts).toEqual({});
    }
    expect(await replicated(priv, "")).toEqual(mirrorBefore);
    expect(await rawQuery(`SELECT sequence, applied_at FROM mirror_applied_batches ORDER BY sequence`)).toEqual(applied);
  });

  it("refuses a different batch at a sequence it has applied, and a batch from another feed", async () => {
    const original = await batchAt(later);
    const { hash: _h, signature: _s, ...body } = original;
    const fork = signBatch({ ...body, cut_at: new Date(Date.parse(body.cut_at) + 1000).toISOString() }, signing.privateKey);
    expect((await refusal(() => apply(fork))).code).toBe("sequence_conflict");
    const other = signBatch({ ...body, sequence: later + 1, feed_id: randomUUID(), previous_hash: original.hash, part: { first: later + 1, last: true } }, signing.privateKey);
    const err = await refusal(() => apply(other));
    expect(err.code).toBe("other_feed");
    // A batch at the right sequence that does not continue the chain.
    const unchained = signBatch({ ...body, sequence: later + 1, previous_hash: "0".repeat(64), part: { first: later + 1, last: true } }, signing.privateKey);
    expect((await refusal(() => apply(unchained))).code).toBe("chain_broken");
    expect((await mirrorStatus()).sequence).toBe(later);
  });

  it("stops, loudly, on a row with the id of a row this deployment made itself", async () => {
    const shared = randomUUID();
    await ins(priv, "claims", { id: shared, text: "A local claim that somehow has a public claim's id" });
    await ins(pub, "claims", { id: shared, text: "The public claim with that id", embedding: vec(20) });
    const sequence = (await cut()).batches[0]!.sequence;
    const mirrorBefore = await replicated(priv, "");
    const err = await refusal(async () => apply(await getBatchText(sequence, pub)));
    expect(err.code).toBe("id_collision");
    expect(err.message).toContain(`it carries claims row ${shared}, and this deployment already holds a row of its own with that id`);
    expect(await replicated(priv, "")).toEqual(mirrorBefore);
    const [local] = await rawQuery<{ text: string; origin: string }>(`SELECT text, origin FROM claims WHERE id = $1`, [shared]);
    expect(local).toEqual({ text: "A local claim that somehow has a public claim's id", origin: "local" });
    // Once the local row is out of the way the same batch applies.
    await rawQuery(`DELETE FROM claims WHERE id = $1`, [shared]);
    expect((await apply(await getBatchText(sequence, pub))).status).toBe("applied");
    await expectMirrorEqualsPublic({ extraOnMirror: { claims: [id.doomedReferenced] } });
  });
});

describe("a mirror that cannot apply the next batch", () => {
  it("goes on from a later snapshot, and ends up holding the public graph again", async () => {
    const head = (await mirrorStatus()).sequence!;
    // A batch this mirror will never see, in which an edge is removed...
    const [edge] = await pub.query<{ id: string }>(
      `SELECT id FROM claim_relationships WHERE parent_claim_id = $1 AND child_claim_id = $2`,
      [id.parent, id.child]
    );
    await pub.query(`DELETE FROM claim_relationships WHERE id = $1`, [edge!.id]);
    const missed = (await cut()).batches[0]!.sequence;
    expect(missed).toBe(head + 1);
    // ...and then added again under a new id, a source reworded, and a snapshot cut.
    await ins(pub, "claim_relationships", { id: randomUUID(), parent_claim_id: id.parent, child_claim_id: id.child, relation_type: "requires", reasoning: "once more" });
    await pub.query(`UPDATE sources SET title = 'Heart regeneration in zebrafish (corrected)' WHERE id = $1`, [id.paper]);
    const snapshot = await cut({ snapshot: true });
    expect(snapshot.batches.map((b) => b.kind)).toEqual(["snapshot"]);
    const start = snapshot.batches[0]!.sequence;
    expect((await listBatches({}, pub)).latest_snapshot).toBe(start);

    // The source no longer has the batch in between.
    const pruned: BatchSource = { ...feed(), fetch: (sequence) => (sequence === missed ? Promise.resolve(null) : getBatchText(sequence, pub)) };
    const result = await syncMirror(pruned, { trustedKeys });
    expect(result.refusal).toBeNull();
    expect(result.applied.map((a) => a.sequence)).toEqual([start]);
    // The stale edge was cleared before the snapshot's rows were written, so its replacement fit.
    expect(await rawQuery(`SELECT 1 FROM claim_relationships WHERE id = $1`, [edge!.id])).toEqual([]);
    await expectMirrorEqualsPublic({ extraOnMirror: { claims: [id.doomedReferenced] } });
    // The batch that was passed over can no longer be applied.
    expect((await refusal(async () => apply(await getBatchText(missed, pub)))).code).toBe("sequence_gap");
    expect(await mirrorStatus()).toMatchObject({ sequence: start, complete: true, last_refusal: { code: "sequence_gap" } });
  });

  it("is sent a snapshot when the mirrored tables change shape on the publisher", async () => {
    // As if the last batch had been cut by code with a different column list.
    await pub.query(`UPDATE mirror_feed_batches SET shape = $1 WHERE sequence = (SELECT max(sequence) FROM mirror_feed_batches)`, ["f".repeat(64)]);
    const result = await cut();
    expect(result.batches.map((b) => b.kind)).toEqual(["snapshot"]);
    expect((await syncMirror(feed(), { trustedKeys })).applied).toHaveLength(1);
    await expectMirrorEqualsPublic({ extraOnMirror: { claims: [id.doomedReferenced] } });
  });
});

describe("only public rows are published", () => {
  it("keeps a row at another label, and everything that hangs off it, out of what a cut may send", async () => {
    const secret = { source: randomUUID(), instance: randomUUID(), verdict: randomUUID(), input: randomUUID() };
    await pub.query(`INSERT INTO labels (name, description) VALUES ('internal', 'Ours.')`);
    try {
      await ins(pub, "sources", { id: secret.source, title: "An internal memo", raw_content: "Private text.", sensitivity_label: "internal" });
      // A public row that points to the labelled one. Where a second label
      // exists a row is never public by omission, so the insert names it.
      await ins(pub, "claim_instances", { id: secret.instance, claim_id: id.child, source_id: secret.source, verbatim_text: "Private text.", stance: "affirms", sensitivity_label: "public" });
      await ins(pub, "assessments", { id: secret.verdict, claim_id: id.child, status: "supported", confidence: 0.5, reasoning_trace: "Private reasoning.", sensitivity_label: "internal" });
      await ins(pub, "judgment_inputs", { id: secret.input, judgment_kind: "assessment", judgment_id: secret.verdict, input_kind: "source", source_id: secret.source, sensitivity_label: "public" });

      const published = await pub.transaction(async (tx) => {
        await tx.query("SET LOCAL TIME ZONE 'UTC'");
        await buildPublishedSets(tx);
        const keys: Record<string, string[]> = {};
        for (const table of ["sources", "claim_instances", "assessments", "judgment_inputs"]) {
          keys[table] = (await tx.query<{ row_key: string }>(`SELECT row_key FROM "mirror_pub_${table}"`)).map((r) => r.row_key);
        }
        return keys;
      });
      expect(published.sources).toContain(id.paper);
      expect(published.sources).not.toContain(secret.source);
      expect(published.claim_instances).toContain(id.instance);
      expect(published.claim_instances).not.toContain(secret.instance);
      expect(published.assessments).not.toContain(secret.verdict);
      expect(published.judgment_inputs).toContain(id.inputSource);
      expect(published.judgment_inputs).not.toContain(secret.input);

      // And a deployment that has such a label does not publish at all.
      const sequenceBefore = (await listBatches({}, pub)).head;
      await expect(cut()).rejects.toThrow(MirrorPublishError);
      await expect(cut()).rejects.toThrow(
        'This deployment defines labels besides "public" ("internal"), so it does not publish a mirror feed'
      );
      expect((await listBatches({}, pub)).head).toBe(sequenceBefore);
    } finally {
      await pub.query(`DELETE FROM judgment_inputs WHERE id = $1`, [secret.input]);
      await pub.query(`DELETE FROM assessments WHERE id = $1`, [secret.verdict]);
      await pub.query(`DELETE FROM claim_instances WHERE id = $1`, [secret.instance]);
      await pub.query(`DELETE FROM sources WHERE id = $1`, [secret.source]);
      await pub.query(`DELETE FROM labels WHERE name = 'internal'`);
    }
    expect((await cut()).batches).toEqual([]);
  });

  it("checks a public key written either way", () => {
    const stated = publicKeyString(signing.publicKey);
    const pem = signing.publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(publicKeyString(parsePublicKey(stated))).toBe(stated);
    expect(publicKeyString(parsePublicKey(pem))).toBe(stated);
    expect(() => parsePublicKey("not a key")).toThrow(/must be an Ed25519 key/);
  });
});
