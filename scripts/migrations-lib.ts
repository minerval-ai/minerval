/**
 * Shared by `npm run db:renumber` (scripts/renumber-migrations.ts) and the
 * migration-folder test (tests/unit/scripts/migrations.test.ts).
 *
 * Why any of this exists. Every migration a PR adds touches three things every
 * other migration PR also touches: the next free number in the filename, the
 * tail of meta/_journal.json, and a meta/NNNN_snapshot.json of the whole
 * schema. Two open PRs therefore always collide, and resolving it by hand has
 * a trap beyond the tedium: drizzle's migrator does not record which
 * migrations ran. It reads the newest applied `created_at` and runs only the
 * journal entries whose `when` is later (drizzle-orm/pg-core/dialect.js,
 * `migrate`). A migration generated early and merged late carries an old
 * `when`, and a database that already ran a newer one skips it without an
 * error. CI cannot see that by applying the chain, because from zero every
 * migration runs. So the journal's order is checked directly, here.
 */
import { execFileSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";

export const MIGRATIONS_DIR = "src/db/migrations";

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface Snapshot {
  id: string;
  prevId: string;
  [key: string]: unknown;
}

/**
 * Entries whose `when` is earlier than a migration before them, from before
 * this was checked: 0089 merged with a later timestamp than 0090-0094, which
 * were generated first and merged after. Every database that exists has
 * applied them, so they stay as they are (rewriting an applied entry's `when`
 * would not rerun it, and would misdescribe what ran). Nothing is added here:
 * a new migration that fails the order check is renumbered, not excused.
 */
export const HISTORICAL_OUT_OF_ORDER: ReadonlySet<string> = new Set([
  "0090_node_messages",
  "0091_commissions",
  "0092_mandate_operations",
  "0093_public_read_views",
  "0094_lookout_graph_feed",
]);

const pad = (n: number) => String(n).padStart(4, "0");
const numberOf = (tag: string) => Number(tag.slice(0, 4));
const stringify = (value: unknown) => JSON.stringify(value, null, 2);

function tryParse<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null; // conflict markers, usually
  }
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** Tags of the .sql files in a migrations folder, in filename order. */
function sqlTags(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .map((f) => f.slice(0, -".sql".length))
    .sort();
}

/**
 * Everything wrong with a migrations folder, as sentences; empty when it is
 * sound. Checked: the journal lists exactly the .sql files, numbered 0000
 * upward with no gap or repeat; each `when` is later than every one before it
 * (the property the migrator's skip rule depends on); and each migration has
 * a snapshot whose `prevId` is the snapshot before it.
 */
