/**
 * Embed the requests that have no embedding: those filed before
 * requests.embedding existed (migration 0077), and any filed or revised while
 * the embedder was down. Search finds an unembedded request by keyword only,
 * and ranks it after every embedded one.
 *
 * Embeds the same text the request service does (requestEmbeddingText: the
 * ask and the why), in batches through generateEmbeddings. Cheap: one
 * small embedding per request, and there are few requests.
 *
 * Safe by default: prints how many it WOULD embed and exits. Pass --write
 * to apply. Re-running is harmless; it only touches rows still NULL.
 *
 *   npx tsx scripts/backfill-request-embeddings.ts           # dry run
 *   npx tsx scripts/backfill-request-embeddings.ts --write   # apply
 */
import "../src/load-env.js";
import { rawQuery, closeDb } from "../src/db/client.js";
import { generateEmbeddings } from "../src/services/embedding-service.js";
import { requestEmbeddingText } from "../src/services/request-service.js";

const BATCH = 100;

async function main(): Promise<void> {
  const write = process.argv.includes("--write");

  const rows = await rawQuery<{ id: string; ask: string; why: string }>(
    `SELECT id, ask, why FROM requests WHERE embedding IS NULL ORDER BY created_at`
  );
  console.log(`Requests without an embedding: ${rows.length}`);
  for (const r of rows.slice(0, 15)) console.log(`  ${r.id}  "${r.ask.slice(0, 70)}"`);
  if (rows.length > 15) console.log(`  … and ${rows.length - 15} more`);

  if (rows.length === 0 || !write) {
    if (rows.length > 0) console.log("\nDry run — re-run with --write to embed them.");
    await closeDb();
    return;
  }

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vectors = await generateEmbeddings(batch.map((r) => requestEmbeddingText(r.ask, r.why)));
    for (const [j, r] of batch.entries()) {
      // Only a row still unembedded and still saying what was embedded: one
      // revised meanwhile carries its own embedding, or needs a fresh one.
      await rawQuery(
        `UPDATE requests SET embedding = $2::vector
          WHERE id = $1 AND embedding IS NULL AND ask = $3 AND why = $4`,
        [r.id, `[${vectors[j]!.join(",")}]`, r.ask, r.why]
      );
    }
    done += batch.length;
    console.log(`  embedded ${done}/${rows.length}`);
  }
  console.log(`\nEmbedded ${done} requests.`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
