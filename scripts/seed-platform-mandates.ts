/**
 * Seed the platform's own mandates, the ones Minerval sets up and runs,
 * which take pride of place on the public /mandates page.
 *
 * The load-bearing one is GENERAL MAINTENANCE (policy 'general'; titled
 * "General assessment" until the upkeep rewrite): the mandate whose escrow
 * is however many dollars Minerval allocates to keeping the graph sound
 * (Minerval buys owls at $1 per owl, at cost; the $4 price is what users
 * pay, and the margin funds this escrow). It pays for the work whose value
 * is spread across the whole graph, which no topical funder buys: sweeps,
 * curation, audits, waiting work, passes where something changed. Extending
 * coverage is for the mandates and readers who care about a region. It spends the way every
 * mandate does: its program officers commission work under an OPERATING
 * POLICY written in prose, which its Grantmaker revises as the record of
 * what its money did accumulates, and its lookouts watch the graph for
 * what needs doing. GOVERNANCE is its counterpart for audit (#363): it pays
 * for the Audit Agent's runs, never an audit of itself.
 * Beside them: Mathematics and Mathematics prizes (docs/mathematics.md §10
 * and Appendix B: one mandate funds formalizations, attempts, and
 * stewardship; the other offers prizes from its own escrow and funds
 * nothing else in this epoch) and AI Economics, topical standing mandates.
 *
 * There is no prize fund. A bounty is held against the escrow of the
 * mandate that posted it (docs/mathematics.md §8.1), so the Mathematics
 * prizes mandate's escrow is the only source of its prizes and the only
 * money this seed puts behind them.
 *
 * Idempotent: re-running tops nothing up and never duplicates. It finds a
 * mandate by its KEY (stored on the row as mandate.seed_key), falling back
 * to its title or a title it had before (previousTitles) for a row seeded
 * before keys were stored, so a mandate can be renamed here. Changing a
 * budget here never alters an existing row; the money flags below are the
 * only path that changes one.
 *
 * Local:  DATABASE_URL=… npm run seed:platform-mandates
 * Prod:   the DB is private, so run it as a one-off ECS task on the API's own
 *         task definition, which supplies DB_HOST/DB_NAME and the credential
 *         secrets already:
 *
 *   aws ecs run-task --cluster <cluster> --task-definition <api-taskdef> \
 *     --launch-type FARGATE --network-configuration <the service's subnets/SG> \
 *     --overrides '{"containerOverrides":[{"name":"api",
 *       "command":["npm","run","seed:platform-mandates"]}]}'
 *
 * On a deployment with more than one label, say which label the mandates
 * work at: --label <name> (src/script-label.ts). Without it the seed is
 * refused there, since a mandate is never public by omission.
 *
 * Flags (docs/mathematics.md §10.9):
 *   --update-mandate <key>   update an existing mandate's text, skills, and
 *                            allocation policy keys from this file; never
 *                            its money, and never an operating policy its
 *                            Grantmaker has since written. Adds any seeded
 *                            lookout it lacks. Records the revision.
 *                            Works for every key here (mathematics and
 *                            mathematics-prizes included). A changed title
 *                            or objective is applied and recorded as a
 *                            terms version: the merged PR that changed this
 *                            file is the platform's approval of its terms.
 *   --replace-policy         with --update-mandate: also write this file's
 *                            operating policy over the one in force, and
 *                            this file's briefs onto the seeded lookouts
 *                            (by title). For when the platform, as funder,
 *                            changes what the mandate is for: the Grantmaker
 *                            revises from the new policy afterwards, as
 *                            before. Every version is kept
 *                            (mandate_policy_versions). Needs --note.
 *   --note "<why>"           the public reason recorded with --replace-policy.
 *   --mandate <key>          the mandate a money flag applies to; defaults
 *                            to the --update-mandate key when both are given.
 *   --daily-owls N           set the mandate's daily rate.
 *   --top-up-owls N          mint and escrow N more platform owls into the
 *                            mandate under a batch-keyed idempotency key
 *                            (see --top-up-batch), exactly as creation does.
 *   --top-up-batch <key>     the top-up's batch key (default: today's date).
 */
