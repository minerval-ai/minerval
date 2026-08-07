/**
 * Snapshot/restore CLI for the corpus database (#334 L1).
 *
 * A snapshot is a template-database copy (`<corpus>_snap_<name>`): seconds to
 * take, seconds to restore, no re-ingestion. This is what makes metamorphic
 * re-runs (#295) and multi-episode adversarial work (#302) affordable — drain
 * a corpus once, snapshot it, then restore between experiments.
 *
 * Usage:
 *   npm run corpus:snapshot -- save <name>      # copy corpus DB → snapshot
 *   npm run corpus:snapshot -- restore <name>   # replace corpus DB from snapshot
 *   npm run corpus:snapshot -- list
 *   npm run corpus:snapshot -- drop <name>
 *
 * Operations force-terminate other connections on the databases they touch
 * (Postgres template semantics), so never run one mid-drain. The main
 * 'episteme' database is refused by name at the core layer.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { CORPUS_DATABASE_URL, positional } from "./lib.js";
import {
  dropSnapshot,
  listSnapshots,
  restoreSnapshot,
  saveSnapshot,
} from "./snapshot-core.js";

async function main(): Promise<void> {
  const command = positional(0);
  const name = positional(1);

  switch (command) {
    case "save": {
      if (!name) throw new Error("Usage: corpus:snapshot -- save <name>");
      const snap = await saveSnapshot(CORPUS_DATABASE_URL, name);
      console.log(`✓ snapshot "${name}" saved (database ${snap})`);
      return;
    }
    case "restore": {
      if (!name) throw new Error("Usage: corpus:snapshot -- restore <name>");
      await restoreSnapshot(CORPUS_DATABASE_URL, name);
      console.log(`✓ corpus DB restored from snapshot "${name}"`);
      return;
    }
    case "list": {
      const snaps = await listSnapshots(CORPUS_DATABASE_URL);
      if (snaps.length === 0) {
        console.log("(no snapshots)");
        return;
      }
      for (const s of snaps) {
        console.log(`  ${s.name.padEnd(24)} ${s.sizePretty.padStart(10)}  ${s.database}`);
      }
      return;
    }
    case "drop": {
      if (!name) throw new Error("Usage: corpus:snapshot -- drop <name>");
      await dropSnapshot(CORPUS_DATABASE_URL, name);
      console.log(`✓ snapshot "${name}" dropped`);
      return;
    }
    default:
      console.error("Usage: corpus:snapshot -- <save|restore|list|drop> [name]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
