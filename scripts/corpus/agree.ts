/**
 * Compare two corpus graphs (#334 L2) — the CLI over the graph-agreement metric.
 *
 * Snapshots (`corpus:snapshot save <name>`) are what make this practical: drain
 * a corpus once, snapshot it, change ONE thing, drain again, and ask how far
 * the graph moved. That single question is S3's metamorphic invariances, S7's
 * fidelity-vs-reference, S4's attack-arm displacement, and #170's path
 * independence — the suites differ in what they vary, not in what they measure.
 *
 * Usage:
 *   npm run corpus:agree -- <refA> <refB> [flags]
 *
 * A ref is `snap:<name>` for a snapshot database, or `current` (default for
 * refB) for the live corpus DB. refA is the REFERENCE: recall is measured
 * against it, so put the baseline first.
 *
 * Flags:
 *   --pairing=embedding|text   how claims are paired across graphs
 *                              (default: embedding, falling back per-claim to
 *                              nothing when a vector is missing)
 *   --min-similarity=0.4       cosine floor for embedding pairing
 *   --json                     emit the full agreement object
 *   --limit-items=20           cap the per-item lists printed
 *
 * Reads only — it never writes to either database.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import pg from "pg";
import { CORPUS_DATABASE_URL } from "./lib.js";
import { dbNameOf, snapshotDbName } from "./snapshot-core.js";
import type { GraphSnapshot } from "./metrics.js";
import {
  computeGraphAgreement,
  formatAgreement,
  pairByEmbedding,
  pairByNormalizedText,
  type ClaimPairing,
} from "./agreement.js";

function urlForRef(ref: string): { url: string; label: string } {
  if (ref === "current" || ref === "db") {
    return { url: CORPUS_DATABASE_URL, label: `current (${dbNameOf(CORPUS_DATABASE_URL)})` };
  }
  if (ref.startsWith("snap:")) {
    const name = ref.slice("snap:".length);
    const db = snapshotDbName(dbNameOf(CORPUS_DATABASE_URL), name);
    const url = new URL(CORPUS_DATABASE_URL);
    url.pathname = `/${db}`;
    return { url: url.toString(), label: `snapshot "${name}" (${db})` };
  }
  throw new Error(`Unrecognized ref "${ref}" — use snap:<name> or current.`);
}

/**
 * Pull the same shape `score.ts` builds, plus embeddings, from an ARBITRARY
 * database — the two graphs live in different databases by construction, so
 * this can't go through the app's pinned client.
 */
async function loadGraph(
  url: string
): Promise<{ graph: GraphSnapshot; embeddings: Map<string, number[]> }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const claims = await client.query(
      `SELECT id, text, claim_type, importance, created_by, embedding::text AS embedding
         FROM claims`
    );
    const edges = await client.query(
      `SELECT parent_claim_id AS parent, child_claim_id AS child, relation_type AS rel
         FROM claim_relationships`
    );
    const assessments = await client.query(
      `SELECT claim_id AS "claimId", status, confidence, reasoning_trace AS "reasoningTrace"
         FROM assessments WHERE is_current`
    );
    const instances = await client.query(`SELECT claim_id AS "claimId" FROM claim_instances`);
    const words = await client.query(
      `SELECT COALESCE(SUM(array_length(regexp_split_to_array(trim(raw_content), '\\s+'), 1)), 0)::int AS n
         FROM sources WHERE raw_content IS NOT NULL`
    );

    const embeddings = new Map<string, number[]>();
    for (const row of claims.rows) {
      // pgvector renders as "[0.1,0.2,…]"; a claim may legitimately have none.
      if (typeof row.embedding !== "string") continue;
      const parsed = row.embedding
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(Number);
      if (parsed.length && parsed.every((n: number) => Number.isFinite(n))) {
        embeddings.set(row.id, parsed);
      }
    }

    return {
      graph: {
        claims: claims.rows.map((c) => ({
          id: c.id,
          text: c.text,
          claimType: c.claim_type,
          importance: Number(c.importance),
          createdBy: c.created_by,
        })),
        edges: edges.rows,
        assessments: assessments.rows.map((a) => ({
          claimId: a.claimId,
          status: a.status,
          confidence: Number(a.confidence),
          reasoningTrace: a.reasoningTrace ?? "",
        })),
        instances: instances.rows,
        sourceWords: words.rows[0]?.n ?? 0,
      },
      embeddings,
    };
  } finally {
    await client.end();
  }
}