import { rawQuery, withTransaction, closeDb } from "../src/db/client.js";
import { runAtScriptLabel } from "../src/script-label.js";
import { loadConfig } from "../src/config.js";
import { owlsToMicroUsd } from "../src/services/owl.js";
import {
  STANDING_NOTES,
  createStandingMandate,
  ensureLookouts as ensureMandateLookouts,
  mandateJson,
  standingMandates,
  type StandingMandate,
} from "../src/services/standing-mandates.js";

type PlatformMandate = StandingMandate;

/** Stand up the seeded lookouts a mandate does not already have (by title). */
const ensureLookouts = (m: PlatformMandate, grantId: string) =>
  ensureMandateLookouts(m, grantId, (line) => console.log(line));

const owls = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const percent = (fraction: number) => `${Math.round(fraction * 100)} percent`;

/**
 * The sentences every mandate that carries the Mathematics skill states in
 * its prize policy (docs/mathematics.md §10.4), after the sentences that
 * say which mandate posts prizes in this epoch. The bounds are read from
 * the environment so the text says what the mechanism enforces.
 */
function commonPrizePolicy(): string {
  const config = loadConfig();
  return (
    "A prize never changes what the graph concludes. It enters no assessment, " +
    "no measure of a claim's importance, and no standard of evidence, and " +
    "the agents that assess claims never see a prize as a reason for " +
    "anything.\n\n" +
    "A prize can be offered only on a problem that has been made precise and " +
    "tried. The problem must carry a formal statement that has been public " +
    "for its review period, and the platform's own prover must have " +
    "attempted it at maximum effort without settling it, with the attempt's " +
    "report published. The prize is then for a proof or disproof of that " +
    "exact statement, and nothing else.\n\n" +
    "The Grantmaker sets each amount, in owls, from three things: how much " +
    "the field would gain from a settled answer, how much work the problem " +
    "appears to demand of a capable solver, and how much of the mandate's " +
    "budget is free and how many prizes are already open. Where a mandate " +
    "funds both attempts and prizes, the Grantmaker also says why a prize is " +
    "the better use of those owls than another attempt. The reasoning is " +
    "published with every posting.\n\n" +
    `The limits: each prize is between ${owls(config.minBountyPerClaimOwls)} and ${owls(config.maxBountyPerClaimOwls)} owls; ` +
    "one problem carries at most one open prize; the prizes a mandate holds " +
    "open never exceed the free part of its budget; a single review pass " +
    `commits at most ${percent(config.bountyEscrowFractionPerPass)} of the budget and a single day at most ` +
    `${percent(config.bountyEscrowFractionPerDay)}; every posting is made in two separate passes so that no single ` +
    `judgment binds the platform; and a prize of ${owls(config.bountyAutonomyThresholdOwls)} owls or more waits for a ` +
    "named person to confirm it.\n\n" +
    "Prizes are stated and paid in owls, each worth one dollar of metered " +
    "work on the platform, and every prize owl is backed by budget that was " +
    "paid for before the offer was made. A submission that settles a " +
    "mis-stated problem earns a defect award rather than the prize, and the " +
    "statement is corrected. A proof already in the literature earns credit " +
    "on the problem's page, not the prize. The platform never claims a prize " +
    "itself: if its own prover settles the problem first, the prize closes " +
    "unpaid and the proof is published. No prize is posted on a problem that " +
    "already carries someone else's prize until the question of double " +
    "payment is settled."
  );
}

