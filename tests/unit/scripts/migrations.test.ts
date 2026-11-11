import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS_DIR,
  merge3,
  migrationFolderProblems,
  renumberMigrations,
  schemaDrift,
} from "../../../scripts/migrations-lib.js";

/**
 * The migrations folder as a CI property. Two PRs that each add a migration
 * take the same number, and a hand-resolved merge can leave a migration that
 * production silently skips (scripts/migrations-lib.ts says how). Applying
 * the chain from zero, as `npm run test:db` does, cannot see that, so the
 * folder's own bookkeeping is checked here. The fix for a failure is
 * `npm run db:renumber`.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("src/db/migrations", () => {
  it("has a journal that lists every migration once, in an order production will run", () => {
    expect(migrationFolderProblems(join(repo, MIGRATIONS_DIR))).toEqual([]);
  });

  it("ends in a snapshot that matches src/db/schema.ts", () => {
    expect(schemaDrift(repo), "run: npm run db:renumber, or npm run db:generate for an unmigrated change").toBeNull();
  }, 60_000);
});

const tmps: string[] = [];
afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch git repo holding a miniature migrations folder. */
function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "minerval-renumber-"));
  tmps.push(root);
  const dir = join(root, MIGRATIONS_DIR);
  mkdirSync(join(dir, "meta"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const journal = () => JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf-8"));
  const snapshot = (n: string) => JSON.parse(readFileSync(join(dir, "meta", `${n}_snapshot.json`), "utf-8"));
  /** What `drizzle-kit generate` does: the next number, a journal entry, a snapshot of the tables. */
  const generate = (name: string, when: number, tables: Record<string, unknown>) => {
    const entries = readdirSync(dir).includes("meta") && readdirSync(join(dir, "meta")).includes("_journal.json")
      ? journal().entries
      : [];
    const n = String(entries.length).padStart(4, "0");
    const prevId = entries.length === 0 ? "zero" : snapshot(String(entries.length - 1).padStart(4, "0")).id;
    writeFileSync(join(dir, `${n}_${name}.sql`), `-- ${name}\n`);
    writeFileSync(join(dir, "meta", `${n}_snapshot.json`), JSON.stringify({ id: `id-${name}`, prevId, tables }, null, 2));
    entries.push({ idx: entries.length, version: "7", when, tag: `${n}_${name}`, breakpoints: true });
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2));
    git("add", "-A");
    git("commit", "-q", "-m", name);
  };
  git("init", "-q", "-b", "main");
  return { root, dir, git, journal, snapshot, generate };
}

describe("migrationFolderProblems", () => {
  it("names a migration whose timestamp would make production skip it", () => {
    const { dir, generate } = scratchRepo();
    generate("first", 2000, {});
    generate("generated_earlier_merged_later", 1000, {});
    const problems = migrationFolderProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("would skip 0001_generated_earlier_merged_later");
  });

  it("names a migration the journal does not list", () => {
    const { dir, generate } = scratchRepo();
    generate("first", 1000, {});
    writeFileSync(join(dir, "0000_also_first.sql"), "-- stray\n");
    expect(migrationFolderProblems(dir).join("\n")).toContain("0000_also_first.sql has no journal entry");
  });
});

describe("merge3", () => {
  const run = (base: unknown, ours: unknown, theirs: unknown) => {
    const conflicts: string[] = [];
    return { merged: merge3(base, ours, theirs, conflicts), conflicts };
  };

  it("keeps both sides' additions and either side's removal", () => {
    const base = { tables: { a: { x: 1 }, gone: {} } };
    const ours = { tables: { a: { x: 1, fromMain: 1 } } };
    const theirs = { tables: { a: { x: 1, fromBranch: 1 }, gone: {}, added: {} } };
    expect(run(base, ours, theirs)).toEqual({
      merged: { tables: { a: { x: 1, fromMain: 1, fromBranch: 1 }, added: {} } },
      conflicts: [],
    });
  });

  it("reports the path where both sides changed the same thing differently", () => {
    const { conflicts } = run({ t: { col: { type: "text" } } }, { t: { col: { type: "int" } } }, { t: { col: { type: "uuid" } } });
    expect(conflicts).toEqual(["t.col.type"]);
  });

  it("reports one side changing what the other removed", () => {
    expect(run({ t: { a: 1 } }, {}, { t: { a: 2 } }).conflicts).toEqual(["t"]);
  });
});

