/**
 * Graph agreement between two corpus databases (#334 L2) — the driver for
 * graph-agreement.ts.
 *
 * Usage:
 *   npm run corpus:agreement -- <refA> <refB> [--threshold=0.85] [--sure=0.95]
 *                                [--confirm] [--out=FILE]
 *
 * A ref is `db` (the live corpus DB), `snap:<name>` (a snapshot taken with
 * corpus:snapshot), or a full postgresql:// URL of any disposable database.
 * The main 'episteme' database is refused by name.
 *
 *   npm run corpus:snapshot -- save run1      # after one drained run
 *   npm run corpus:run -- blackholes          # run it again (or with a swap)
 *   npm run corpus:agreement -- snap:run1 db  # how far apart are the two graphs?
 *
 * Claims are matched by exact text, then by stored embedding above
 * --threshold, one-to-one. Pairs between --threshold and --sure are the
 * ambiguous band; --confirm sends each to a pair judge (JUDGE_MODEL,
 * constitution §2's same-considerations test) and drops the pairs it
 * rejects — embedding similarity is retrieval, not decision. Without
 * --confirm the band is kept and reported as such.
 *
 * The report (three axes: claim set, credence, structure — see the library)
 * is printed, optionally written as JSON, and registered in the eval-run
 * registry (kind 'agreement') so it sits in the same history as scorecards.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { writeFileSync } from "node:fs";
import pg from "pg";
import { argFlag, assertCorpusDb, CORPUS_DATABASE_URL, gitCommit, hasFlag, positional } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { completeStructured } from "../../src/llm/client.js";
import { withAgent, withCostMeter } from "../../src/llm/usage-context.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { dbNameOf, snapshotDbName } from "./snapshot-core.js";
import {
  buildMatching,
  graphAgreement,
  renderAgreement,
  type AgreementGraph,
  type MatchedPair,
} from "./graph-agreement.js";

function resolveRef(ref: string): { label: string; url: string } {
  if (ref === "db") return { label: `db:${dbNameOf(CORPUS_DATABASE_URL)}`, url: CORPUS_DATABASE_URL };
  if (ref.startsWith("snap:")) {
    const name = ref.slice(5);
    const u = new URL(CORPUS_DATABASE_URL);
    u.pathname = `/${snapshotDbName(dbNameOf(CORPUS_DATABASE_URL), name)}`;
    return { label: ref, url: u.toString() };
  }
  if (/^postgres(ql)?:\/\//.test(ref)) return { label: `url:${dbNameOf(ref)}`, url: ref };
  throw new Error(`unknown ref "${ref}" (use db | snap:<name> | postgresql://…)`);
}

function parseVector(text: string | null): number[] | null {
  if (!text) return null;
  try {
    const arr = JSON.parse(text) as unknown;
    return Array.isArray(arr) ? (arr as number[]) : null;
  } catch {
    return null;
  }
}

async function loadGraph(label: string, url: string): Promise<AgreementGraph> {
  if (dbNameOf(url) === "episteme") throw new Error("Refusing to read the main 'episteme' database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const claims = await client.query<{
      id: string;
      text: string;
      created_by: string;
      importance: number;
      status: string | null;
      credence: number | null;
      embedding: string | null;
    }>(
      `SELECT c.id, c.text, c.created_by, c.importance,
              a.status, a.claim_credence AS credence,
              c.embedding::text AS embedding
         FROM claims c
         LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
        WHERE c.state = 'active'`
    );
    const edges = await client.query<{ parent: string; child: string; rel: string }>(
      `SELECT parent_claim_id AS parent, child_claim_id AS child, relation_type AS rel
         FROM claim_relationships`
    );
    return {
      label,
      claims: claims.rows.map((r) => ({
        id: r.id,
        text: r.text,
        createdBy: r.created_by,
        importance: r.importance,
        status: r.status,
        credence: r.credence,
        embedding: parseVector(r.embedding),
      })),
      edges: edges.rows,
    };
  } finally {
    await client.end();
  }
}

const PAIR_SCHEMA = {
  type: "object" as const,
  properties: {
    same_proposition: {
      type: "boolean",
      description:
        "true if the two texts state the same proposition under §2's test: nothing could count as evidence or argument bearing on one without bearing equally on the other. A claim and its negation count as the same node. A specification, a generalization, or a claim that turns on different considerations is NOT the same.",
    },
    reasoning: { type: "string", description: "One or two sentences." },
  },
  required: ["same_proposition", "reasoning"],
  additionalProperties: false,
};

/** Ask the pair judge whether an ambiguous pair is one proposition. */
async function confirmPairs(
  pairs: MatchedPair[],
  a: AgreementGraph,
  b: AgreementGraph
): Promise<{ kept: MatchedPair[]; dropped: Array<MatchedPair & { reasoning: string }> }> {
  const textA = new Map(a.claims.map((c) => [c.id, c.text]));
  const textB = new Map(b.claims.map((c) => [c.id, c.text]));
  const model = loadConfig().judgeModel;
  const kept: MatchedPair[] = [];
  const dropped: Array<MatchedPair & { reasoning: string }> = [];
  for (const p of pairs) {
    const verdict = await withAgent("agreement-judge", () =>
      completeStructured<{ same_proposition: boolean; reasoning: string }>({
        model,
        schema: PAIR_SCHEMA,
        schemaName: "SameProposition",
        maxTokens: 2048,
        messages: [
          {
            role: "user",
            content:
              `Two claim graphs, built independently, each contain a claim. Decide whether they are the SAME proposition — a claim ` +
              `is individuated by what bears on it (constitution §2): two formulations are the same claim when nothing could count ` +
              `as evidence or argument bearing on one without bearing equally on the other. Identical decomposition is a diagnostic, ` +
              `not the definition. A claim and its denial are one node. A specification, a generalization, or a claim that turns on ` +
              `different considerations is a different claim.\n\nClaim 1: ${textA.get(p.a)}\nClaim 2: ${textB.get(p.b)}`,
          },
        ],
      })
    );
    if (verdict.same_proposition) kept.push({ ...p, method: "judge" });
    else dropped.push({ ...p, reasoning: verdict.reasoning });
  }
  return { kept, dropped };
}