/** The Mathematics mandate, Appendix B, with its bracketed numbers read from the environment. */
function mathematicsMandate(): PlatformMandate {
  const config = loadConfig();
  const lifetimeCapOwls = 500;
  const cooldownDays = 30;
  return {
    key: "mathematics",
    title: "Mathematics",
    objective:
      "To build and keep the graph's map of mathematics, and to direct " +
      "attention to the open problems worth settling. The mandate pays for " +
      "three kinds of work: recording what is settled, accurately and cheaply; " +
      "holding what is open, each conjecture with its partial results, what " +
      "would follow from it, and what the field expects; and making the " +
      "problems that matter precise enough, and trying them hard enough, that " +
      "when an answer comes it can be checked by a machine and trusted by " +
      "anyone. Its worth is measured by the ordering it produces and the " +
      "questions it poses, not by the theorems it proves.",
    // websearch OR-form: a topical scope wants anything matching ANY of
    // its terms, not the conjunction of all of them.
    scopeQuery: "mathematics OR theorem OR conjecture OR proof",
    strategy:
      "Cover the mathematical claims in scope with light assessments first, and " +
      "spend depth where working mathematicians disagree. Write formal " +
      "statements for the open problems of real standing and for the lemmas " +
      "several of them rest on. Calibrate the prover on problems with known " +
      "answers before pointing it at open ones. Attempt open problems in order " +
      "of how much they matter times how tractable they look, and attempt the " +
      "sub-results before the problems that rest on them. Publish every " +
      "attempt, every statement, and every check. Post no prizes from this " +
      "budget in this epoch; the Mathematics prizes mandate posts them. Revise " +
      "this mandate's own numbers as live results replace the estimates.",
    sections: {
      scope:
        "Propositions of mathematics; the contested applications of " +
        "mathematical results elsewhere in the graph; and claims about the " +
        "practice of mathematics where they are live. The history and " +
        "sociology of mathematics are out of scope except where a claim of the " +
        "first kind turns on them. The search terms that retrieve candidates " +
        "(mathematics, theorem, conjecture, proof) are a net, not a definition; " +
        "which work falls under this mandate is the Grantmaker's judgment, and " +
        "the mathematics tag on a claim is a strong prior for it.",
      prize_policy:
        "This mandate funds assessment, formal statements, and attempts, and in " +
        "this epoch it posts no prizes; the Mathematics prizes mandate posts " +
        "them. Both mandates draw only on budgets a Grantmaker allocates, and " +
        "nothing else on the platform funds a prize.\n\n" +
        commonPrizePolicy(),
      attempt_policy:
        "An attempt is valued as expected information: how much the problem " +
        "matters, times the Grantmaker's stated probability that this attempt " +
        "succeeds, times a factor of one to two for a sub-result that several " +
        "open problems rest on. A prize appears nowhere in that formula. Before " +
        "an attempt can be scheduled the problem needs a published formal " +
        `statement; lifetime attempt spending on the problem must be under ${owls(lifetimeCapOwls)} ` +
        "owls; no attempt on the statement may be running; and at least " +
        `${cooldownDays} days must have passed since the last attempt unless a reason is ` +
        "stated. The Millennium-class problems are not attempted in this epoch. " +
        "Every attempt is disclosed on the problem's page with its date, its " +
        "effort, its cost, and its outcome, and its report and notebook are " +
        "published before any prize opens on the statement.",
      refusals:
        "This mandate declines, whatever the budget offered: any request to " +
        "assess a claim, post a prize, or schedule an attempt whose purpose is " +
        "to move an assessment or a measure of importance; any prize on a " +
        "statement it cannot show is faithful to the problem; any funding " +
        "offered on condition of being named, of influencing a statement, or " +
        "of having a say in whether a proof is accepted; and any attempt on a " +
        "claim its steward has not tagged and reviewed.",
      disclosure:
        "The attention this claim received was paid for by the Mathematics " +
        "mandate. Funding buys only scheduling: it can make an assessment " +
        "happen sooner, reach deeper into a subtree, or send the platform's own " +
        "prover at a problem. It has no influence on what any assessment " +
        "concludes. Where a prize is offered, it says only that someone would " +
        "like the question settled.",
    },
    budgetOwls: config.mathMandateEscrowOwls,
    policy: "cover",
    dailyBudgetOwls: config.mathMandateDailyOwls,
    skills: ["mathematics"],
    allocationPolicy: {
      est_formalize_cost_owls: 8,
      est_attempt_standard_cost_owls: 60,
      est_attempt_max_cost_owls: 150,
      est_prize_review_cost_owls: 12,
      attempt_cooldown_days: cooldownDays,
      attempt_claim_lifetime_cap_owls: lifetimeCapOwls,
    },
  };
}

/**
 * The Mathematics prizes mandate (docs/mathematics.md §8.1, §10.4, Appendix
 * B): a prizes-only mandate whose budget is the only source of its prizes.
 * No daily rate: its spend is prizes, paced by the per-pass and per-day
 * fractions of the budget, and its own review passes.
 */
