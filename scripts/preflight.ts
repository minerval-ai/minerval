/**
 * `npm run preflight`: whether this deployment is ready to run
 * (src/preflight.ts; docs/deployment.md, "Preflight").
 *
 * Reads the same settings the server does (the environment, `.env`, and the
 * config file when one is named), runs every check, and prints each with
 * its sentence. Exits 0 when no check failed and 1 when any did, so it can
 * stand in front of a start command. `--json` prints the report as the
 * route GET /setup/preflight serves it.
 *
 * A config file that cannot be used is reported as the file's own errors
 * and nothing else, since no check can run on settings that did not load.
 */
import "../src/load-env.js";
import { ConfigFileError } from "../src/config-file.js";
import { closeDb } from "../src/db/client.js";
import { runPreflight, type PreflightReport } from "../src/preflight.js";

const LABEL = { pass: "pass", fail: "FAIL", not_applicable: "n/a " } as const;

function formatPreflight(report: PreflightReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const holds =
    report.holds_private_material === null
      ? "could not be told"
      : report.holds_private_material
        ? "yes (a label other than public is defined)"
        : "no (public is the only label)";
  const lines = [`Holds private material: ${holds}`, ""];
  for (const check of report.checks) {
    const mark = check.blocking && check.status === "fail" ? " (blocks agent work)" : "";
    lines.push(`${LABEL[check.status]}  ${check.name.padEnd(width)}  ${check.message}${mark}`);
  }
  const failed = report.checks.filter((c) => c.status === "fail").length;
  lines.push("");
  lines.push(
    failed === 0
      ? `All ${report.checks.length} checks pass or do not apply. Agent work may start.`
      : `${failed} of ${report.checks.length} checks failed. ` +
          (report.agent_work === "refused"
            ? "Agent work is refused until the ones that block it pass."
            : "None of them blocks agent work on this deployment.")
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const report = await runPreflight();
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatPreflight(report));
  return report.ready ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeDb().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err instanceof ConfigFileError ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
