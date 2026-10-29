import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * The platform-mandates `fund` job checks out the triggering Deploy run's
 * head_sha and runs it with MINERVAL_OPERATOR_KEY. The workflow_run filters
 * (workflow name, head branch) are controlled by a pull request from a fork,
 * so the job itself must require a push to main of this repository.
 */

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = readFileSync(join(here, "../../../.github/workflows/platform-mandates.yml"), "utf8");

/** The lines of one job under `jobs:`, by its two-space-indented key. */
function job(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`no job ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}

/** A job's `if:` condition, folded onto one line. */
function condition(jobSource: string): string {
  const lines = jobSource.split("\n");
  const start = lines.findIndex((l) => /^ {4}if:/.test(l));
  if (start === -1) return "";
  const parts = [lines[start]!.replace(/^ {4}if:\s*(>-?)?/, "")];
  for (let i = start + 1; i < lines.length && /^ {6}\S/.test(lines[i]!); i++) parts.push(lines[i]!);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

describe("platform-mandates workflow: fund", () => {
  const fund = job(WORKFLOW, "fund");
  const gate = condition(fund);

  it("runs only after a successful Deploy pushed to main of this repository", () => {
    expect(gate).not.toContain("||");
    const terms = gate.split("&&").map((t) => t.trim());
    expect(terms).toEqual(
      expect.arrayContaining([
        "github.event_name == 'workflow_run'",
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_repository.full_name == github.repository",
      ])
    );
  });

  it("is the only job holding the operator key", () => {
    expect(fund).toContain("secrets.MINERVAL_OPERATOR_KEY");
    expect(WORKFLOW.split("secrets.MINERVAL_OPERATOR_KEY").length - 1).toBe(1);
  });
});