function mathematicsPrizesMandate(): PlatformMandate {
  const config = loadConfig();
  return {
    key: "mathematics-prizes",
    title: "Mathematics prizes",
    objective:
      "To offer prizes, on terms fixed in advance, for proofs and disproofs " +
      "of the open problems the platform has made precise and tried and could " +
      "not settle, so that when someone finds the answer it becomes part of " +
      "the public record. In this epoch the mandate funds nothing else: no " +
      "assessments, no formal statements, no attempts. Its budget is the only " +
      "source of its prizes, and each prize is the mandate's own judgment, " +
      "stated publicly with the posting, about which settled answer the field " +
      "would gain most from.",
    scopeQuery: "mathematics OR theorem OR conjecture OR proof",
    strategy:
      "Read the platform's record of attempts and post prizes only on " +
      "published statements the prover tried at maximum effort and could not " +
      "settle, after their review period, with the attempt's report public. " +
      "Size each prize from what the field would gain from a settled answer, " +
      "how much work the problem appears to demand, and how much of the budget " +
      "is free and how many prizes are already open. Make the first prizes " +
      "small and deliberately tractable, one of them on a problem chosen to " +
      "exercise the whole path from posting to payment, and say so publicly. " +
      "Renew a prize that still earns its place and withdraw, with notice, one " +
      "that does not. Revise this mandate's own estimates as prizes are " +
      "claimed, expire, or close.",
    sections: {
      scope:
        "Published formal statements, in Lean 4 against a fixed version of " +
        "Mathlib, of open problems of mathematics that the platform's prover " +
        "has attempted without settling. The search terms that retrieve " +
        "candidates (mathematics, theorem, conjecture, proof) are a net, not a " +
        "definition; which statements deserve a prize is the Grantmaker's " +
        "judgment, made from the record of attempts, the problem's importance, " +
        "and the results that rest on it.",
      prize_policy:
        "This mandate offers prizes and funds nothing else in this epoch. Its " +
        "budget is the only source of its prizes: a prize holds its amount " +
        "against the budget from the moment it opens until it resolves, and " +
        "what the mandate can offer is what remains after every hold.\n\n" +
        commonPrizePolicy(),
      refusals:
        "This mandate declines, whatever the budget offered: any prize whose " +
        "purpose is to move an assessment or a measure of importance; any " +
        "prize on a statement it cannot show is faithful to the problem, whose " +
        "review period has not ended, or which the platform's prover has not " +
        "attempted without settling; any request to fund an attempt, a formal " +
        "statement, or an assessment from this budget in this epoch; and any " +
        "funding offered on condition of being named, of influencing a " +
        "statement, or of having a say in whether a proof is accepted.",
      disclosure:
        "The prize on this claim was offered by the Mathematics prizes mandate " +
        "from its own budget. A prize buys no attention and no conclusion: it " +
        "does not change how the claim is assessed or how important the graph " +
        "judges it to be, and it says only that someone would like the " +
        "question settled.",
    },
    budgetOwls: config.mathPrizesEscrowOwls,
    policy: "cover",
    dailyBudgetOwls: 0,
    skills: ["mathematics"],
    allocationPolicy: {
      est_prize_review_cost_owls: 12,
    },
  };
}

function mandates(): PlatformMandate[] {
  return [
    // General and Governance: one definition, shared with the routes a
    // members-only deployment sets its own up through
    // (src/services/standing-mandates.ts). Here they are Minerval's.
    ...standingMandates("minerval"),
    mathematicsMandate(),
    mathematicsPrizesMandate(),
    {
      key: "ai-economics",
      title: "AI Economics",
      objective:
        "Map and assess the claims the AI-economics debate actually turns " +
        "on: labor-market effects, productivity and growth estimates, " +
        "compute and capability economics, market structure, and the policy " +
        "claims that depend on them. This is a fast-moving, contested area; " +
        "reassessment cadence matters as much as coverage.",
      scopeQuery:
        "economics OR labor OR productivity OR automation OR wage OR employment",
      strategy:
        "Cover the unassessed cruxes first, reassess anything stale in a " +
        "field that moves monthly, and deepen the claims whose subtrees " +
        "carry the contested elasticity and adoption estimates.",
      budgetOwls: 100,
      policy: "cover",
      dailyBudgetOwls: 10,
      skills: [],
      allocationPolicy: null,
    },
  ];
}

