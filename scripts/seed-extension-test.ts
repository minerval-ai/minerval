/**
 * Seed two assessed claims so the extension pipeline (issue #72) has graph
 * state to judge against. Throwaway manual-test helper, not product code.
 */
import "../src/load-env.js";
import { getDb, closeDb } from "../src/db/client.js";
import { claims, assessments } from "../src/db/schema.js";
import { generateEmbedding } from "../src/services/embedding-service.js";

const SEEDS = [
  {
    text: "The MMR vaccine does not cause autism.",
    claimType: "empirical_derived",
    status: "verified",
    confidence: 0.97,
    reasoning:
      "Large cohort studies covering >1.2M children (e.g. Hviid et al. 2019, " +
      "Taylor et al. 2014 meta-analysis) find no association between MMR " +
      "vaccination and autism; the originating 1998 Wakefield study was " +
      "retracted for data fabrication and its author struck off. Evidence " +
      "chain traces to primary sources with no credible counter-evidence.",
  },
  {
    text: "Moderate red wine consumption improves cardiovascular health.",
    claimType: "causal",
    status: "inconclusive",
    confidence: 0.55,
    reasoning:
      "Observational studies show a J-shaped association, but Mendelian " +
      "randomization studies (e.g. Millwood et al. 2019) and sick-quitter " +
      "confounding critiques undercut a causal reading; recent WHO position " +
      "is that no level of alcohol is safely beneficial. Credible evidence " +
      "and argument on multiple sides.",
  },
];

const db = getDb();
for (const seed of SEEDS) {
  const embedding = await generateEmbedding(seed.text);
  const [claim] = await db
    .insert(claims)
    .values({
      text: seed.text,
      claimType: seed.claimType,
      embedding,
      stewardState: "done",
      decompositionStatus: "complete",
      importance: 0.8,
    })
    .returning();
  await db.insert(assessments).values({
    claimId: claim!.id,
    status: seed.status,
    confidence: seed.confidence,
    reasoningTrace: seed.reasoning,
    isCurrent: true,
    trigger: "seed",
  });
  console.log(`${seed.status.padEnd(10)} ${claim!.id}  ${seed.text}`);
}
await closeDb();
