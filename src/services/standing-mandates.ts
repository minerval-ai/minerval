/**
 * The standing mandates a deployment sets up for itself: General and
 * Governance (constitution §19; docs/allocation.md, "Platform mandates").
 *
 * General pays for the upkeep whose value is spread across the whole graph;
 * Governance pays for the audits of the graph's decisions and never an
 * audit of itself. Every deployment needs both, because no agent work runs
 * except by allocation, and the allocation engine finds each by what it is
 * (the General mandate by `is_platform` and policy 'general', the
 * Governance mandate by policy 'governance').
 *
 * Two paths create them, from the one definition here:
 *
 *  - On the public graph, scripts/seed-platform-mandates.ts, run with the
 *    database's credentials, with Minerval's money bought at cost.
 *  - In a members-only deployment, an administrator, through
 *    POST /standing-mandates/:key (routes/owls.ts), with no script and no
 *    operator key. Where the deployment creates its own owls the budget is
 *    created with the mandate, and the act is logged; where owls are sold
 *    the mandate starts with none and is funded from a balance like any
 *    mandate.
 *
 * The text is the same in both, except for the sentences that say whose
 * mandate it is and whose money is behind it. On the public graph that is
 * Minerval. Anywhere else it is the organization that runs the deployment,
 * and saying "Minerval" there would be false.
 *
 * What label these mandates work at is not decided here. The rows are
 * written with the columns' defaults; when mandates carry a label, it is
 * given where createStandingMandate inserts the budget job and the grant.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { owlsToMicroUsd } from "./owl.js";

/** Whose standing mandate the text speaks of: Minerval's on the public graph, the deployment's own elsewhere. */
export type StandingMandateOwner = "minerval" | "deployment";

const WHOSE: Record<StandingMandateOwner, { general: string; governed: string; audit: string; lane: string }> = {
  minerval: {
    general:
      "This is Minerval's own standing mandate: its " +
      "budget is the money the platform puts into the graph's upkeep,",
    governed: "Minerval's",
    audit: "Minerval's own standing mandate for audit",
    lane: "the platform lane",
  },
  deployment: {
    general:
      "This is the deployment's own standing mandate: its " +
      "budget is what the organization that runs it puts into the graph's upkeep,",
    governed: "this graph's",
    audit: "the deployment's own standing mandate for audit",
    lane: "the General mandate",
  },
};

export interface StandingMandate {
  key: string;
  title: string;
  /** Titles the row may still carry from before a rename, for finding it. */
  previousTitles?: string[];
  objective: string;
  scopeQuery: string | null;
  strategy: string;
  budgetOwls: number;
  policy: "general" | "governance" | "cover";
  dailyBudgetOwls: number;
  /** The mandate's domain skills (grants.skills); none for the General mandate. */
  skills: string[];
  /** Policy keys the mandate overlays on the shared defaults, if any. */
  allocationPolicy: Record<string, number> | null;
  /**
   * The operating policy its program officers start from, in prose
   * (operating-policy-service.ts). The Grantmaker revises it from then on;
   * the seed never overwrites one it has written.
   */
  operatingPolicy?: {
    mission?: string;
    priorities?: string;
    budgets?: string;
    petitions?: string;
    delegation?: string;
    officer_limit_owls?: number;
    officer_limit_reason?: string;
    review_pass_owls?: number;
    review_pass_reason?: string;
  };
  /** Lookouts it stands up at creation (lookout-service.ts, createLookout). */
  lookouts?: Array<{
    title: string;
    brief: string;
    heartbeatHours: number;
    triggers: string[];
    commissionLimitOwls: number;
  }>;
  /** The longer sections a mandate page carries beyond objective and strategy. */
  sections?: {
    scope?: string;
    prize_policy?: string;
    attempt_policy?: string;
    refusals?: string;
    disclosure?: string;
  };
}