describe("renumberMigrations", () => {
  /** main and a branch each add a migration numbered 0001; the branch then adds 0002. */
  function collided() {
    const s = scratchRepo();
    s.generate("start", 1000, { t: { id: {} } });
    s.git("checkout", "-q", "-b", "branch");
    s.generate("branch_one", 2000, { t: { id: {}, b1: {} } });
    s.generate("branch_two", 2001, { t: { id: {}, b1: {}, b2: {} } });
    s.git("checkout", "-q", "main");
    // main's lands later in wall-clock time than the branch's were generated.
    s.generate("main_one", 5000, { t: { id: {}, m: {} } });
    s.git("checkout", "-q", "branch");
    expect(() => s.git("merge", "main")).toThrow(); // the conflict this exists for
    return s;
  }

  it("moves the branch's migrations after main's, with later timestamps and both sides' schema", () => {
    const s = collided();
    const result = renumberMigrations(s.root, "main", 3000);

    expect(result.moved).toEqual([
      { from: "0001_branch_one", to: "0002_branch_one" },
      { from: "0002_branch_two", to: "0003_branch_two" },
    ]);
    expect(readdirSync(s.dir).filter((f) => f.endsWith(".sql"))).toEqual([
      "0000_start.sql",
      "0001_main_one.sql",
      "0002_branch_one.sql",
      "0003_branch_two.sql",
    ]);
    // 3000 is "now", but main's entry is at 5000: the branch's must still come after it.
    expect(s.journal().entries.map((e: { when: number }) => e.when)).toEqual([1000, 5000, 5001, 5002]);
    expect(s.snapshot("0001")).toMatchObject({ id: "id-main_one" });
    expect(s.snapshot("0002")).toEqual({ id: "id-branch_one", prevId: "id-main_one", tables: { t: { id: {}, m: {}, b1: {} } } });
    expect(s.snapshot("0003")).toEqual({ id: "id-branch_two", prevId: "id-branch_one", tables: { t: { id: {}, m: {}, b1: {}, b2: {} } } });
    expect(migrationFolderProblems(s.dir)).toEqual([]);
    // Staged, so the merge can be committed as it stands.
    expect(s.git("diff", "--name-only", "--diff-filter=U")).toBe("");
  });

  it("does nothing the second time", () => {
    const s = collided();
    renumberMigrations(s.root, "main", 3000);
    const before = readFileSync(join(s.dir, "meta", "_journal.json"), "utf-8");
    expect(renumberMigrations(s.root, "main", 9000).changed).toBe(false);
    expect(readFileSync(join(s.dir, "meta", "_journal.json"), "utf-8")).toBe(before);
  });

  it("lists files that still name a migration by its old number", () => {
    const s = scratchRepo();
    s.generate("start", 1000, {});
    s.git("checkout", "-q", "-b", "branch");
    writeFileSync(join(s.root, "notes.md"), "See migration 0001_branch_one.\n");
    s.generate("branch_one", 2000, { b: {} });
    s.git("checkout", "-q", "main");
    s.generate("main_one", 5000, { m: {} });
    s.git("checkout", "-q", "branch");
    expect(() => s.git("merge", "main")).toThrow();
    expect(renumberMigrations(s.root, "main").staleReferences).toEqual(["notes.md mentions 0001_branch_one"]);
  });

  it("refuses, writing nothing, when both sides changed the same column differently", () => {
    const s = scratchRepo();
    s.generate("start", 1000, { t: { col: { type: "text" } } });
    s.git("checkout", "-q", "-b", "branch");
    s.generate("branch_one", 2000, { t: { col: { type: "uuid" } } });
    s.git("checkout", "-q", "main");
    s.generate("main_one", 5000, { t: { col: { type: "int" } } });
    s.git("checkout", "-q", "branch");
    expect(() => s.git("merge", "main")).toThrow();
    expect(() => renumberMigrations(s.root, "main")).toThrow(/t\.col\.type/);
    expect(readdirSync(s.dir)).toContain("0001_branch_one.sql");
  });

  it("asks for the merge first when main's migrations are not in the working tree", () => {
    const s = scratchRepo();
    s.generate("start", 1000, {});
    s.git("checkout", "-q", "-b", "branch");
    s.generate("branch_one", 2000, {});
    s.git("checkout", "-q", "main");
    s.generate("main_one", 5000, {});
    s.git("checkout", "-q", "branch");
    expect(() => renumberMigrations(s.root, "main")).toThrow(/Merge it first/);
  });
});
