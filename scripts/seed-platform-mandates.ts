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
import { loadConfig } from "../src/config.js";
import { owlsToMicroUsd } from "../src/services/owl.js";

interface PlatformMandate {
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
    {
      key: "general-assessment",
      title: "General maintenance",
      previousTitles: ["General assessment"],
      objective:
        "Keep the graph sound. This is Minerval's own standing mandate: its " +
        "budget is the money the platform puts into the graph's upkeep, and " +
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
        "Pay for the audits that keep Minerval's governance honest: the " +
        "Audit Agent's reviews of contribution decisions, arbitration " +
        "overturns, bad-faith flags, suspensions, anomalies the monitors " +
        "raise, and the periodic sweeps over recent decisions. This is " +
        "Minerval's own standing mandate for audit, kept apart from the " +
        "General mandate so that audits never compete with other upkeep " +
        "for the same day's budget, and so that the platform " +
        "lane, whose allocation judgments are themselves audited, is never " +
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
    seed_key: m.key,
    plan: { strategy: m.strategy, items: [] },
    expected_cost_owls: m.budgetOwls,
    notes,
    ...(m.sections ?? {}),
    ...(m.operatingPolicy ? { operating_policy: m.operatingPolicy } : {}),
  };
}

/** Stand up the seeded lookouts a mandate does not already have (by title). */
async function ensureLookouts(m: PlatformMandate, grantId: string): Promise<void> {
  if (!m.lookouts?.length) return;
  const { createLookout } = await import("../src/services/lookout-service.js");
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
    console.log(r.ok ? `  + lookout "${l.title}"` : `  ! lookout "${l.title}": ${r.message}`);
  }
}

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

    // 'general' = the allocation engine's platform lane; 'governance' = the
    // formula mandate that funds audits (#363); 'cover' = the coverage
    // selector over a topical scope. All standing mandates.
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
