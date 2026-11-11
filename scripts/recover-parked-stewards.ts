/**
 * Recovery for claims parked as `steward_state = 'error'` (#97, #846).
 *
 * A park is never retried on its own. This resets chosen parks to `pending`
 * (clearing the error, its class and the attempt counter) so they can be run
 * again. Three ways to choose, combinable (a claim matching any is chosen):
 *
 *   (default)       parks whose stored error the pipeline now calls transient
 *                   (isTransientApiError: credit/billing, rejected
 *                   credentials, 429, 5xx, network). These would be requeued,
 *                   not parked, if they happened today.
 *   --match <text>  parks whose stored error contains <text>, case-insensitive.
 *                   Repeatable. With --match or --ids the default selection is
 *                   off; add --transient to include it.
 *   --ids <ids>     these claims, by id (comma or space separated, repeatable).
 *                   An id that is not an active parked claim is reported and
 *                   skipped, never reset.
 *
 * Safe by default: prints what it WOULD reset, by error class, and exits.
 * Pass `--confirm` to write.
 *
 * What a reset costs. Nothing by itself. With a General mandate in place the
 * Steward lane runs only what someone has commissioned
 * (steward-pipeline.ts, processNextStewardTask), so a reset claim waits as
 * `pending` like any other uncommissioned node until a mandate's allocator, a
 * plan item or a commission pays for its pass; that pass spends its payer's
 * budget as any pass does. Two cases run without a new decision: a claim whose
 * ledger group still holds an unspent allocation (the lanes keep it "to fund
 * this claim's next pass if it revives") runs on that money once reset, and a
 * deployment with no General mandate and BACKGROUND_FALLBACK_LANE_ENABLED set
 * drains pending claims against its daily background budget.
 *
 *   npx tsx scripts/recover-parked-stewards.ts                        # dry run, transient parks
 *   npx tsx scripts/recover-parked-stewards.ts --match authentication_error
 *   npx tsx scripts/recover-parked-stewards.ts --ids <uuid>,<uuid>
 *   npx tsx scripts/recover-parked-stewards.ts --match authentication_error --confirm
 */
import "../src/load-env.js";
import { pathToFileURL } from "url";
import { rawQuery, closeDb } from "../src/db/client.js";
import { isTransientApiError } from "../src/llm/errors.js";

export interface RecoverOptions {
  confirm: boolean;
  /** Include parks the pipeline's classifier calls transient. */
  transient: boolean;
  /** Case-insensitive substrings of the stored error. */
  match: string[];
  ids: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse argv (without node and the script path). Throws on a malformed call. */
export function parseRecoverArgs(argv: string[]): RecoverOptions {
  const opts: RecoverOptions = { confirm: false, transient: false, match: [], ids: [] };
  let explicitTransient = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--confirm") opts.confirm = true;
    else if (arg === "--transient") explicitTransient = true;
    else if (arg === "--match") {
      const text = argv[++i];
      if (!text || text.startsWith("--") || !text.trim()) throw new Error("--match needs the text to look for");
      opts.match.push(text);
    } else if (arg === "--ids") {
      const list = argv[++i];
      if (!list || list.startsWith("--")) throw new Error("--ids needs one or more claim ids");
      for (const id of list.split(/[\s,]+/).filter(Boolean)) {
        if (!UUID.test(id)) throw new Error(`--ids: not a claim id: ${id}`);
        opts.ids.push(id.toLowerCase());
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // With no selector the script does what it always did: the transient parks.
  opts.transient = explicitTransient || (opts.match.length === 0 && opts.ids.length === 0);
  return opts;
}

interface ParkedRow {
  id: string;
  steward_error: string | null;
  steward_error_reason: string | null;
  steward_attempts: number;
}

export interface RecoverResult {
  parked: number;
  selected: ParkedRow[];
  /** Ids given with --ids that are not active parked claims. */
  notParked: string[];
  reset: number;
}

/** Which parked rows the options choose. Pure, for the tests. */
export function selectParks(parked: ParkedRow[], opts: RecoverOptions): ParkedRow[] {
  const needles = opts.match.map((m) => m.toLowerCase());
  const ids = new Set(opts.ids);
  return parked.filter((c) => {
    const text = c.steward_error ?? "";
    if (ids.has(c.id)) return true;
    if (needles.some((n) => text.toLowerCase().includes(n))) return true;
    // The pipeline's own classifier, so "what is recovered" and "what would
    // be requeued today" cannot drift apart.
    return opts.transient && isTransientApiError(new Error(text));
  });
}

export async function recoverParkedStewards(opts: RecoverOptions): Promise<RecoverResult> {
  const parked = await rawQuery<ParkedRow>(
    `SELECT id, steward_error, steward_error_reason, steward_attempts FROM claims
      WHERE state = 'active' AND steward_state = 'error'`
  );
  const selected = selectParks(parked, opts);
  const parkedIds = new Set(parked.map((c) => c.id));
  const notParked = opts.ids.filter((id) => !parkedIds.has(id));
  if (!opts.confirm || selected.length === 0) return { parked: parked.length, selected, notParked, reset: 0 };
  // Guarded on the state again: a claim commissioned (and so un-parked or
  // running) since the read is left alone.
  const rows = await rawQuery<{ id: string }>(
    `UPDATE claims
        SET steward_state = 'pending', steward_error = NULL, steward_error_reason = NULL,
            steward_attempts = 0, updated_at = now()
      WHERE id = ANY($1::uuid[]) AND state = 'active' AND steward_state = 'error'
      RETURNING id`,
    [selected.map((c) => c.id)]
  );
  return { parked: parked.length, selected, notParked, reset: rows.length };
}

async function main(): Promise<void> {
  const opts = parseRecoverArgs(process.argv.slice(2));
  const res = await recoverParkedStewards(opts);

  const chosenBy = [
    opts.transient ? "transient by the pipeline's classifier" : null,
    ...opts.match.map((m) => `error contains "${m}"`),
    opts.ids.length > 0 ? `${opts.ids.length} id(s) given` : null,
  ].filter(Boolean);
  console.log(`Parked 'error' claims: ${res.parked}`);
  console.log(`  selected (${chosenBy.join("; ")}): ${res.selected.length}`);
  console.log(`  left as they are: ${res.parked - res.selected.length}`);
  const byReason = new Map<string, number>();
  for (const c of res.selected) {
    const k = c.steward_error_reason ?? "other";
    byReason.set(k, (byReason.get(k) ?? 0) + 1);
  }
  for (const [reason, n] of byReason) console.log(`    ${reason}: ${n}`);
  for (const id of res.notParked) console.log(`  not an active parked claim, skipped: ${id}`);

  if (res.selected.length === 0) {
    console.log("Nothing to recover.");
  } else if (!opts.confirm) {
    console.log("\nDry run. Re-run with --confirm to reset these to 'pending'.");
    for (const c of res.selected.slice(0, 10)) {
      console.log(`  ${c.id}  attempts=${c.steward_attempts}  ${(c.steward_error ?? "").slice(0, 80)}`);
    }
    if (res.selected.length > 10) console.log(`  … and ${res.selected.length - 10} more`);
  } else {
    console.log(
      `\nReset ${res.reset} claim(s) to 'pending' with a clean attempt count. Each runs when its pass ` +
        `is paid for (a mandate's allocation, a plan item or a commission), not before.`
    );
  }
  await closeDb();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
