/**
 * Cheap, isolated iteration loop for the EXTRACTOR — the fast inner loop for
 * tuning claim-extraction quality.
 *
 * Unlike `run.ts`, this touches NO database, NO embeddings, and NO governance.
 * Extraction is a single Anthropic call, so the only thing you need is
 * `ANTHROPIC_API_KEY` in your env or .env — no Postgres, no OPENAI_API_KEY. That
 * makes one iteration ~one cheap LLM call instead of a full
 * Extract→onboard→Steward(decompose+assess) run. (Decomposition now lives in the
 * Claim Steward, which needs the graph, so it isn't exercised offline here.)
 *
 * It prints each extracted claim's original→canonical pair with diagnostics
 * (word count, argument-word / definition flags) plus a summary, so you can
 * judge the prompt changes against the quality bar directly.
 *
 * Usage:
 *   tsx scripts/corpus/extract-only.ts [postId] [flags]
 *
 * Flags:
 *   --cluster=NAME    corpus cluster (default: lethalities)
 *   --max=N           cap extracted claims (EXTRACTION_MAX_CLAIMS; 0 = unlimited)
 *   --chars=N         only feed the first N characters of the post (cheap smoke)
 *
 * Examples:
 *   tsx scripts/corpus/extract-only.ts                       # AGI Ruin, all claims
 *   tsx scripts/corpus/extract-only.ts --max=8
 *   tsx scripts/corpus/extract-only.ts CoZhXrhpQxpy9xw9y --chars=6000
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();
// Extraction never connects to a DB; satisfy config validation with a dummy URL
// so we don't require a running Postgres just to exercise the extractor prompt.
process.env.DATABASE_URL ??=
  "postgresql://unused:unused@localhost:5432/unused_extract_only";
process.env.ENVIRONMENT ??= "development";

import { readFileSync, existsSync } from "node:fs";
// lib.js re-pins DATABASE_URL to the (disposable) corpus DB as a side effect.
// That's harmless here because extraction/offline-decomposition never connect;
// we only borrow its CLI + manifest helpers.
import { argFlag, loadManifest, postMarkdownPath } from "./lib.js";
import { extractClaims } from "../../src/llm/agents/extractor.js";
import type { ExtractedClaim } from "../../src/llm/agents/extractor.js";

const ARG_WORDS =
  /\b(therefore|thus|hence|implies?|implying|suggest(?:s|ing)?|because|since|so that|such that|entails?|consequently|as a result|which means)\b/i;

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function flags(canonical: string, type: string): string {
  const f: string[] = [];
  if (ARG_WORDS.test(canonical)) f.push("ARG?");
  if (/^["']?[^"']+["']?\s+(means|is defined as|refers to)\b/i.test(canonical))
    f.push("DEF?");
  if (type === "definitional") f.push("def-type");
  const w = words(canonical);
  if (w > 25) f.push(`LONG(${w}w)`);
  return f.length ? `  [${f.join(" ")}]` : "";
}

function printClaim(i: number, c: ExtractedClaim): void {
  const w = words(c.proposed_canonical_form);
  console.log(
    `\n${String(i + 1).padStart(2)}. (${c.claim_type}, conf ${c.confidence}, imp ${c.importance}, cont ${c.contestation}, ${w}w)` +
      flags(c.proposed_canonical_form, c.claim_type)
  );
  console.log(`    text:  ${c.verbatim_text.slice(0, 160)}`);
  console.log(`    canon: ${c.proposed_canonical_form}`);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY (set it in your env or .env).");
    process.exit(1);
  }
  const cluster = argFlag("cluster") ?? "lethalities";
  const postId = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const manifest = loadManifest(cluster);
  const post = postId
    ? manifest.posts.find((p) => p.id === postId)
    : manifest.posts[0];
  if (!post) {
    console.error(`Post ${postId ?? "(first)"} not found in cluster ${cluster}.`);
    process.exit(1);
  }
  const mdPath = postMarkdownPath(cluster, post.id);
  if (!existsSync(mdPath)) {
    console.error(`Missing markdown for ${post.id}; run \`npm run corpus:fetch\`.`);
    process.exit(1);
  }
  let content = readFileSync(mdPath, "utf8");
  const chars = argFlag("chars");
  if (chars) content = content.slice(0, Number(chars));

  const max = Number(argFlag("max") ?? "0");

  console.log(`\n=== extract-only: ${post.title} (${post.author}) ===`);
  console.log(`post ${post.id} · ${content.length} chars · max=${max || "∞"}\n`);

  const claims = await extractClaims({
    content,
    sourceType: "LessWrong post",
    maxClaims: max,
  });

  claims.forEach((c, i) => printClaim(i, c));

  // Quantitative signal for fast iteration.
  const wc = claims.map((c) => words(c.proposed_canonical_form));
  const avg = wc.length ? (wc.reduce((a, b) => a + b, 0) / wc.length).toFixed(1) : "0";
  const maxW = wc.length ? Math.max(...wc) : 0;
  const argLike = claims.filter((c) => ARG_WORDS.test(c.proposed_canonical_form)).length;
  const defLike = claims.filter(
    (c) =>
      c.claim_type === "definitional" ||
      /^["']?[^"']+["']?\s+(means|is defined as|refers to)\b/i.test(c.proposed_canonical_form)
  ).length;
  console.log(`\n--- summary ---`);
  console.log(`claims: ${claims.length}`);
  console.log(`canonical-form words: avg ${avg}, max ${maxW}`);
  console.log(`argument-shaped (therefore/implies/…): ${argLike}`);
  console.log(`definition-shaped: ${defLike}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
