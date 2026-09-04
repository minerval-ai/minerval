/**
 * Seed the platform's own mandates, the ones Minerval sets up and runs,
 * which take pride of place on the public /mandates page.
 *
 * The load-bearing one is GENERAL ASSESSMENT: the mandate whose escrow is
 * however many dollars Minerval allocates to expanding and maintaining the
 * graph (Minerval buys owls at $1 per owl, at cost; the $4 price is what
 * users pay, and the margin funds this escrow). Its allocator backs the
 * highest value-per-dollar assessments up to its daily rate through the
 * same allocation engine every funder uses, and its ALLOCATION POLICY is
 * the platform's formulas, amendable by its Grantmaker in conversation.
 * Beside it: Mathematics and Mathematics prizes (docs/mathematics.md §10
 * and Appendix B: one mandate funds formalizations, attempts, and
 * stewardship; the other offers prizes from its own escrow and funds
 * nothing else in this epoch) and AI Economics, topical standing mandates.
 *
 * There is no prize fund. A bounty is held against the escrow of the
 * mandate that posted it (docs/mathematics.md §8.1), so the Mathematics
 * prizes mandate's escrow is the only source of its prizes and the only
 * money this seed puts behind them.
 *
 * Idempotent: re-running tops nothing up and never duplicates. It matches
 * on mandate TITLE, so changing a budget here never alters an existing
 * row; the money flags below are the only path that changes one.
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
 * Flags (docs/mathematics.md §10.9):
 *   --update-mandate <key>   update an existing mandate's text, skills, and
 *                            allocation policy keys from this file; never
 *                            its money. Records the revision on the row.
 *                            Works for every key here (mathematics and
 *                            mathematics-prizes included).
 *   --mandate <key>          the mandate a money flag applies to; defaults
 *                            to the --update-mandate key when both are given.
 *   --daily-owls N           set the mandate's daily rate.
 *   --top-up-owls N          mint and escrow N more platform owls into the
 *                            mandate under a batch-keyed idempotency key
 *                            (see --top-up-batch), exactly as creation does.
 *   --top-up-batch <key>     the top-up's batch key (default: today's date).
 */
import { rawQuery, withTransaction, closeDb } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { owlsToMicroUsd } from "../src/services/owl.js";

interface PlatformMandate {
  key: string;
  title: string;
  objective: string;
  scopeQuery: string | null;
  strategy: string;
  budgetOwls: number;
  policy: "general" | "cover";
  dailyBudgetOwls: number;
  /** The mandate's domain skills (grants.skills); none for the General mandate. */
  skills: string[];
  /** Policy keys the mandate overlays on the shared defaults, if any. */
  allocationPolicy: Record<string, number> | null;
  /** The longer sections a mandate page carries beyond objective and strategy. */
  sections?: {
    scope?: string;
    prize_policy?: string;
    attempt_policy?: string;
    refusals?: string;
    disclosure?: string;
  };
}

const owls = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const percent = (fraction: number) => `${Math.round(fraction * 100)} percent`;

/**
 * The sentences every mandate that carries the Mathematics skill states in
 * its prize policy (docs/mathematics.md §10.4), after the sentence that
 * says which mandate posts prizes in this epoch. The bounds are read from
 * the environment so the text says what the mechanism enforces.
 */
