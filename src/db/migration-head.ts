/**
 * The newest schema migration this deployment's code carries: its number
 * and tag, read from the migrations journal.
 *
 * A mirror batch is stamped with the migration its publisher was at, and an
 * applier compares that with its own (services/mirror-apply-service.ts). The
 * journal is the code's statement of its schema: production applies it at
 * start (src/index.ts), so the database is at the journal's head whenever
 * the process is serving.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationHead {
  /** The migration's number: 126 for 0126_mirror. */
  number: number;
  tag: string;
}

/** Where the journal is: beside the source in development, copied to the image in production. */
const JOURNAL_PATHS = [
  ["drizzle-migrations", "meta", "_journal.json"],
  ["src", "db", "migrations", "meta", "_journal.json"],
];

let _head: MigrationHead | null = null;

export function migrationHead(root: string = process.cwd()): MigrationHead {
  if (_head && root === process.cwd()) return _head;
  for (const parts of JOURNAL_PATHS) {
    const path = join(root, ...parts);
    if (!existsSync(path)) continue;
    const journal = JSON.parse(readFileSync(path, "utf8")) as { entries?: Array<{ idx: number; tag: string }> };
    const last = journal.entries?.at(-1);
    if (!last) break;
    const head = { number: last.idx, tag: last.tag };
    if (root === process.cwd()) _head = head;
    return head;
  }
  throw new Error(
    "The migrations journal was not found (drizzle-migrations/meta/_journal.json or " +
      "src/db/migrations/meta/_journal.json), so this deployment cannot say which schema it is at."
  );
}