/** The keys the two standing mandates are stored under (mandate.seed_key). */
export const GENERAL_MANDATE_KEY = "general-assessment";
export const GOVERNANCE_MANDATE_KEY = "governance";

/**
 * The General and Governance mandates, in that order, worded for whose
 * they are. The "minerval" wording is the public graph's, character for
 * character as the seed has always written it.
 */
export function standingMandates(owner: StandingMandateOwner): StandingMandate[] {
  const whose = WHOSE[owner];
  return [
    {
      key: "general-assessment",
      title: "General maintenance",
      previousTitles: ["General assessment"],
      objective:
        `Keep the graph sound. ${whose.general} and ` +
        "it buys the work whose value is spread across the whole graph and " +
        "which no topical funder would buy for its own region: consistency " +
        "sweeps, curation, audits, work someone is waiting on, and fresh " +
        "passes where something a published verdict rests on has changed. " +
        "It does not pay to extend coverage. First assessments are for the " +
        "mandates and readers who care about those claims, with one " +
        "exception: an unassessed premise that a published verdict already " +
        "rests on, which is a defect in what the graph already says.",
      scopeQuery: null,
      strategy:
        "Fund the upkeep first, every day: the consistency sweeps that are " +
        "due, every curation with a concrete concern, the audits that come " +
        "here, and the requests and messages someone is waiting on. Then " +
        "reassess where something changed under a verdict, and assess the " +
        "unassessed premises of published verdicts. Leave new coverage to " +
        "the mandates whose scope it is. Commission each piece of work " +
        "whole, at the high end of what the costing skill says it costs, " +
        "and let the agents doing it petition when it needs more.",
      operatingPolicy: {
        mission:
          "Keep the graph sound: coherent, free of duplicates and conflations, " +
          "honestly governed, and current where something under a verdict " +
          "has changed. This mandate pays for upkeep whose value is spread " +
          "across the whole graph, which no topical funder buys. It does not " +
          "pay to extend coverage: a first assessment of a new claim, however " +
          "important, is for a mandate whose scope it is or a reader who " +
          "wants it, unless a published verdict already rests on that claim.",
        priorities:
          "These are standing orders: fund each one whenever it appears and " +
          "the day has room, in this order.\n" +
          "1. Curation. Commission every curation whose concern names " +
          "something concrete: a duplicate or counterpart, a conflation of " +
          "two claims, a wrong kind, a broken or missing link, a split. A " +
          "Steward's escalation and a consistency sweep's request are concrete " +
          "by default. A reconcile candidate is worth it at similarity 0.95 " +
          "or more, or where either claim has dependents. Decline only a " +
          "curation whose concern names nothing, and say so in the reason.\n" +
          "2. Audits put before this mandate. They come here when the " +
          "Governance mandate is the audit's subject, or when no Governance " +
          "mandate is active. Fund them all; decline only one that duplicates " +
          "an audit open or finished in the last week, and name it.\n" +
          "3. Consistency flags. The pass a flag asks for, when its expected " +
          "gain is 0.3 or more, or the primary has dependents or importance " +
          "0.5 or more.\n" +
          "4. Waiting work: a request the graph's own agents can meet, and a " +
          "message on a node that no pass has read in more than a day.\n" +
          "5. Reassessment driven by change: a premise changed status, a " +
          "source was retracted, a contribution was accepted. Age alone is " +
          "not a reason this mandate pays for.\n" +
          "6. An unassessed premise that a published verdict rests on, where " +
          "the parent's importance is 0.35 or more.\n" +
          "Decline, with the reason, a first assessment of a node no " +
          "published verdict rests on: say it is for a topical mandate or a " +
          "reader. Do not back a row someone already commissioned, and never " +
          "both variants of one row. Consistency sweeps are not yours to " +
          "decide: the mandate funds the due ones itself from the day, as it " +
          "funds its own review passes.",
        budgets:
          "Set each budget at the high end of the costing skill's range; what " +
          "a run does not spend comes back.\n" +
          "- Curate: 0.5 owls. Audit: 0.75. A request: its quote, or the " +
          "scoping pass's price where it has none.\n" +
          "- Assess or reassess, standard: 1.0. Strong: 4.0, only where a " +
          "consistency flag or a failed standard pass says the standard tier " +
          "will not settle it. A strong pass funded below 4.0 cannot read its " +
          "sources whole.\n" +
          "- Upkeep (priorities 1 to 4) has first claim on the day's rate. " +
          "Passes under priorities 5 and 6 together take at most half of it, " +
          "so curation, audits and flags that arrive late in the day still " +
          "find room; when nothing under 1 to 4 is waiting, they may take " +
          "what is left.",
        petitions:
          "Answer on money only, never on what the run should conclude. Grant " +
          "a petition when the agent names what the extra buys and the work " +
          "falls under the mission; up to double the original budget. A " +
          "Curator or Audit Agent that names the claims or decisions it still " +
          "has to read has given a sufficient reason. Grant a follow-up rather " +
          "than more budget when the remaining work is a different job. " +
          "Refuse requests for breadth on nodes of importance below 0.35, and " +
          "say the run should conclude on what it has.",
        delegation:
          "Officers decide up to their limit. Send the Grantmaker anything " +
          "larger, anything that would commit more than a third of today's " +
          "rate at once, proof attempts and bounties, regrants, any item " +
          "whose brief asks for a particular result, and anything this " +
          "policy does not settle.",
        officer_limit_owls: 5,
        officer_limit_reason:
          "Five owls covers a strong pass and many times an ordinary curation " +
          "or audit; larger commitments are rare enough to deserve the " +
          "Grantmaker's judgment.",
      },
      lookouts: [
        {
          title: "Known problems",
          brief:
            "Follow the whole graph's change stream for upkeep that needs doing: " +
            "a premise a published verdict rests on changed status, a source " +
            "was retracted, a consistency flag was raised, a curation or " +
            "request was filed, a message arrived on a node and is waiting, a " +
            "run finished and named work it could not do. Commission a fresh " +
            "pass where the change plausibly alters a verdict that matters; " +
            "raise to the officers what is larger than your limit or unclear. " +
            "New claims needing a first assessment are not this mandate's " +
            "unless a published verdict rests on them. Leave alone changes that " +
            "already have work commissioned or running.",
          heartbeatHours: 24,
          triggers: ["graph"],
          commissionLimitOwls: 3,
        },
        {
          title: "Upkeep",
          brief:
            "Once a day, query the graph (query_sql) for upkeep nobody has " +
            "paid for: curate and audit rows open on the ledger, oldest first; " +
            "consistency flags whose pass has not run; requests with no work " +
            "commissioned; messages on nodes unread for more than a day; and " +
            "unassessed claims that a published verdict rests on. Commission " +
            "the clear cases within your limit and raise the rest to the " +
            "officers with a suggested budget and why. Do not commission work " +
            "that has a commission or is running, and do not commission a pass " +
            "for age alone.",
          heartbeatHours: 24,
          triggers: [],
          commissionLimitOwls: 3,
        },
      ],
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
    {
      key: "governance",
      title: "Governance",
      objective:
        `Pay for the audits that keep ${whose.governed} governance honest: the ` +
        "Audit Agent's reviews of contribution decisions, arbitration " +
        "overturns, bad-faith flags, suspensions, anomalies the monitors " +
        "raise, and the periodic sweeps over recent decisions. This is " +
        `${whose.audit}, kept apart from the ` +
        "General mandate so that audits never compete with other upkeep " +
        `for the same day's budget, and so that ${whose.lane}` +
        ", whose allocation judgments are themselves audited, is never " +
        "the party deciding whether an audit of it runs.",
      scopeQuery: null,
      strategy:
        "Fund the audits the system raises, in order of what prompted them " +
        "(prize and bad-faith audits first, periodic sweeps last), and let " +
        "an audit that has waited rise. Never fund an audit of this mandate " +
        "itself: those are the General mandate's. An audit this mandate " +
        "declines stays open on the ledger, with its age, for anyone to see.",
      operatingPolicy: {
        mission:
          "Keep the graph's governance honest by paying for the audits of its " +
          "decisions. Audit buys scrutiny, never a conclusion.",
        priorities:
          "Prize acceptances and bad-faith flags first: real money or a " +
          "contributor's standing turns on them. Then arbitration overturns " +
          "and suspensions, then anomalies the monitors raised, then periodic " +
          "sweeps. An audit that has waited more than a week moves up a rank. " +
          "Decline an audit only when an equivalent one is open or recently " +
          "finished, and say which.",
        budgets:
          "Set each audit's budget at the high end of what the costing skill " +
          "says such an audit costs; a prize audit the bounty's reserve only " +
          "partly covers needs the rest.",
        petitions:
          "Grant the Audit Agent more when its plan names the decisions it " +
          "still has to read and why they bear on the finding.",
        delegation:
          "Officers decide up to their limit; send the Grantmaker anything " +
          "touching this mandate's own conduct, and anything larger.",
        officer_limit_owls: 3,
        officer_limit_reason: "Three owls covers an ordinary audit; larger ones are rare.",
      },
      // A first-run number, like General's: audits have never been metered
      // (they ran unattributed before #363), so the first week of ledger
      // runs is what sizes this. Five owls a day covers several times the
      // audit volume the dedupe keys allow on an ordinary day.
      budgetOwls: 50,
      policy: "governance",
      dailyBudgetOwls: 5,
      skills: [],
      allocationPolicy: null,
    },
  ];
}

/** The note a standing mandate's page carries, by whose mandate it is. */
export const STANDING_NOTES: Record<StandingMandateOwner, string> = {
  minerval:
    "A standing platform mandate. Its plan grows as the Grantmaker " +
    "surveys the scope; contributions extend how far it reaches.",
  deployment:
    "A standing mandate of this deployment, set up by its administrators. Its plan grows " +
    "as the Grantmaker surveys the scope; contributions extend how far it reaches.",
};

/** The mandate JSON the row carries: the public text of the mandate page. */
export function mandateJson(m: StandingMandate, notes: string): Record<string, unknown> {
  return {
    title: m.title,
    objective: m.objective,
    scope_claim_id: null,
    scope_query: m.scopeQuery,
    seed_key: m.key,
    plan: { strategy: m.strategy, items: [] },
    expected_cost_owls: m.budgetOwls,
    notes,
    ...(m.sections ?? {}),
    ...(m.operatingPolicy ? { operating_policy: m.operatingPolicy } : {}),
  };
}

/** Stand up the seeded lookouts a mandate does not already have (by title). */
export async function ensureLookouts(
  m: StandingMandate,
  grantId: string,
  log: (line: string) => void = () => {}
): Promise<void> {
  if (!m.lookouts?.length) return;
  const { createLookout } = await import("./lookout-service.js");
  for (const l of m.lookouts) {
    const [existing] = await rawQuery<{ id: string }>(
      `SELECT id FROM lookouts WHERE grant_id = $1 AND title = $2`,
      [grantId, l.title]
    );
    if (existing) continue;
    const r = await createLookout({
      grantId,
      title: l.title,
      brief: l.brief,
      heartbeatHours: l.heartbeatHours,
      triggers: l.triggers,
      commissionLimitOwls: l.commissionLimitOwls,
      createdBy: "platform",
    });
    log(r.ok ? `  + lookout "${l.title}"` : `  ! lookout "${l.title}": ${r.message}`);
  }
}

/**
 * Create one standing mandate, with its budget escrowed, in one
 * transaction: the owls entering the funder's balance, the budget job, the
 * hold, and the grant land (or roll back) together, so a crash mid-way can
 * never leave an orphaned running job whose hold's idempotency key pins the
 * escrow to it.
 *
 * `funderId` is the account the mandate is funded from: the platform's on
 * the public graph, the deployment's own elsewhere. `budgetReason` is the
 * ledger reason the budget enters that account under: 'admin_adjust' for
 * the seed, 'owl_created' for owls a deployment's administrator creates.
 * With a budget of zero nothing enters the ledger and the job waits for a
 * budget, as a mandate does whose money has run out.
 *
 * `ledgerKey` makes the two ledger rows idempotent, as the seed needs: it
 * may be run again after a crash, and must never buy a budget twice. The
 * route leaves it out. Its guard is the lock and the check it makes first
 * in the transaction, and a deployment that closed a standing mandate and
 * sets up another must get a second budget, which a fixed key would refuse.
 *
 * `firstInTransaction` runs inside the same transaction before anything is
 * written, and stops the creation by throwing: the route uses it to take a
 * lock and check that the mandate does not already exist. `alsoInTransaction`
 * runs once the grant exists: the route uses it to write its log entry with
 * the change.
 */
export async function createStandingMandate(input: {
  mandate: StandingMandate;
  funderId: string;
  budgetReason: "admin_adjust" | "owl_created";
  ledgerKey?: string;
  note: string;
  firstInTransaction?: (tx: TxQuery) => Promise<void>;
  alsoInTransaction?: (tx: TxQuery, grantId: string) => Promise<void>;
}): Promise<string> {
  const m = input.mandate;
  const budgetMicro = owlsToMicroUsd(m.budgetOwls);
  const mandate = mandateJson(m, input.note);
  // The mandate and its budget job carry the label of the request that sets
  // the mandate up, which an administrator names (server/request-labels.ts),
  // or `public` for the seed script. A mandate's work runs at its label
  // (src/labels.ts), so this is the label its upkeep or its audits are of.
  const label = currentLabel();

  return withTransaction(async (tx) => {
    await input.firstInTransaction?.(tx);
    if (budgetMicro > 0) {
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.funderId,
          budgetMicro,
          input.budgetReason,
          input.ledgerKey ? `platform_mandate_mint:${input.ledgerKey}` : null,
        ]
      );
    }
    const [job] = await tx.query<{ id: string }>(
      `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status, sensitivity_label)
       VALUES ($1, 'grant', $2, $3, $4)
       RETURNING id`,
      [input.funderId, budgetMicro, budgetMicro > 0 ? "running" : "paused_budget", label]
    );
    if (budgetMicro > 0) {
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id, idempotency_key)
         VALUES ($1, $2, 'escrow_hold', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.funderId,
          -budgetMicro,
          job!.id,
          input.ledgerKey ? `platform_mandate_hold:${input.ledgerKey}` : null,
        ]
      );
    }

    // 'general' = the allocation engine's platform lane; 'governance' = the
    // formula mandate that funds audits (#363); 'cover' = the coverage
    // selector over a topical scope. All standing mandates.
    const [grant] = await tx.query<{ id: string }>(
      `INSERT INTO grants
         (funder_user_id, budget_job_id, name, scope_query, policy, status,
          plan, mandate, is_platform, daily_budget_micro_usd, skills,
          allocation_policy, sensitivity_label)
       VALUES ($1, $2, $3, $4, $7, 'active', $5::jsonb, $6::jsonb, true, $8, $9,
               $10::jsonb, $11)
       RETURNING id`,
      [
        input.funderId,
        job!.id,
        m.title,
        m.scopeQuery,
        JSON.stringify({ strategy: m.strategy, items: [] }),
        JSON.stringify(mandate),
        m.policy,
        owlsToMicroUsd(m.dailyBudgetOwls),
        m.skills,
        m.allocationPolicy ? JSON.stringify(m.allocationPolicy) : null,
        label,
      ]
    );
    await input.alsoInTransaction?.(tx, grant!.id);
    return grant!.id;
  });
}