async function main(): Promise<void> {
  assertCorpusDb();
  const refA = positional(0);
  const refB = positional(1);
  if (!refA || !refB) {
    console.error("Usage: corpus:agreement -- <refA> <refB> [--threshold=0.85] [--sure=0.95] [--confirm] [--out=FILE]");
    process.exit(1);
  }
  const threshold = Number(argFlag("threshold") ?? 0.85);
  const sure = Number(argFlag("sure") ?? 0.95);
  const confirm = hasFlag("confirm");

  const A = resolveRef(refA);
  const B = resolveRef(refB);
  const [a, b] = await Promise.all([loadGraph(A.label, A.url), loadGraph(B.label, B.url)]);
  const noEmbedding = [...a.claims, ...b.claims].filter((c) => !c.embedding).length;
  if (noEmbedding > 0) {
    console.warn(`  note: ${noEmbedding} claim(s) have no stored embedding and can only match by exact text.`);
  }

  let { pairs, ambiguous } = buildMatching(a, b, { threshold, sure });
  let judgeCostMicroUsd = 0;
  let dropped: Array<MatchedPair & { reasoning: string }> = [];
  if (confirm && ambiguous.length > 0) {
    console.log(`  confirming ${ambiguous.length} ambiguous pair(s) with ${loadConfig().judgeModel}…`);
    const { value, billedMicroUsd } = await withCostMeter(() => confirmPairs(ambiguous, a, b));
    judgeCostMicroUsd = billedMicroUsd;
    dropped = value.dropped;
    const droppedKeys = new Set(dropped.map((d) => `${d.a}|${d.b}`));
    const keptKeys = new Map(value.kept.map((k) => [`${k.a}|${k.b}`, k]));
    pairs = pairs
      .filter((p) => !droppedKeys.has(`${p.a}|${p.b}`))
      .map((p) => keptKeys.get(`${p.a}|${p.b}`) ?? p);
    ambiguous = [];
  }

  const report = graphAgreement(a, b, pairs);
  console.log();
  console.log(renderAgreement(report));
  if (ambiguous.length > 0) {
    console.log(
      `  note: ${ambiguous.length} pair(s) matched in the ambiguous band [${threshold}, ${sure}) and were KEPT unconfirmed — pass --confirm to judge them.`
    );
  }
  if (dropped.length > 0) {
    console.log(`  judge rejected ${dropped.length} pair(s):`);
    for (const d of dropped) console.log(`    ${d.a.slice(0, 8)} ≠ ${d.b.slice(0, 8)} (${d.similarity.toFixed(3)}): ${d.reasoning}`);
  }
  if (confirm) console.log(`  judge cost: ${formatMicroUsd(judgeCostMicroUsd)}`);

  const full = {
    generatedAt: new Date().toISOString(),
    a: A.label,
    b: B.label,
    threshold,
    sure,
    confirm,
    ambiguousKept: ambiguous.length,
    dropped,
    pairs,
    report,
    judgeCostMicroUsd,
  };
  const out = argFlag("out");
  if (out) {
    writeFileSync(out, JSON.stringify(full, null, 2));
    console.log(`  written: ${out}`);
  }
  try {
    const cfg = loadConfig();
    await getDb().insert(evalRuns).values({
      cluster: "agreement",
      kind: "agreement",
      config: {
        pipelineEpoch: cfg.pipelineEpoch,
        gitCommit: gitCommit(),
        a: A.label,
        b: B.label,
        threshold,
        sure,
        confirm,
        models: { judge: cfg.judgeModel },
      },
      scorecard: full,
    });
  } catch (err) {
    console.warn("[agreement] eval-run registry write failed:", err instanceof Error ? err.message : err);
  }
  console.log();
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
