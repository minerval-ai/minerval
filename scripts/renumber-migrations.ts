/**
 * npm run db:renumber [-- --base <ref>]
 *
 * For a branch whose migrations collide with ones that reached main first.
 * Merge main, leave the conflicts in src/db/migrations as they are, and run
 * this:
 *
 *   git fetch origin main
 *   git merge origin/main
 *   npm run db:renumber
 *   git commit
 *
 * It moves this branch's migrations to the numbers after main's, gives them a
 * fresh journal timestamp (so a database that has run main's migrations still
 * runs these; see scripts/migrations-lib.ts), rebuilds the journal and the
 * snapshots, stages the result, and then checks that the last snapshot agrees
 * with src/db/schema.ts. Conflicts outside the migrations folder, schema.ts
 * among them, are still yours to resolve, and should be resolved first.
 *
 * Safe to run again, and a no-op on a branch that is already in order.
 */
import { resolve } from "path";
import { migrationFolderProblems, renumberMigrations, schemaDrift, MIGRATIONS_DIR } from "./migrations-lib.js";

const repo = resolve(import.meta.dirname, "..");
const baseFlag = process.argv.indexOf("--base");
const base = (baseFlag === -1 ? undefined : process.argv[baseFlag + 1]) ?? "origin/main";

try {
  const { moved, changed, staleReferences } = renumberMigrations(repo, base);
  if (moved.length === 0) {
    console.log(`This branch adds no migrations beyond ${base}. Nothing to do.`);
  } else if (!changed) {
    console.log(`This branch's migrations already follow ${base}'s. Nothing to do.`);
  } else {
    for (const { from, to } of moved) console.log(from === to ? `  ${to} (number kept)` : `  ${from} -> ${to}`);
    console.log(`Journal and snapshots rebuilt and staged (${MIGRATIONS_DIR}).`);
    if (staleReferences.length > 0) {
      console.log("\nThese still name a migration by its old number:");
      for (const line of staleReferences) console.log(`  ${line}`);
    }
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const problems = migrationFolderProblems(resolve(repo, MIGRATIONS_DIR));
const drift = problems.length === 0 ? schemaDrift(repo) : null;
if (problems.length > 0) {
  console.error(`\n${problems.join("\n")}`);
  process.exit(1);
}
if (drift !== null) {
  console.error(
    "\nsrc/db/schema.ts and the latest snapshot disagree. If schema.ts still has merge conflicts, resolve " +
      "them and run this again. Otherwise the schema has a change no migration carries: npm run db:generate.\n\n" +
      drift,
  );
  process.exit(1);
}
console.log("The migrations folder is in order and matches src/db/schema.ts.");
