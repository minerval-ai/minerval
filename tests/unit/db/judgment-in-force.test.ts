import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * "The judgment in force" is read through the four `*_in_force` views at
 * the end of src/db/schema.ts, so that what "in force" means is defined in
 * one place. A query that finds the current row by hand, with
 * `is_current = true`, is right today and wrong once a node can hold a
 * current judgment at more than one label (src/labels.ts): it would return
 * two rows where its caller expects one.
 *
 * So every file under src/ that mentions the flag is listed here with why
 * it may. A failure means a file started mentioning `is_current` or
 * `isCurrent` without that decision: read the judgment through its
 * `*_in_force` view instead, or, if the file has one of the reasons below
 * (it writes the flag, it finds the row it is about to supersede, it reads
 * history, it declares the schema or an API field), add it with its reason.
 *
 * The list is by file, so it does not see a hand-written read added to a
 * file already on it. Reviewing a change to one of these files includes
 * checking that.
 */
const MAY_MENTION_IS_CURRENT: Record<string, string> = {
  "src/db/schema.ts":
    "Declares the column, the one-current-row indexes, and the four *_in_force views themselves.",
  "src/llm/tools/steward-tools.ts":
    "Writes the flag: update_claim_assessment retires the claim's current verdict and inserts the new one.",
  "src/services/argument-service.ts":
    "Writes the flag: a new evaluation retires the current one, and a change of stance retires it too.",
  "src/services/quantity-service.ts":
    "Writes the flag: recordEstimate retires the current estimate before inserting the new one.",
  "src/services/question-service.ts":
    "Writes the flag: recordQuestionAssessment retires the current assessment before inserting the new one.",
  "src/services/reconciliation-service.ts":
    "Writes the flag: a change of kind or a split retires current judgments, and undoing it brings them back.",
  "src/services/assessment-service.ts":
    "Reads history: every assessment of a claim, each served with its flag.",
  "src/services/claim-events-service.ts":
    "Reads history: each assessment as an event in the claim's record, with its flag.",
  "src/services/argument-view-service.ts":
    "Reads history: an argument's evaluations, current and past together.",
  "src/services/finding-service.ts":
    "Reads history: whether a judgment a finding cites by id has since been superseded.",
  "src/services/mirror-manifest.ts":
    "Orders the mirror applier's writes: the judgment that stopped being current is written before the one that became it. Reads no judgment.",
  "src/schemas/claim.ts": "Declares is_current as a field of the history rows the API serves; no query.",
  "src/routes/claims.ts": "Response schemas and the formatter for history rows; its reads of the current verdict use the view.",
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles(join(repo, "src"));
const mentioning = files
  .filter((path) => /is_current|isCurrent/.test(readFileSync(path, "utf-8")))
  .map((path) => relative(repo, path).split("\\").join("/"))
  .sort();

describe("reads of the judgment in force", () => {
  it("sees the source tree", () => {
    // An empty scan would make the checks below pass vacuously.
    expect(files.length).toBeGreaterThan(300);
    expect(mentioning).toContain("src/db/schema.ts");
  });

  it("go through the *_in_force views: no file mentions is_current without a written reason", () => {
    const undecided = mentioning.filter((file) => !(file in MAY_MENTION_IS_CURRENT));
    expect(
      undecided,
      "These files mention is_current / isCurrent. Read the judgment in force through its *_in_force view " +
        "(src/db/schema.ts), or add the file to MAY_MENTION_IS_CURRENT in this test with its reason."
    ).toEqual([]);
  });

  it("keeps the list to files that still mention the flag, each with its reason", () => {
    const stale = Object.keys(MAY_MENTION_IS_CURRENT).filter((file) => !mentioning.includes(file));
    expect(stale, "These files no longer mention is_current; take them off the list.").toEqual([]);
    for (const [file, reason] of Object.entries(MAY_MENTION_IS_CURRENT)) {
      expect(reason.trim().length, file).toBeGreaterThan(20);
    }
  });
});
