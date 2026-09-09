/**
 * Seed the tag vocabulary from clusters in the claim embedding space (#272).
 *
 * Why seed at all: the tagger reuses existing tags and mints only when none
 * fits, so the first claims tagged decide the vocabulary's grain. Left to
 * itself, a cold start mints claim-shaped tags for the first hundred claims
 * and broad ones only later. Seeding a few dozen broad tags from the
 * graph's own structure first gives every claim a field-level tag to reuse.
 *
 * Method: spherical k-means over every active claim's embedding (k from
 * --k, default ~sqrt(n/2) clamped to [4, 40]); for each cluster, the
 * exemplars nearest its centroid plus a spread from its breadth are shown
 * to the tagger model, which names the topic they share or declines an
 * incoherent cluster; the name goes through tag-service.findOrCreateTag,
 * which resolves it by slug, then by meaning, before minting. The script
 * mints VOCABULARY only: it attaches nothing. Assignment is the tagger's
 * judgment per claim (the tagging drain), which starts as soon as the
 * scheduler ticks.
 *
 * Safe by default: prints the clusters, their proposed names, and how each
 * would resolve, then exits. Pass --write to mint.
 *
 *   npx tsx scripts/seed-tags-from-clusters.ts                 # dry run
 *   npx tsx scripts/seed-tags-from-clusters.ts --k=24          # fixed k
 *   npx tsx scripts/seed-tags-from-clusters.ts --min-size=5    # skip tiny clusters
 *   npx tsx scripts/seed-tags-from-clusters.ts --write         # mint tags
 */
import "dotenv/config";
import { rawQuery, closeDb } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { completeStructured } from "../src/llm/client.js";
import { withAgent } from "../src/llm/usage-context.js";
import {
  CLUSTER_NAME_SCHEMA,
  getClusterNamingPrompt,
  type ClusterNameProposal,
} from "../src/llm/prompts/tagger.js";
import {
  chooseK,
  kmeans,
  parseVectorLiteral,
  pickExemplars,
  summarizeClusters,
} from "../src/services/tag-clustering-service.js";
import {
  findOrCreateTag,
  searchTags,
  slugifyTag,
} from "../src/services/tag-service.js";

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=").slice(1).join("=");
}

/** Clusters below this cohesion are named only with a warning. */
const LOW_COHESION = 0.35;

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const minSize = Number(argValue("min-size") ?? "3");
  const seed = Number(argValue("seed") ?? "272");
  const config = loadConfig();
  const model = argValue("model") ?? config.taggerModel;

  const rows = await rawQuery<{ id: string; text: string; embedding: string }>(
    `SELECT id, text, embedding::text AS embedding
       FROM claims
      WHERE state = 'active' AND merged_into IS NULL AND embedding IS NOT NULL
      ORDER BY importance DESC
      LIMIT 20000`
  );
  if (rows.length === 0) {
    console.log("No embedded active claims; nothing to cluster.");
    await closeDb();
    return;
  }
  const vectors = rows.map((r) => parseVectorLiteral(r.embedding));
  const k = Number(argValue("k") ?? chooseK(rows.length));
  console.log(`${rows.length} claims, k = ${k}, seed ${seed}, model ${model}`);

  const result = kmeans(vectors, k, { seed });
  const clusters = summarizeClusters(vectors, result).sort((a, b) => b.size - a.size);
  console.log(`${clusters.length} non-empty clusters after ${result.iterations} iteration(s)\n`);

  let minted = 0;
  let reused = 0;
  let declined = 0;
  for (const cluster of clusters) {
    const header = `cluster ${cluster.index}: ${cluster.size} claims, cohesion ${cluster.cohesion.toFixed(2)}`;
    if (cluster.size < minSize) {
      console.log(`${header} — below --min-size=${minSize}, skipped`);
      continue;
    }
    const exemplarIdx = pickExemplars(cluster);
    const exemplars = exemplarIdx.map((i) => rows[i]!.text);
    // Existing tags near the centroid, so the model reuses rather than renames.
    let nearby: Array<{ name: string; description: string; similarity: number }> = [];
    try {
      nearby = (await searchTags("", { embedding: cluster.centroid, limit: 5, minSimilarity: 0.3 })).map(
        (t) => ({ name: t.name, description: t.description, similarity: t.similarity })
      );
    } catch {
      // No vocabulary yet, or search failed; naming proceeds without hints.
    }

    const proposal = await withAgent("tagger", () =>
      completeStructured<ClusterNameProposal>({
        messages: [
          {
            role: "user",
            content: getClusterNamingPrompt({ exemplars, clusterSize: cluster.size, nearby }),
          },
        ],
        schema: CLUSTER_NAME_SCHEMA,
        schemaName: "cluster_name",
        system:
          "You name topic clusters in a knowledge graph of claims. A tag names what claims are ABOUT, at the grain of a field or a subject; it is never a restatement of one claim and never a judgment about truth.",
        model,
        maxTokens: 400,
      })
    );

    console.log(header + (cluster.cohesion < LOW_COHESION ? " (low cohesion)" : ""));
    for (const e of exemplars.slice(0, 4)) console.log(`    · ${e.slice(0, 90)}`);
    if (!proposal.coherent || !proposal.name) {
      console.log(`  → declined: ${proposal.reasoning}`);
      declined++;
      continue;
    }
    const slug = slugifyTag(proposal.name);
    const nearbyHit = nearby.find((t) => slugifyTag(t.name) === slug);
    console.log(
      `  → "${proposal.name}"${nearbyHit ? " (existing)" : ""}: ${proposal.description ?? "(reuse)"}\n     ${proposal.reasoning}`
    );
    if (!write) continue;

    const r = await findOrCreateTag({
      name: proposal.name,
      description: proposal.description ?? undefined,
      createdBy: "cluster_seed",
    });
    if (r.resolution === "created") minted++;
    else reused++;
    console.log(
      `     ${r.resolution === "created" ? "minted" : `resolved to existing "${r.tag.name}" (${r.resolution})`}`
    );
  }

  console.log(
    write
      ? `\nMinted ${minted} tag(s), reused ${reused}, declined ${declined}. The tagging drain attaches them per claim.`
      : `\nDry run: nothing written (${declined} cluster(s) declined). Re-run with --write to mint.`
  );
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