const STANDING_NOTE = STANDING_NOTES.minerval;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  /** Print one mandate's text as Markdown (the design's Appendix B) and exit; no database. */
  printMandate: string | null;
  updateMandate: string | null;
  mandate: string | null;
  dailyOwls: number | null;
  topUpOwls: number | null;
  topUpBatch: string;
  /** With updateMandate: write the seeded operating policy and lookout briefs over the live ones. */
  replacePolicy: boolean;
  note: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    printMandate: null,
    updateMandate: null,
    mandate: null,
    dailyOwls: null,
    topUpOwls: null,
    topUpBatch: new Date().toISOString().slice(0, 10),
    replacePolicy: false,
    note: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--print-mandate":
        args.printMandate = next();
        break;
      case "--update-mandate":
        args.updateMandate = next();
        break;
      case "--mandate":
        args.mandate = next();
        break;
      case "--daily-owls":
        args.dailyOwls = Number(next());
        if (!Number.isFinite(args.dailyOwls) || args.dailyOwls < 0) {
          throw new Error("--daily-owls needs a non-negative number");
        }
        break;
      case "--top-up-owls":
        args.topUpOwls = Number(next());
        if (!Number.isFinite(args.topUpOwls) || args.topUpOwls <= 0) {
          throw new Error("--top-up-owls needs a positive number");
        }
        break;
      case "--top-up-batch":
        args.topUpBatch = next();
        break;
      case "--replace-policy":
        args.replacePolicy = true;
        break;
      case "--note":
        args.note = next().trim() || null;
        break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  if (args.mandate === null) args.mandate = args.updateMandate;
  if (args.replacePolicy && !args.updateMandate) {
    throw new Error("--replace-policy needs --update-mandate <key>");
  }
  if (args.replacePolicy && !args.note) {
    throw new Error("--replace-policy needs --note \"<why>\": it is the public record of the change");
  }
  if ((args.dailyOwls !== null || args.topUpOwls !== null) && !args.mandate) {
    throw new Error("--daily-owls and --top-up-owls need --mandate <key>");
  }
  return args;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

async function ensurePlatformAccount(): Promise<string> {
  const [platform] = await rawQuery<{ id: string }>(
    `INSERT INTO contributors (external_id, display_name)
     VALUES ('platform:minerval', 'Minerval')
     ON CONFLICT (external_id)
       DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`
  );
  return platform!.id;
}

/** Mint the platform's owls (idempotent), escrow them, and create the grant. */
async function createMandate(m: PlatformMandate, platformId: string): Promise<string> {
  return createStandingMandate({
    mandate: m,
    funderId: platformId,
    budgetReason: "admin_adjust",
    ledgerKey: m.key,
    note: STANDING_NOTE,
  });
}

// ---------------------------------------------------------------------------
// Updating a live row (§10.9)
// ---------------------------------------------------------------------------

interface ExistingMandate {
  id: string;
  name: string;
  budget_job_id: string;
  mandate: Record<string, unknown> | null;
  plan: { strategy?: string; items?: unknown[] } | null;
}

/**
 * The platform row a seeded mandate is: by its stored key, else (a row
 * seeded before keys were stored) by its title or a title it had before.
 * The key wins, so a rename in this file finds the row it renames.
 */
async function lookUp(m: PlatformMandate): Promise<ExistingMandate | null> {
  const [existing] = await rawQuery<ExistingMandate>(
    `SELECT id, name, budget_job_id, mandate, plan FROM grants
      WHERE is_platform = true
        AND (mandate->>'seed_key' = $1
             OR (mandate->>'seed_key' IS NULL AND name = ANY($2::text[])))
      ORDER BY (mandate->>'seed_key' = $1) DESC NULLS LAST, created_at ASC
      LIMIT 1`,
    [m.key, [m.title, ...(m.previousTitles ?? [])]]
  );
  return existing ?? null;
}

async function findExisting(m: PlatformMandate): Promise<ExistingMandate> {
  const existing = await lookUp(m);
  if (!existing) {
    throw new Error(`no platform mandate "${m.title}" (key ${m.key}) exists to update; run the seed first`);
  }
  return existing;
}