function commonPrizePolicy(): string {
  const config = loadConfig();
  return (
    "Prizes never enter any valuation, importance, assessment, or standard. " +
    "A bounty binds only to a published formal statement whose review period " +
    "has ended and which the platform's solver has attempted at maximum " +
    "effort without settling, with the attempt's report public. Amounts are " +
    "set by the Grantmaker in owls from how much the discourse would gain " +
    "from a settled answer, the effort the problem appears to require from a " +
    "capable claimant, and the posting mandate's headroom and the number of " +
    "open bounties; where a mandate funds both attempts and prizes, its " +
    "Grantmaker says with each posting why a prize is the better use of " +
    "those owls than another attempt; amounts never feed back into " +
    "importance, and the reasoning is stated publicly with each posting. " +
    `Bounds: ${owls(config.minBountyPerClaimOwls)} to ${owls(config.maxBountyPerClaimOwls)} owls per claim; ` +
    "at most one live bounty per claim; holds never above the posting " +
    "mandate's headroom, and per pass and per day at most " +
    `${percent(config.bountyEscrowFractionPerPass)} and ${percent(config.bountyEscrowFractionPerDay)} of its escrow; ` +
    "every posting made in two passes and, at or above " +
    `${owls(config.bountyAutonomyThresholdOwls)} owls, confirmed by a human. ` +
    "Prizes are stated and paid in owls, valued at one dollar of metered " +
    "cost each, and every prize owl is backed by escrow that was paid for " +
    "before the offer was made. A trivial resolution of a mis-stated problem " +
    "earns the defect award, not the prize; a rediscovery of a published " +
    "proof earns credit on the page, not the prize; the platform is never a " +
    "claimant. No bounty is posted on a problem carrying a third-party prize " +
    "in the discourse until the double-payment question is settled."
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
      "To be the graph's map of mathematics and its instrument for directing " +
      "attention to open problems. The mandate records settled results cheaply " +
      "and accurately; holds the live conjectures with their partial results, " +
      "their conditional consequences, and the field's considered expectation; " +
      "publishes reviewed formal statements, in Lean 4 against a pinned Mathlib, " +
      "of the problems that matter; holds independent proofs of one result side " +
      "by side; attempts, with the platform's own solver, the problems where an " +
      "attempt has a real chance of settling the question or teaching where the " +
      "difficulty lies; and sees prizes offered, by the Mathematics prizes " +
      "mandate in this epoch, on the problems the platform could not settle, so " +
      "that the answer, when someone finds it, becomes part of the public " +
      "record on terms fixed in advance. The mandate's value is the ordering it " +
      "produces and the questions it poses, not the theorems it proves.",
    // websearch OR-form: a topical scope wants anything matching ANY of
    // its terms, not the conjunction of all of them.
    scopeQuery: "mathematics OR theorem OR conjecture OR proof",
    strategy:
      "Cover unassessed mathematical claims in scope with light passes, " +
      "concentrating depth where working mathematicians disagree. Formalize the " +
      "open problems in the notable range and the lemmas several of them rest " +
      "on. Calibrate the solver on settled problems before attempting open ones. " +
      "Attempt open problems in order of importance times tractability, " +
      "sub-results before the problems that rest on them. Publish the attempt " +
      "reports and statements the Mathematics prizes mandate posts bounties on; " +
      "post no bounties from this escrow in this epoch. Keep every attempt, " +
      "every statement, every check, and every prize decision public. Revise " +
      "this mandate's own policy numbers as live series replace the priors.",
    sections: {
      scope:
        "Propositions of mathematics; the contested applications of mathematical " +
        "results elsewhere in the graph; and claims about the discourse of " +
        "mathematics where they are live. The history and sociology of " +
        "mathematics are out of scope except where a claim of the first kind " +
        "turns on them. The scope query (mathematics OR theorem OR conjecture OR " +
        "proof) is retrieval, not membership; which actions fall under this " +
        "mandate is the Grantmaker's judgment, and the mathematics domain tag is " +
        "a strong prior for it.",
      prize_policy:
        "This mandate funds formalizations, attempts, and stewardship, and in " +
        "this epoch it posts no prizes; the Mathematics prizes mandate posts " +
        "them. Both mandates draw on escrows a Grantmaker allocates, and " +
        "nothing else funds a prize. " +
        commonPrizePolicy(),
      attempt_policy:
        "An attempt is valued as expected information: importance times the " +
        "Grantmaker's stated probability that this variant succeeds times a " +
        "multiplier of 1.0 to 2.0 for sub-results several open problems rest on. " +
        "A bounty appears nowhere in the formula. Preconditions: a published " +
        `formal statement; lifetime attempt spend on the claim under ${owls(lifetimeCapOwls)} ` +
        `owls; no running attempt on the statement; at least ${cooldownDays} days since ` +
        "the last attempt unless a reason is stated. Millennium-class problems " +
        "are not attempted in this epoch. Every attempt is disclosed on the claim " +
        "page with its date, variant, cost, and outcome, and its report and " +
        "notebook are published before any bounty opens on the statement.",
      refusals:
        "This mandate declines, at any budget: any request to value a claim, " +
        "post a bounty, or schedule an attempt whose purpose is to move an " +
        "assessment or an importance; any bounty on a statement it cannot show " +
        "is faithful; any sponsorship offered on condition of naming, influence " +
        "over the statement, or a say in acceptance; and any attempt on a claim " +
        "the steward has not tagged and stewarded.",
      disclosure:
        "The attention this claim received was paid for by the Mathematics " +
        "mandate. Funding buys only scheduling: it can make an assessment happen " +
        "sooner, reach deeper into a subtree, or send the platform's own solver " +
        "at a problem. It has no influence on what any assessment concludes. " +
        "Where a prize is offered, it says only that someone would like the " +
        "question settled.",
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
 * B): a prizes-only mandate whose escrow is the only source of its prizes.
 * No daily rate: its spend is prizes, paced by the per-pass and per-day
 * fractions of the escrow, and its own review passes.
 */
function mathematicsPrizesMandate(): PlatformMandate {
  const config = loadConfig();
  return {
    key: "mathematics-prizes",
    title: "Mathematics prizes",
    objective:
      "To offer prizes, on terms fixed in advance, for Lean proofs and " +
      "disproofs of the open problems the platform attempted and could not " +
      "settle, so that the answer, when someone finds it, becomes part of the " +
      "public record. In this epoch the mandate funds nothing else: no " +
      "formalizations, no attempts, no stewardship. Its escrow is the only " +
      "source of its prizes, and each prize it offers is the mandate's own " +
      "judgment, stated publicly with the posting, about which settled answer " +
      "the discourse would gain most from.",
    scopeQuery: "mathematics OR theorem OR conjecture OR proof",
    strategy:
      "Read the platform's attempt record and post bounties only on published " +
      "statements the solver attempted at maximum effort and could not settle, " +
      "after their public review period, with the attempt's report public. " +
      "Size each prize from what the discourse would gain from a settled " +
      "answer, the effort the problem appears to demand of a capable claimant, " +
      "and the escrow's headroom and the number of open bounties. Post the " +
      "first bounties small and deliberately tractable, one of them on a " +
      "problem chosen to exercise the whole path from posting to payment, and " +
      "say so publicly. Renew a bounty that still earns its place and withdraw, " +
      "with notice, one that does not. Revise this mandate's own priors as " +
      "prizes are claimed, expire, or close.",
    sections: {
      scope:
        "Published formal statements, in Lean 4 against a pinned Mathlib, of " +
        "open problems of mathematics that the platform's solver has attempted " +
        "without settling. The scope query (mathematics OR theorem OR conjecture " +
        "OR proof) is retrieval, not membership; which statements deserve a " +
        "prize is the Grantmaker's judgment, made from the attempt record, the " +
        "claim's importance, and the results that rest on it.",
      prize_policy:
        "This mandate offers prizes and funds nothing else in this epoch. Its " +
        "escrow is the only source of its prizes: a bounty holds its amount " +
        "against the escrow from the moment it opens until it resolves, and the " +
        "mandate's headroom is what remains after every hold. " +
        commonPrizePolicy(),
      refusals:
        "This mandate declines, at any budget: any bounty whose purpose is to " +
        "move an assessment or an importance; any bounty on a statement it " +
        "cannot show is faithful, whose review period has not ended, or which " +
        "the platform's solver has not attempted without settling; any request " +
        "to fund an attempt, a formalization, or an assessment from this escrow " +
        "in this epoch; and any sponsorship offered on condition of naming, " +
        "influence over a statement, or a say in acceptance.",
      disclosure:
        "The prize on this claim was offered by the Mathematics prizes mandate " +
        "from its own escrow. A prize buys no attention and no conclusion: it " +
        "does not change how the claim is assessed or how important the graph " +
        "judges it to be, and it says only that someone would like the question " +
        "settled.",
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
    {
      key: "general-assessment",
      title: "General assessment",
      objective:
        "Assess the most important claims across the whole graph, wherever " +
        "they are. This is Minerval's own standing mandate: its budget is " +
        "the money the platform allocates to expanding and maintaining the " +
        "graph, its allocator backs the highest expected value per dollar " +
        "of cost each day, and its allocation policy is the platform's " +
        "public formula, revised by this mandate's Grantmaker as the " +
        "evidence about allocation itself accumulates.",
      scopeQuery: null,
      strategy:
        "Back the candidates with the best expected value per dollar of " +
        "remaining cost, across the whole graph, until the day's rate is " +
        "committed. Co-fund partially backed claims rather than duplicate " +
        "other funders' allocations.",
      // The escrow is the only hard ceiling on this mandate's spend, since the
      // daily rate is a pace target rather than a cap. 200 owls is deliberately
      // a first-run number: roughly a week at the rate below, after which the
      // mandate halts until someone tops it up. Raise it once the live epoch
      // shows where the money actually goes.
      budgetOwls: 200,
      policy: "general",
      dailyBudgetOwls: 30,
      skills: [],
      allocationPolicy: null,
    },
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

const STANDING_NOTE =
  "A standing platform mandate. Its plan grows as the Grantmaker " +
  "surveys the scope; contributions extend how far it reaches.";

/** The mandate JSON the row carries: the public text of the mandate page. */
function mandateJson(m: PlatformMandate, notes: string): Record<string, unknown> {
  return {
    title: m.title,
    objective: m.objective,
    scope_claim_id: null,
    scope_query: m.scopeQuery,
    plan: { strategy: m.strategy, items: [] },
    expected_cost_owls: m.budgetOwls,
    notes,
    ...(m.sections ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  updateMandate: string | null;
  mandate: string | null;
  dailyOwls: number | null;
  topUpOwls: number | null;
  topUpBatch: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    updateMandate: null,
    mandate: null,
    dailyOwls: null,
    topUpOwls: null,
    topUpBatch: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
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
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  if (args.mandate === null) args.mandate = args.updateMandate;
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

async function createMandate(m: PlatformMandate, platformId: string): Promise<string> {
  const budgetMicro = owlsToMicroUsd(m.budgetOwls);
  const mandate = mandateJson(m, STANDING_NOTE);

  // One transaction per mandate: mint, job, hold, and grant land (or roll
  // back) together, so a crash mid-way can never leave an orphaned running
  // job whose hold's idempotency key pins the escrow to it.
  return withTransaction(async (tx) => {
    // Mint the platform's owls (idempotent), then escrow them.
    await tx.query(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
       VALUES ($1, $2, 'admin_adjust', $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [platformId, budgetMicro, `platform_mandate_mint:${m.key}`]
    );
    const [job] = await tx.query<{ id: string }>(
      `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status)
       VALUES ($1, 'grant', $2, 'running')
       RETURNING id`,
      [platformId, budgetMicro]
    );
    await tx.query(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id, idempotency_key)
       VALUES ($1, $2, 'escrow_hold', $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [platformId, -budgetMicro, job!.id, `platform_mandate_hold:${m.key}`]
    );

    // 'general' = the allocation engine's platform lane; 'cover' = the
    // coverage selector over a topical scope. Both standing mandates.
    const [grant] = await tx.query<{ id: string }>(
      `INSERT INTO grants
         (funder_user_id, budget_job_id, name, scope_query, policy, status,
          plan, mandate, is_platform, daily_budget_micro_usd, skills,
          allocation_policy)
       VALUES ($1, $2, $3, $4, $7, 'active', $5::jsonb, $6::jsonb, true, $8, $9,
               $10::jsonb)
       RETURNING id`,
      [
        platformId,
        job!.id,
        m.title,
        m.scopeQuery,
        JSON.stringify({ strategy: m.strategy, items: [] }),
        JSON.stringify(mandate),
        m.policy,
        owlsToMicroUsd(m.dailyBudgetOwls),
        m.skills,
        m.allocationPolicy ? JSON.stringify(m.allocationPolicy) : null,
      ]
    );
    return grant!.id;
  });
}

// ---------------------------------------------------------------------------
// Updating a live row (§10.9)
// ---------------------------------------------------------------------------

interface ExistingMandate {
  id: string;
  budget_job_id: string;
  mandate: Record<string, unknown> | null;
  plan: { strategy?: string; items?: unknown[] } | null;
}

async function findExisting(m: PlatformMandate): Promise<ExistingMandate> {
  const [existing] = await rawQuery<ExistingMandate>(
    `SELECT id, budget_job_id, mandate, plan FROM grants
      WHERE is_platform = true AND name = $1`,
    [m.title]
  );
  if (!existing) {
    throw new Error(`no platform mandate "${m.title}" exists to update; run the seed first`);
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
    };
    await tx.query(
      `UPDATE grants
          SET mandate = $2::jsonb,
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
      ]
    );
  });
  console.log(
    `~ ${m.title} updated (${existing.id}): text, skills [${m.skills.join(", ")}], ` +
      `policy keys ${m.allocationPolicy ? Object.keys(m.allocationPolicy).join(", ") : "(none)"}`
  );
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platformId = await ensurePlatformAccount();
  const all = mandates();

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
    const [existing] = await rawQuery<{ id: string }>(
      `SELECT id FROM grants
        WHERE is_platform = true AND name = $1`,
      [m.title]
    );
    if (existing) {
      console.log(`= ${m.title} already exists (${existing.id})`);
    } else {
      const grantId = await createMandate(m, platformId);
      console.log(`+ ${m.title} created (${grantId}), ${owls(m.budgetOwls)} owls`);
    }
  }
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
