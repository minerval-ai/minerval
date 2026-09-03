/**
 * Tag the pre-skills cohort of claims with domains (docs/mathematics.md
 * §3.4), so the claims that predate `claims.domains` carry the skill their
 * Stewards should run under.
 *
 * Method: for each skill, a seed set of canonical forms typical of its domain
 * is embedded and averaged into a centroid; every active, embedded claim
 * whose cosine similarity to the centroid clears the threshold is tagged with
 * that skill's domain, `domains_source = 'backfill'`. A Steward's judgment
 * supersedes the backfill (rows with `domains_source = 'steward'` are never
 * touched), and so does the Extractor's prior; only untagged rows and earlier
 * backfills are written. The tag selects a prompt, not a verdict: a wrong tag
 * costs one skilled pass, which the Steward corrects with set_claim_domains.
 *
 * Safe by default: prints what it WOULD tag, with the borderline cases, and
 * exits. Pass --write to apply.
 *
 *   npx tsx scripts/backfill-claim-domains.ts                      # dry run
 *   npx tsx scripts/backfill-claim-domains.ts --threshold=0.45     # looser
 *   npx tsx scripts/backfill-claim-domains.ts --skill=mathematics  # one skill
 *   npx tsx scripts/backfill-claim-domains.ts --write              # apply
 */
import "dotenv/config";
import { rawQuery, closeDb } from "../src/db/client.js";
import { generateEmbeddings } from "../src/services/embedding-service.js";
import { listSkills } from "../src/llm/prompts/skills.js";

/**
 * Canonical forms typical of each skill's domain: propositions in the
 * constitution's canonical style, spanning the domain's kinds (settled
 * theorems, open conjectures, independence results, claims about proofs) so
 * the centroid sits in the middle of the domain rather than at one corner.
 * A domain the map does not name gets no backfill; tag it by hand or with
 * the Steward.
 */
const SEED_CANONICAL_FORMS: Record<string, string[]> = {
  mathematics: [
    "There are infinitely many prime numbers.",
    "Every even integer greater than 2 is the sum of two primes.",
    "There are infinitely many primes p such that p + 2 is prime.",
    "The continuum hypothesis is independent of ZFC.",
    "Every non-trivial zero of the Riemann zeta function has real part one half.",
    "Every simply connected closed 3-manifold is homeomorphic to the 3-sphere.",
    "No three positive integers satisfy a^n + b^n = c^n for any integer n greater than 2.",
    "Every planar graph is four-colorable.",
    "The square root of 2 is irrational.",
    "P is not equal to NP.",
    "Every bounded sequence of real numbers has a convergent subsequence.",
    "The Collatz iteration reaches 1 from every positive integer.",
    "Every finite group of odd order is solvable.",
    "The abc conjecture implies Fermat's Last Theorem for sufficiently large exponents.",
    "Inter-universal Teichmuller theory proves the abc conjecture.",
    "Every continuous function on a closed interval attains its maximum.",
    "The Kepler conjecture on sphere packing has been proven and machine-checked.",
    "There is no largest cardinal number.",
    "Every positive integer is a sum of at most four squares.",
    "The Navier-Stokes equations have smooth solutions for all time in three dimensions.",
  ],
};

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=").slice(1).join("=");
}

function centroid(vectors: number[][]): number[] {
  const dims = vectors[0]!.length;
  const sum = new Array<number>(dims).fill(0);
  for (const v of vectors) for (let i = 0; i < dims; i++) sum[i]! += v[i]!;
  const mean = sum.map((x) => x / vectors.length);
  const norm = Math.sqrt(mean.reduce((acc, x) => acc + x * x, 0)) || 1;
  return mean.map((x) => x / norm);
}

function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(8)).join(",")}]`;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const threshold = Number(argValue("threshold") ?? "0.5");
  const onlySkill = argValue("skill");
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new Error(`--threshold must be a number in (0, 1); got ${argValue("threshold")}`);
  }

  const skills = listSkills().filter((s) => !onlySkill || s.name === onlySkill);
  if (skills.length === 0) {
    throw new Error(`no skill matches --skill=${onlySkill}`);
  }

  let totalTagged = 0;
  for (const skill of skills) {
    const seeds = SEED_CANONICAL_FORMS[skill.name];
    if (!seeds || seeds.length === 0) {
      console.log(`skill ${skill.name}: no seed set; skipping (tag by Steward or by hand)`);
      continue;
    }
    // A skill may list several activating domains; the backfill writes the
    // first (its own name in every skill so far).
    const domain = skill.domains[0]!;
    console.log(`\nskill ${skill.name} (domain "${domain}"): ${seeds.length} seeds, threshold ${threshold}`);

    const seedVectors = await generateEmbeddings(seeds);
    const center = centroid(seedVectors);

    // Only rows the backfill may write: untagged, or tagged by an earlier
    // backfill. An Extractor prior or a Steward judgment stands.
    const rows = await rawQuery<{
      id: string;
      text: string;
      domains: string[];
      domains_source: string | null;
      similarity: number;
    }>(
      `SELECT c.id, c.text, c.domains, c.domains_source,
              1 - (c.embedding <=> $1::vector) AS similarity
         FROM claims c
        WHERE c.state = 'active'
          AND c.embedding IS NOT NULL
          AND (c.domains_source IS NULL OR c.domains_source = 'backfill')
        ORDER BY similarity DESC
        LIMIT 5000`,
      [toVectorLiteral(center)]
    );

    const above = rows.filter((r) => r.similarity >= threshold);
    const toTag = above.filter((r) => !r.domains.includes(domain));
    const already = above.length - toTag.length;
    const borderline = rows.filter(
      (r) => r.similarity < threshold && r.similarity >= threshold - 0.05
    );

    console.log(`  candidates scanned: ${rows.length}`);
    console.log(`  above threshold: ${above.length} (${already} already tagged)`);
    for (const r of toTag.slice(0, 15)) {
      console.log(`    + ${r.similarity.toFixed(3)}  ${r.id}  "${r.text.slice(0, 70)}"`);
    }
    if (toTag.length > 15) console.log(`    … and ${toTag.length - 15} more`);
    if (borderline.length > 0) {
      console.log(`  just below threshold (not tagged), for calibration:`);
      for (const r of borderline.slice(0, 10)) {
        console.log(`    - ${r.similarity.toFixed(3)}  ${r.id}  "${r.text.slice(0, 70)}"`);
      }
    }

    if (!write || toTag.length === 0) continue;

    // array_append keeps any other backfilled domain the row already carries;
    // the source becomes 'backfill' either way, which a Steward's
    // set_claim_domains later overwrites.
    const ids = toTag.map((r) => r.id);
    await rawQuery(
      `UPDATE claims
          SET domains = (
                SELECT array_agg(DISTINCT d ORDER BY d)
                  FROM unnest(array_append(domains, $2::text)) AS d
              ),
              domains_source = 'backfill',
              updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [ids, domain]
    );
    totalTagged += ids.length;
    console.log(`  tagged ${ids.length} claims with "${domain}"`);
  }

  if (!write) {
    console.log("\nDry run: nothing written. Re-run with --write to apply.");
  } else {
    console.log(`\nTagged ${totalTagged} claim(s). Their Stewards pick up the skill on their next pass.`);
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