/**
 * The money flags, applied to one mandate: the daily rate, and a top-up
 * minted and escrowed exactly as creation does, once per batch key. Returns
 * the revision sentences to record on the row.
 */
async function applyMoney(
  m: PlatformMandate,
  existing: ExistingMandate,
  args: Args,
  platformId: string,
  tx: { query: <T>(q: string, p?: unknown[]) => Promise<T[]> }
): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const revisions: string[] = [];
  if (args.dailyOwls !== null) {
    await tx.query(
      `UPDATE grants SET daily_budget_micro_usd = $2, updated_at = now() WHERE id = $1`,
      [existing.id, owlsToMicroUsd(args.dailyOwls)]
    );
    revisions.push(`The daily rate was set to ${owls(args.dailyOwls)} owls on ${today}.`);
    console.log(`~ ${m.title}: daily rate ${owls(args.dailyOwls)} owls`);
  }
  if (args.topUpOwls !== null) {
    const micro = owlsToMicroUsd(args.topUpOwls);
    const mintKey = `platform_mandate_mint:${m.key}:${args.topUpBatch}`;
    const holdKey = `platform_mandate_hold:${m.key}:${args.topUpBatch}`;
    const minted = await tx.query<{ id: string }>(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
       VALUES ($1, $2, 'admin_adjust', $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [platformId, micro, mintKey]
    );
    if (minted.length > 0) {
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id, idempotency_key)
         VALUES ($1, $2, 'escrow_hold', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [platformId, -micro, existing.budget_job_id, holdKey]
      );
      // The same increment the contribution path makes: a job paused for
      // budget resumes.
      await tx.query(
        `UPDATE budget_jobs
            SET budget_micro_usd = budget_micro_usd + $2,
                status = CASE WHEN status = 'paused_budget' THEN 'running' ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [existing.budget_job_id, micro]
      );
      revisions.push(
        `The escrow was topped up by ${owls(args.topUpOwls)} owls on ${today} (batch ${args.topUpBatch}).`
      );
      console.log(`+ ${m.title}: topped up ${owls(args.topUpOwls)} owls (batch ${args.topUpBatch})`);
    } else {
      console.log(`= ${m.title}: top-up batch ${args.topUpBatch} already applied`);
    }
  }
  return revisions;
}

/** The text, the skills, and the policy keys: never the money. */
async function updateMandateText(m: PlatformMandate, args: Args, platformId: string): Promise<void> {
  const existing = await findExisting(m);
  const today = new Date().toISOString().slice(0, 10);
  const previousNotes = String(existing.mandate?.notes ?? STANDING_NOTE);

  await withTransaction(async (tx) => {
    // The money first, so the note records only what actually happened.
    const revisions: string[] = [`The mandate text was revised on ${today} by the platform.`];
    const before = {
      title: (existing.mandate?.title as string | undefined) ?? existing.name,
      objective: (existing.mandate?.objective as string | undefined) ?? null,
    };
    const termsChanged = before.title !== m.title || before.objective !== m.objective;
    if (before.title !== m.title) revisions.push(`It was renamed from "${before.title}" to "${m.title}".`);
    if (args.replacePolicy) {
      revisions.push(`Its operating policy was replaced by the platform: ${args.note}`);
    }
    if (args.mandate === m.key) {
      revisions.push(...(await applyMoney(m, existing, args, platformId, tx)));
    }
    const notes = `${previousNotes.trim()}\n\n${revisions.join(" ")}`.trim();
    const mandate = {
      ...(existing.mandate ?? {}),
      ...mandateJson(m, notes),
      // The plan on the row is the live one; the text's plan block keeps
      // the strategy and whatever items the row already carries.
      plan: { strategy: m.strategy, items: existing.plan?.items ?? [] },
      expected_cost_owls: existing.mandate?.expected_cost_owls ?? m.budgetOwls,
      // The Grantmaker's operating policy, once written, is its own;
      // --replace-policy writes over it below, through the versioned path.
      ...(existing.mandate?.operating_policy ? { operating_policy: existing.mandate.operating_policy } : {}),
    };
    await tx.query(
      `UPDATE grants
          SET mandate = $2::jsonb,
              name = $7,
              skills = $3,
              scope_query = $4,
              plan = jsonb_set(COALESCE(plan, '{}'::jsonb), '{strategy}', to_jsonb($5::text)),
              allocation_policy = CASE
                WHEN $6::jsonb IS NULL THEN allocation_policy
                ELSE COALESCE(allocation_policy, '{}'::jsonb) || $6::jsonb END,
              updated_at = now()
        WHERE id = $1`,
      [
        existing.id,
        JSON.stringify(mandate),
        m.skills,
        m.scopeQuery,
        m.strategy,
        m.allocationPolicy ? JSON.stringify(m.allocationPolicy) : null,
        m.title,
      ]
    );
    // The terms as approved: the merged change to this file is the
    // platform's approval, so the amendment is applied and recorded, not
    // left awaiting an approver (mandate-terms-service.ts).
    if (termsChanged) {
      await tx.query(
        `INSERT INTO mandate_policy_versions (grant_id, part, content, note, author)
         VALUES ($1, 'terms', $2::jsonb, $3, 'platform')`,
        [
          existing.id,
          JSON.stringify({ before, after: { title: m.title, objective: m.objective } }),
          args.note ?? `Revised by the platform in scripts/seed-platform-mandates.ts on ${today}.`,
        ]
      );
    }
  });
  if (args.replacePolicy) await replacePolicy(m, existing.id, args.note!);
  await ensureLookouts(m, existing.id);
  console.log(
    `~ ${m.title} updated (${existing.id}): text, skills [${m.skills.join(", ")}], ` +
      `policy keys ${m.allocationPolicy ? Object.keys(m.allocationPolicy).join(", ") : "(none)"}`
  );
}

/**
 * --replace-policy: the seeded operating policy written over the one in
 * force, through the same versioned path the Grantmaker writes it by, and
 * the seeded lookouts' briefs, triggers, heartbeats and limits onto the
 * lookouts of the same title. The Grantmaker owns both from then on.
 */
async function replacePolicy(m: PlatformMandate, grantId: string, note: string): Promise<void> {
  if (!m.operatingPolicy) throw new Error(`${m.title} has no seeded operating policy to write`);
  const { writeOperatingPolicy, POLICY_SECTIONS } = await import("../src/services/operating-policy-service.js");
  const op = m.operatingPolicy;
  const content = POLICY_SECTIONS.filter((sec) => op[sec]?.trim())
    .map((sec) => `### ${sec}\n${op[sec]!.trim()}`)
    .join("\n\n");
  const written = await writeOperatingPolicy({
    grantId,
    content,
    note,
    author: "platform",
    ...(op.officer_limit_owls != null ? { officerLimitOwls: op.officer_limit_owls } : {}),
    ...(op.review_pass_owls != null ? { reviewPassOwls: op.review_pass_owls } : {}),
  });
  if (!written.ok) throw new Error(`writing the operating policy failed: ${written.message}`);
  // writeOperatingPolicy takes the note as each figure's reason; the seed
  // states its own.
  if (op.officer_limit_reason || op.review_pass_reason) {
    await rawQuery(
      `UPDATE grants
          SET mandate = jsonb_set(mandate, '{operating_policy}',
                (mandate->'operating_policy') || $2::jsonb)
        WHERE id = $1`,
      [
        grantId,
        JSON.stringify({
          ...(op.officer_limit_reason ? { officer_limit_reason: op.officer_limit_reason } : {}),
          ...(op.review_pass_reason ? { review_pass_reason: op.review_pass_reason } : {}),
        }),
      ]
    );
  }
  console.log(`~ ${m.title}: operating policy replaced`);

  if (!m.lookouts?.length) return;
  const { updateLookout } = await import("../src/services/lookout-service.js");
  for (const l of m.lookouts) {
    const [existing] = await rawQuery<{ id: string }>(
      `SELECT id FROM lookouts WHERE grant_id = $1 AND title = $2 AND status <> 'retired'`,
      [grantId, l.title]
    );
    if (!existing) continue; // ensureLookouts creates it
    const r = await updateLookout({
      grantId,
      lookoutId: existing.id,
      brief: l.brief,
      heartbeatHours: l.heartbeatHours,
      triggers: l.triggers,
      commissionLimitOwls: l.commissionLimitOwls,
    });
    console.log(r.ok ? `  ~ lookout "${l.title}" brief replaced` : `  ! lookout "${l.title}": ${r.message}`);
  }
}

/** The money flags alone (--mandate without --update-mandate): the text stays. */
async function updateMandateMoney(m: PlatformMandate, args: Args, platformId: string): Promise<void> {
  const existing = await findExisting(m);
  await withTransaction(async (tx) => {
    const revisions = await applyMoney(m, existing, args, platformId, tx);
    if (revisions.length === 0) return;
    const previousNotes = String(existing.mandate?.notes ?? STANDING_NOTE);
    const notes = `${previousNotes.trim()}\n\n${revisions.join(" ")}`.trim();
    await tx.query(
      `UPDATE grants
          SET mandate = jsonb_set(COALESCE(mandate, '{}'::jsonb), '{notes}', to_jsonb($2::text)),
              updated_at = now()
        WHERE id = $1`,
      [existing.id, notes]
    );
  });
}

// ---------------------------------------------------------------------------

function mandateByKey(all: PlatformMandate[], key: string): PlatformMandate {
  const m = all.find((x) => x.key === key);
  if (!m) {
    throw new Error(`unknown mandate key "${key}"; known: ${all.map((x) => x.key).join(", ")}`);
  }
  return m;
}

/**
 * The mandate as Markdown, in the shape of docs/mathematics.md Appendix B,
 * so the design document is generated from the seed rather than copied.
 */
function renderMandateMarkdown(m: PlatformMandate): string {
  const block = (heading: string, text: string | undefined) => {
    if (!text) return [];
    const [first, ...rest] = text.split("\n\n");
    return [`**${heading}.** ${first}`, ...rest];
  };
  const keys = m.allocationPolicy
    ? Object.entries(m.allocationPolicy).map(([k, v]) => `\`${k}\` ${v}`).join("; ")
    : "none";
  const rate = m.dailyBudgetOwls > 0 ? `daily rate [${owls(m.dailyBudgetOwls)}] owls` : "no daily rate (escrow-bounded)";
  const parts = [
    `### ${m.title}`,
    `**Title.** ${m.title}`,
    ...block("Objective", m.objective),
    ...block("Strategy", m.strategy),
    ...block("Scope", m.sections?.scope),
    ...block("Prize policy", m.sections?.prize_policy),
    ...block("Attempt policy", m.sections?.attempt_policy),
    ...block("Refusals", m.sections?.refusals),
    ...block("Disclosure (shown on every claim this mandate funds)", m.sections?.disclosure),
    `**Allocation policy keys.** ${keys}; the standard keys unchanged.`,
    `**Budget.** Escrow [${owls(m.budgetOwls)}] owls; ${rate}; policy \`${m.policy}\`; skills \`${JSON.stringify(m.skills)}\`.`,
  ];
  return parts.join("\n\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = mandates();
  if (args.printMandate) {
    process.stdout.write(renderMandateMarkdown(mandateByKey(all, args.printMandate)));
    return;
  }
  const platformId = await ensurePlatformAccount();

  if (args.updateMandate) {
    await updateMandateText(mandateByKey(all, args.updateMandate), args, platformId);
    if (args.mandate && args.mandate !== args.updateMandate) {
      await updateMandateMoney(mandateByKey(all, args.mandate), args, platformId);
    }
    return;
  }
  if (args.mandate) {
    await updateMandateMoney(mandateByKey(all, args.mandate), args, platformId);
    return;
  }

  for (const m of all) {
    const existing = await lookUp(m);
    if (existing) {
      console.log(`= ${m.title} already exists (${existing.id})`);
    } else {
      const grantId = await createMandate(m, platformId);
      console.log(`+ ${m.title} created (${grantId}), ${owls(m.budgetOwls)} owls`);
      await ensureLookouts(m, grantId);
    }
  }
}

// On a deployment with more than one label the mandates are seeded at the
// label the operator names (--label, src/script-label.ts): the label the
// deployment's ordinary work is at. Their work then runs at that label, and
// a mandate that needs to pay for work it cannot read regrants to one at a
// label that can. On the public graph nothing is named and nothing changes.
runAtScriptLabel("seed-platform-mandates", main)
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
