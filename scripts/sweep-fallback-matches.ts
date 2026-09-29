/**
 * One-shot sweep for claims minted on the Matcher's old timeout fallback
 * (#419, #438). Before #442, a Matcher run that exhausted its search budget
 * returned `is_match: false` at confidence 0.3 with the reasoning "Matcher did
 * not submit a decision within the search budget; defaulting to a new claim."
 * Callers read that as "novel" and created a claim without any identity
 * verdict, so each such site may hold a duplicate the Curator has to find.
 *
 * The fallback reasoning was never stored on the claim, but it is in the agent
 * traces (#334): the Steward's or Curator's `match_claim` tool result carries
 * it verbatim. This finds those runs within the trace retention window (30
 * days by default) and opens one `operator` curation request per anchor
 * claim (the run's claim, under which the fallback-minted subclaim sits).
 * Extra anchors known from reports can be passed with `--claim <id>`; the
 * child from #438 sits under c31c7ae2, for example.
 *
 * Not covered: claims minted by URL extraction on the same fallback. Those
 * runs carry no claim id, and the reasoning was discarded, so there is no
 * trace to follow. Intake proposals materialize through the reviewer, whose
 * tool result records only the outcome, so they are likewise invisible here.
 *
 * Safe by default: prints what it WOULD request and exits. Pass `--confirm`
 * to open the requests. Curation is funded ledger work (#363): each request
 * opens (or joins) its anchor's `curate` row, which runs once a mandate
 * values and funds it (the General formula weighs an operator's request like
 * a Steward's escalation). This script spends nothing itself and returns at
 * once; the server's engine executor does the runs, each metered to the
 * mandate that funded it.
 *
 *   npx tsx scripts/sweep-fallback-matches.ts                       # dry run
 *   npx tsx scripts/sweep-fallback-matches.ts --claim <uuid> --confirm
 */
import "dotenv/config";
import { rawQuery, closeDb } from "../src/db/client.js";
import { requestCuration } from "../src/services/curation-service.js";

/** The exact reasoning the pre-#442 fallback emitted. */
const FALLBACK_PHRASE = "defaulting to a new claim";

interface Hit {
  claim_id: string;
  claim_text: string | null;
  claim_state: string | null;
  runs: number;
  last_seen: string;
}

function parseArgs(argv: string[]): { confirm: boolean; extraClaims: string[] } {
  const extraClaims: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--claim" && argv[i + 1]) extraClaims.push(argv[++i]!);
  }
  return { confirm: argv.includes("--confirm"), extraClaims };
}

async function main(): Promise<void> {
  const { confirm, extraClaims } = parseArgs(process.argv.slice(2));

  // A tool_results step is the executed tools of one model turn: an array of
  // {name, input, output}. The match_claim output is the wrapper's JSON,
  // reasoning included, so a substring match on the step's text is exact
  // enough; the run's claim_id is the anchor the Curator should sweep around.
  const traced = await rawQuery<Hit>(
    `SELECT r.claim_id,
            c.text            AS claim_text,
            c.state           AS claim_state,
            COUNT(DISTINCT r.id)::int AS runs,
            MAX(s.created_at)::text   AS last_seen
       FROM agent_steps s
       JOIN agent_runs r ON r.id = s.run_id
       LEFT JOIN claims c ON c.id = r.claim_id
      WHERE s.kind = 'tool_results'
        AND r.claim_id IS NOT NULL
        AND r.agent IN ('steward', 'curator')
        AND s.content::text LIKE $1
      GROUP BY r.claim_id, c.text, c.state
      ORDER BY MAX(s.created_at) DESC`,
    [`%${FALLBACK_PHRASE}%`]
  );

  const byClaim = new Map<string, Hit>(traced.map((h) => [h.claim_id, h]));
  if (extraClaims.length > 0) {
    const known = await rawQuery<{ id: string; text: string; state: string }>(
      `SELECT id, text, state FROM claims WHERE id = ANY($1::uuid[])`,
      [extraClaims]
    );
    for (const id of extraClaims) {
      if (byClaim.has(id)) continue;
      const row = known.find((k) => k.id === id);
      if (!row) {
        console.warn(`--claim ${id}: no such claim, skipped`);
        continue;
      }
      byClaim.set(id, {
        claim_id: id,
        claim_text: row.text,
        claim_state: row.state,
        runs: 0,
        last_seen: "(passed on the command line)",
      });
    }
  }

  // An archived or merged anchor has nothing left to reconcile around.
  const hits = [...byClaim.values()].filter(
    (h) => h.claim_state === null || h.claim_state === "active"
  );

  console.log(`Anchor claims with a fallback-minted match in their traces: ${traced.length}`);
  console.log(`  plus command-line anchors: ${byClaim.size - traced.length}`);
  console.log(`  active (to sweep): ${hits.length}`);

  if (hits.length === 0) {
    console.log("Nothing to sweep.");
    await closeDb();
    return;
  }

  for (const h of hits) {
    console.log(
      `  ${h.claim_id}  runs=${h.runs}  last=${h.last_seen}  ` +
        `${(h.claim_text ?? "").slice(0, 70)}`
    );
  }

  if (!confirm) {
    console.log("\nDry run — re-run with --confirm to open a curation request per anchor.");
    await closeDb();
    return;
  }

  const concern =
    `Sweep for duplicates minted on the Matcher's old timeout fallback ` +
    `(#419, #438). A Steward or Curator working on this claim called ` +
    `match_claim, the Matcher ran out of search budget, and the result ` +
    `was read as "novel" without an identity verdict, so a subclaim ` +
    `created under this claim at that time may duplicate an existing ` +
    `claim (as itself, a rewording, or its negation). Examine the ` +
    `subclaims created here and merge any that duplicate an existing ` +
    `node. Doing nothing is fine if none do.`;
  let opened = 0;
  let repeats = 0;
  const failed: string[] = [];
  for (const h of hits) {
    const r = await requestCuration({
      anchorClaimId: h.claim_id,
      source: "operator",
      concern,
    });
    if (!r.ok) {
      failed.push(h.claim_id);
      console.error(`  ${h.claim_id}: ${r.problem}`);
    } else if (r.repeat) {
      repeats++;
    } else {
      opened++;
    }
  }
  console.log(
    `\nOpened ${opened} curation request(s); ${repeats} already waiting; ${failed.length} refused. ` +
      `They run as their curate rows are funded.`
  );
  await closeDb();
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
