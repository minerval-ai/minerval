import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * No ledger row is closed without its money settled (#1045).
 *
 * A commission pays for one run, and when the row closes, however it
 * closes, what the run did not spend goes back to whoever paid. That is
 * done in one place: completeAction (a run that finished) and cancelActions
 * and its siblings in src/services/action-settlement.ts (one that did not).
 * Three places that wrote their own `UPDATE actions SET status =
 * 'cancelled'` without settling held 4.37 owls of a mandate's escrow on
 * four dead ingests, money nothing could ever spend.
 *
 * A failure here means a file started closing rows by its own statement.
 * Close them through cancelActions, cancelAction or cancelActionsWhere,
 * which settle, or add the file below with the reason its own statement
 * settles the money. settleDeadGroups returns whatever a path leaves behind
 * all the same, and reports it, but that is a backstop, not a way to close.
 */
const MAY_CLOSE_ROWS_ITSELF: Record<string, string> = {
  "src/services/action-settlement.ts": "The settlement itself.",
  "src/services/action-service.ts":
    "completeAction marks the run done and its siblings superseded, then settles the group's money with settleGroupMoney in the same transaction.",
  "src/services/bounty-service.ts":
    "Closing a bounty's prize-review reserve releases every allocation the reserve placed, refunding its funder, before it closes the audit rows in the same transaction, and returns the unplaced remainder of the reserve too.",
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rel = (path: string) => relative(repo, path).split("\\").join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** A statement that sets a ledger row to a closed status. */
const CLOSES_A_ROW = /UPDATE\s+actions\b(?:(?!\bWHERE\b)[^`;])*?\bSET\b(?:(?!\bWHERE\b)[^`;])*?\bstatus\s*=\s*'(cancelled|done|superseded)'/s;

describe("closing a ledger row settles its money", () => {
  const files = sourceFiles(join(repo, "src")).map((path) => ({
    file: rel(path),
    code: readFileSync(path, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
  }));

  it("closes rows only through the settlement, or with a written reason", () => {
    const offenders = files
      .filter((f) => CLOSES_A_ROW.test(f.code) && !(f.file in MAY_CLOSE_ROWS_ITSELF))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("lists no file that no longer closes rows itself", () => {
    const stale = Object.keys(MAY_CLOSE_ROWS_ITSELF).filter(
      (file) => file !== "src/services/action-settlement.ts" && !files.some((f) => f.file === file && CLOSES_A_ROW.test(f.code))
    );
    expect(stale).toEqual([]);
  });

  it("recognises the statement it looks for", () => {
    expect(CLOSES_A_ROW.test("UPDATE actions SET status = 'cancelled', updated_at = now()")).toBe(true);
    expect(CLOSES_A_ROW.test("UPDATE actions a\n   SET status = 'done', metered_cost_micro_usd = $2")).toBe(true);
    expect(CLOSES_A_ROW.test("UPDATE actions SET status = 'open' WHERE status = 'cancelled'")).toBe(false);
    expect(CLOSES_A_ROW.test("UPDATE jobs SET status = 'done'")).toBe(false);
  });
});
