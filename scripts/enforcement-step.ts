/**
 * Run the label enforcement step now (docs/architecture.md, "Labels and
 * clearance"): cover every labelled table, hold every view, and report what
 * was changed. `npm run db:migrate` runs this when the migrations have
 * finished, so a migration run by hand leaves nothing uncovered until the
 * next start of the API, which runs the step too.
 *
 * It changes nothing on a deployment whose only label is `public`, and
 * nothing that is already right anywhere else.
 *
 *   npx tsx scripts/enforcement-step.ts
 */
import "../src/load-env.js";
import { closeDb } from "../src/db/client.js";
import { ensureEnforcement } from "../src/db/enforcement.js";

async function main(): Promise<void> {
  const { on, changes } = await ensureEnforcement();
  for (const line of changes) console.log(`[labels] ${line}`);
  console.log(
    on
      ? `[labels] reads and writes are held to a clearance; the step made ${changes.length} change(s)`
      : "[labels] public is the only label; nothing is held and nothing was changed"
  );
}

main()
  .catch((err) => {
    console.error("[labels] the enforcement step failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