function textOf(graph: GraphSnapshot, id: string): string {
  const claim = graph.claims.find((c) => c.id === id);
  const text = claim?.text ?? "(unknown)";
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Map(
    args.filter((a) => a.startsWith("--")).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k!, v ?? "true"];
    })
  );
  const positional = args.filter((a) => !a.startsWith("--"));
  const refA = positional[0];
  const refB = positional[1] ?? "current";
  if (!refA) {
    console.error(
      "Usage: npm run corpus:agree -- <refA> [refB] [--pairing=embedding|text]\n" +
        "  refs: snap:<name> | current"
    );
    process.exit(1);
  }

  const a = urlForRef(refA);
  const b = urlForRef(refB);
  const limit = Number(flags.get("limit-items") ?? 20);

  const [left, right] = await Promise.all([loadGraph(a.url), loadGraph(b.url)]);

  const pairingMode = flags.get("pairing") ?? "embedding";
  let pairing: ClaimPairing;
  if (pairingMode === "text") {
    pairing = pairByNormalizedText(left.graph, right.graph);
  } else {
    // Claim ids are uuids, so a key collision here means the two graphs share
    // a literal claim — which is exactly what a snapshot-vs-current comparison
    // looks like, and there the vectors are identical. Hence one map; but the
    // MISSING count has to be taken per graph, or that benign overlap reads as
    // every claim lacking an embedding.
    const merged = new Map([...left.embeddings, ...right.embeddings]);
    const missing =
      left.graph.claims.filter((c) => !left.embeddings.has(c.id)).length +
      right.graph.claims.filter((c) => !right.embeddings.has(c.id)).length;
    if (missing > 0) {
      console.warn(
        `  ⚠ ${missing} claim(s) have no embedding and cannot pair — they will ` +
          `count as unmatched. Use --pairing=text if this graph predates embeddings.`
      );
    }
    pairing = pairByEmbedding(
      left.graph,
      right.graph,
      merged,
      Number(flags.get("min-similarity") ?? 0.4)
    );
  }

  const agreement = computeGraphAgreement(left.graph, right.graph, pairing);

  if (flags.has("json")) {
    console.log(JSON.stringify(agreement, null, 2));
    return;
  }

  console.log(`\n=== graph agreement ===`);
  console.log(`  A (reference): ${a.label}`);
  console.log(`  B (compared):  ${b.label}`);
  console.log(`  pairing:       ${pairingMode}\n`);
  console.log(`  ${formatAgreement(agreement)}\n`);

  const { claimSet, structure, credence, attribution } = agreement;
  console.log(
    `  claim set   matched ${claimSet.matched}  ` +
      `precision ${claimSet.precision.toFixed(3)}  recall ${claimSet.recall.toFixed(3)}`
  );
  if (claimSet.onlyInA.length) {
    console.log(`    only in A (${claimSet.onlyInA.length}):`);
    for (const id of claimSet.onlyInA.slice(0, limit)) {
      console.log(`      - ${textOf(left.graph, id)}`);
    }
  }
  if (claimSet.onlyInB.length) {
    console.log(`    only in B (${claimSet.onlyInB.length}):`);
    for (const id of claimSet.onlyInB.slice(0, limit)) {
      console.log(`      + ${textOf(right.graph, id)}`);
    }
  }

  console.log(
    `\n  structure   shared ${structure.shared}  only-A ${structure.onlyInA}  ` +
      `only-B ${structure.onlyInB}  rel-mismatch ${structure.relationMismatches}`
  );

  console.log(
    agreement.axesCompared.credence
      ? `\n  credence    comparable ${credence.comparable}  ` +
          `agreement ${(credence.statusAgreement * 100).toFixed(0)}%  ` +
          `polar flips ${credence.polarFlips}`
      : `\n  credence    no claim is assessed on both sides — nothing to compare`
  );
  for (const d of credence.disagreements.slice(0, limit)) {
    console.log(
      `      ${d.statusA} → ${d.statusB}  (${d.confidenceA.toFixed(2)} → ` +
        `${d.confidenceB.toFixed(2)})  ${textOf(left.graph, d.a)}`
    );
  }

  const buckets = Object.entries(attribution);
  if (buckets.length) {
    console.log(`\n  attribution (divergence by claim's creating agent)`);
    for (const [agent, counts] of buckets.sort((x, y) => x[0].localeCompare(y[0]))) {
      console.log(
        `      ${agent.padEnd(14)} only-A ${counts.unmatchedA}  ` +
          `only-B ${counts.unmatchedB}  status-disagreements ${counts.statusDisagreements}`
      );
    }
  }
  console.log();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