export function migrationFolderProblems(dir: string): string[] {
  const problems: string[] = [];
  const journal = tryParse<Journal>(readIfExists(join(dir, "meta", "_journal.json")));
  if (!journal) return ["meta/_journal.json is missing or is not valid JSON."];

  const files = sqlTags(dir);
  const journalTags = journal.entries.map((e) => e.tag);
  for (const tag of files) {
    if (!journalTags.includes(tag)) problems.push(`${tag}.sql has no journal entry, so it never runs.`);
  }
  for (const tag of journalTags) {
    if (!files.includes(tag)) problems.push(`The journal lists ${tag}, but there is no ${tag}.sql.`);
  }

  let newest = -Infinity;
  let newestTag = "";
  let previousId: string | null = null;
  journal.entries.forEach((entry, i) => {
    if (entry.idx !== i || numberOf(entry.tag) !== i) {
      problems.push(
        `Journal entry ${i} is ${entry.tag} with idx ${entry.idx}; both should be ${pad(i)}. ` +
          `Two migrations sharing a number, or a gap, looks like this.`,
      );
    }
    if (entry.when <= newest && !HISTORICAL_OUT_OF_ORDER.has(entry.tag)) {
      problems.push(
        `${entry.tag} has a "when" no later than ${newestTag}'s. A database that has already ` +
          `applied ${newestTag} would skip ${entry.tag} without an error.`,
      );
    }
    if (entry.when > newest) {
      newest = entry.when;
      newestTag = entry.tag;
    }

    const name = `${pad(i)}_snapshot.json`;
    const snapshot = tryParse<Snapshot>(readIfExists(join(dir, "meta", name)));
    if (!snapshot) {
      problems.push(`meta/${name} is missing or is not valid JSON.`);
      previousId = null;
    } else {
      if (previousId !== null && snapshot.prevId !== previousId) {
        problems.push(`meta/${name} does not follow the snapshot before it (its prevId is another snapshot's).`);
      }
      previousId = snapshot.id;
    }
  });

  return problems.map((p) => `${p} Run: npm run db:renumber`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of two edits of the same JSON value. A side that left the
 * value alone yields to the side that changed it; objects merge key by key;
 * anything else both sides changed differently (arrays included: an enum's
 * values, an index's columns) is a conflict, recorded by path and left as
 * `ours`. A key absent on a side is `undefined` there.
 */
export function merge3(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  conflicts: string[],
  path = "",
): unknown {
  if (same(ours, theirs)) return ours;
  if (same(base, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (isObject(ours) && isObject(theirs) && (base === undefined || isObject(base))) {
    const from = (base ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const value = merge3(from[key], ours[key], theirs[key], conflicts, path ? `${path}.${key}` : key);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  conflicts.push(path || "(the whole snapshot)");
  return ours;
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export interface RenumberResult {
  /** Old tag to new tag, for each of the branch's migrations, in order. */
  moved: Array<{ from: string; to: string }>;
  /** False when the folder was already in order and nothing was written. */
  changed: boolean;
  /** Files outside the migrations folder that name a migration by its old tag. */
  staleReferences: string[];
}

/**
 * Put this branch's migrations after the ones on `base`, in a working tree
 * that already has `base` merged in (conflicts in meta/ and all). The branch's
 * migrations are the .sql files `base`'s journal does not list. They take the
 * next free numbers and a fresh `when`; their snapshots are renumbered,
 * re-chained, and merged with `base`'s latest schema so the next
 * `db:generate` diffs against both sides' changes. The result is staged.
 *
 * Throws, having written nothing, when it cannot do this soundly.
 */
export function renumberMigrations(repo: string, base: string, now = Date.now()): RenumberResult {
  const dir = join(repo, MIGRATIONS_DIR);
  const meta = join(dir, "meta");
  const journalPath = `${MIGRATIONS_DIR}/meta/_journal.json`;

  const baseJournal = tryParse<Journal>(git(repo, ["show", `${base}:${journalPath}`]));
  if (!baseJournal) {
    throw new Error(`Could not read the journal at ${base}. Fetch it first: git fetch origin main`);
  }
  const baseTags = new Set(baseJournal.entries.map((e) => e.tag));
  const present = sqlTags(dir);
  const missing = [...baseTags].filter((tag) => !present.includes(tag));
  if (missing.length > 0) {
    throw new Error(
      `${base} has migrations this working tree lacks (${missing.join(", ")}). ` +
        `Merge it first (git merge ${base}), leave the conflicts in ${MIGRATIONS_DIR}, and run this again.`,
    );
  }
  const mine = present.filter((tag) => !baseTags.has(tag));
  if (mine.length === 0) return { moved: [], changed: false, staleReferences: [] };

  // A rebase replays the branch one commit at a time. Once an earlier commit's
  // migration has been renumbered into HEAD, a later commit's snapshot is
  // still written against the branch's original starting point, and nothing
  // left in the tree says which starting point each one had.
  const rebasing = ["rebase-merge", "rebase-apply"].some((d) => {
    const p = git(repo, ["rev-parse", "--git-path", d])?.trim();
    return p !== undefined && existsSync(resolve(repo, p));
  });
  const headJournal = tryParse<Journal>(git(repo, ["show", `HEAD:${journalPath}`]));
  if (rebasing && headJournal?.entries.some((e) => !baseTags.has(e.tag))) {
    throw new Error(
      "This branch adds migrations in more than one commit, and a rebase replays them one at a time, " +
        `which this cannot follow. Abort the rebase (git rebase --abort), merge instead (git merge ${base}), ` +
        "and run this again.",
    );
  }

  // base's snapshots, read from base itself: in the working tree, a number
  // both sides used is a conflicted file, or the branch's copy.
  const baseSnapshots = new Map<string, Snapshot>();
  for (const entry of baseJournal.entries) {
    const name = `${pad(entry.idx)}_snapshot.json`;
    const snapshot = tryParse<Snapshot>(git(repo, ["show", `${base}:${MIGRATIONS_DIR}/meta/${name}`]));
    if (snapshot) baseSnapshots.set(name, snapshot);
  }
  const lastBase = baseJournal.entries[baseJournal.entries.length - 1];
  const latest = lastBase && baseSnapshots.get(`${pad(lastBase.idx)}_snapshot.json`);
  if (!lastBase || !latest) throw new Error(`${base} has no snapshot for its last migration.`);
  const baseById = new Map([...baseSnapshots.values()].map((s) => [s.id, s]));

  // The branch's snapshots: whatever is in the tree or on either side of a
  // conflict that is not one of base's.
  const branchById = new Map<string, Snapshot>();
  const unmerged = (git(repo, ["diff", "--name-only", "--diff-filter=U", "--", `${MIGRATIONS_DIR}/meta`]) ?? "")
    .split("\n")
    .filter((f) => f.endsWith("_snapshot.json"));
  const candidates = [
    ...readdirSync(meta)
      .filter((f) => f.endsWith("_snapshot.json"))
      .map((f) => readIfExists(join(meta, f))),
    ...unmerged.flatMap((f) => [git(repo, ["show", `:2:${f}`]), git(repo, ["show", `:3:${f}`])]),
  ];
  for (const text of candidates) {
    const snapshot = tryParse<Snapshot>(text);
    if (snapshot?.id && !baseById.has(snapshot.id)) branchById.set(snapshot.id, snapshot);
  }

  // Order them by their own chain, starting from the base snapshot the branch
  // was generated against.
  const starts = [...branchById.values()].filter((s) => baseById.has(s.prevId));
  const chain: Snapshot[] = [];
  for (let next: Snapshot | undefined = starts[0]; next; ) {
    chain.push(next);
    const id: string = next.id;
    next = [...branchById.values()].find((s) => s.prevId === id);
  }
  if (starts.length !== 1 || chain.length !== branchById.size || chain.length !== mine.length) {
    throw new Error(
      `Found ${mine.length} migration(s) of this branch's (${mine.join(", ")}) but could not line up ` +
        `${branchById.size} snapshot(s) behind them. Each migration needs the meta/NNNN_snapshot.json ` +
        "drizzle-kit wrote with it (npm run db:generate, or drizzle-kit generate --custom for hand-written SQL).",
    );
  }
  const fork = baseById.get(chain[0]!.prevId)!;

  const conflicts: string[] = [];
  let previousId = latest.id;
  const snapshots = chain.map((snapshot) => {
    // The ids are the chain, not the schema: they differ on all three by design.
    const body = ({ id: _id, prevId: _prevId, ...rest }: Snapshot) => rest;
    const merged = merge3(body(fork), body(latest), body(snapshot), conflicts) as Record<string, unknown>;
    const out: Snapshot = { id: snapshot.id, prevId: previousId, ...merged };
    previousId = snapshot.id;
    return out;
  });
  if (conflicts.length > 0) {
    throw new Error(
      `This branch and ${base} changed the same part of the schema differently, at: ` +
        `${[...new Set(conflicts)].join("; ")}. That is a real conflict between the two migrations, not a ` +
        "numbering one: settle it in src/db/schema.ts and regenerate this branch's migration.",
    );
  }

  const firstFree = lastBase.idx + 1;
  const firstWhen = Math.max(now, ...baseJournal.entries.map((e) => e.when + 1));
  const moved = mine.map((from, i) => ({ from, to: `${pad(firstFree + i)}${from.slice(4)}` }));
  const journal: Journal = {
    ...baseJournal,
    entries: [
      ...baseJournal.entries,
      ...moved.map(({ to }, i) => ({ ...lastBase, idx: firstFree + i, when: firstWhen + i, tag: to })),
    ],
  };

  // Already in order (a second run, or a branch that was renumbered and has
  // had nothing merged under it since): keep the timestamps it has.
  const current = tryParse<Journal>(readIfExists(join(meta, "_journal.json")));
  const settled =
    current !== null &&
    moved.every(({ from, to }) => from === to) &&
    same(current.entries.map((e) => [e.idx, e.tag]), journal.entries.map((e) => [e.idx, e.tag])) &&
    migrationFolderProblems(dir).length === 0 &&
    snapshots.every((s, i) =>
      same(s, tryParse<Snapshot>(readIfExists(join(meta, `${pad(firstFree + i)}_snapshot.json`)))),
    );
  if (settled) return { moved, changed: false, staleReferences: [] };

  // Write. Highest number first, so a rename never lands on a file still to move.
  for (const { from, to } of [...moved].reverse()) {
    if (from !== to) renameSync(join(dir, `${from}.sql`), join(dir, `${to}.sql`));
  }
  for (const f of readdirSync(meta)) {
    if (f.endsWith("_snapshot.json")) {
      const kept = baseSnapshots.get(f);
      if (!kept) rmSync(join(meta, f));
      else if (tryParse<Snapshot>(readIfExists(join(meta, f)))?.id !== kept.id) {
        writeFileSync(join(meta, f), git(repo, ["show", `${base}:${MIGRATIONS_DIR}/meta/${f}`])!);
      }
    }
  }
  snapshots.forEach((s, i) => writeFileSync(join(meta, `${pad(firstFree + i)}_snapshot.json`), stringify(s)));
  writeFileSync(join(meta, "_journal.json"), stringify(journal));
  git(repo, ["add", "-A", "--", MIGRATIONS_DIR]);

  const staleReferences = moved
    .filter(({ from, to }) => from !== to)
    .flatMap(({ from }) =>
      (git(repo, ["grep", "-l", "--fixed-strings", from, "--", ".", `:!${MIGRATIONS_DIR}`]) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((file) => `${file} mentions ${from}`),
    );
  return { moved, changed: true, staleReferences };
}

/**
 * Whether src/db/schema.ts and the latest snapshot describe the same schema:
 * null when they do, otherwise what drizzle-kit said. It is asked to generate
 * into a throwaway copy of the folder, so nothing in the repo is written.
 * A stale last snapshot matters because the next `db:generate` diffs against
 * it, and would emit SQL undoing whatever the snapshot is missing.
 */
export function schemaDrift(repo: string): string | null {
  const tmp = mkdtempSync(join(tmpdir(), "minerval-migrations-"));
  try {
    cpSync(join(repo, MIGRATIONS_DIR), join(tmp, "out"), { recursive: true });
    // drizzle-kit resolves `out` against the working directory and rejects an absolute path.
    const config = { schema: "./src/db/schema.ts", out: relative(repo, join(tmp, "out")), dialect: "postgresql" };
    writeFileSync(join(tmp, "drizzle.config.json"), JSON.stringify(config));
    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        [join(repo, "node_modules/drizzle-kit/bin.cjs"), "generate", "--config", join(tmp, "drizzle.config.json")],
        { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
    }
    return output.includes("No schema changes") ? null : output.trim().split("\n").slice(-12).join("\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
