/**
 * Grants — grantmaker mandates over the budget-job escrow machinery.
 *
 * A grant is an escrowed owl budget (budget_jobs, kind 'grant') + a mandate:
 * WHERE to spend attention (a claim's subtree and/or a topic query), HOW
 * (policy: deepen | cover | maintain | agent), and WHO to credit (the public
 * mandate name stamped on funded assessments via funded_by_job_id).
 *
 * Zero ceremony for small funders: pick a claim, a policy, and a budget —
 * three inputs — and the ledger does the rest. Large funders use the
 * 'agent' policy: a grantor agent surveys the scope, proposes an allocation
 * plan, and NOTHING runs until the funder approves it. The approved plan's
 * items run as commissions from the mandate (standing-order-service.ts).
 *
 * Money buys position and coverage, never epistemic standing: grant runs
 * are ordinary Steward runs under the same constitution, their funding is
 * disclosed on the assessments they produce, and grant stakes feed queue
 * priority only (§19, "Allocating Attention and Paid Attention").
 */
import { desc, eq } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { budgetJobs, grants, type Grant } from "../db/schema.js";
import { owlsToMicroUsd, microUsdToOwls } from "./owl.js";
import { withOwlBalanceLock } from "./owl-ledger-service.js";
import type { PlanItemLedger } from "./action-service.js";
import { NODE_KINDS, type NodeKind } from "../schemas/kinds.js";
import { refundUnspentBudget } from "./budget-job-service.js";
import { grantEscrowBreakdown } from "./regrant-service.js";
import { mergedAliasRefusal } from "./claim-alias-service.js";
import { currentLabel } from "../llm/usage-context.js";
import { actionUnavailable } from "../llm/tools/feature-tools.js";
import type { FeaturesConfig } from "../features.js";

export const GRANT_POLICIES = ["deepen", "cover", "maintain", "agent"] as const;

/** The longest wording a proposal carries, at every door (contribution-service.ts). */
export const PROPOSAL_TEXT_MAX_CHARS = 2000;

/** A propose item's ref: a short label, the same shape as a slug. */
const REF_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * A propose item's rationale is filed as the contribution's content, which
 * the Reviewer's door holds to this length (submitGrantContribution).
 */
const PROPOSAL_RATIONALE_MIN_CHARS = 40;
export type GrantPolicy = (typeof GRANT_POLICIES)[number];

export interface PlanItem {
  /**
   * assess        — one Steward pass on a node (first assessment). Any
   *                 kind: a claim's verdict, a quantity's estimate, a
   *                 question's standing. A standing order: the mandate
   *                 commissions the pass whole (standing-order-service.ts),
   *                 at `budget_owls` or the row's estimate, on `variant`
   *                 (stored as standard when its author names none).
   * reassess      — a fresh pass on an already-assessed node; a standing
   *                 order like assess.
   * deepen        — a pass on the node, and its direct deferred children
   *                 released into the queue (a question's subquestions,
   *                 answers, and presuppositions included) with a first
   *                 assessment commissioned on each direct child that has
   *                 none and is queued; one level.
   * ingest        — extract + match one source URL into the graph, metered
   *                 to the grant's escrow (the ingestion-pipeline primitive).
   * formalize     — write and publish the claim's formal statement
   *                 (docs/mathematics.md §5.4): two Steward passes, the
   *                 second in a fresh context.
   * attempt_proof — a solver attempt on the claim's published statement
   *                 (§7.2), `variant` standard or max; `is_calibration`
   *                 marks a run on a settled problem (§7.5), and
   *                 `lifetime_cap_owls` lets the Grantmaker raise this one
   *                 claim's lifetime attempt spend above the policy key,
   *                 bounded at twice it (§7.3).
   * sweep         — one Consistency Checker sweep of a partition of the
   *                 graph (#330, #831): `partition` is a topic tag's slug,
   *                 or "residual" for the claims no sweepable tag covers;
   *                 `variant` standard or strong, or absent for the
   *                 marginal-return rule the General mandate's own sweeps
   *                 follow. Funded from the mandate's escrow and day like
   *                 an ingest item; consumed by the first sweep of the
   *                 partition that finishes after the item opened its row.
   * propose       — a claim, quantity or question the graph does not hold
   *                 (#656): `kind` and `text`, filed once the mandate is
   *                 live as a contribution through the Contribution Reviewer
   *                 (§19), its review paid from the escrow. The Matcher
   *                 settles its kind and wording, or lands it on a node the
   *                 graph already holds. `ref` names it so other items
   *                 (`claim_ref`) and the mandate's scope (`scope_ref`) can
   *                 bind to the node it becomes.
   */
  action:
    | "propose"
    | "assess"
    | "reassess"
    | "deepen"
    | "ingest"
    | "formalize"
    | "attempt_proof"
    | "sweep";
  claim_id?: string;
  /**
   * In place of claim_id on a claim item: the `ref` of a propose item in
   * the same plan. The materializer writes claim_id once the proposal is a
   * node, and the item is then an ordinary one.
   */
  claim_ref?: string;
  /** propose only: a label for the proposal, unique in the plan. */
  ref?: string;
  /** propose only: the kind proposed; the Matcher settles the node's kind. */
  kind?: NodeKind;
  /** propose only: the wording proposed. */
  text?: string;
  /** propose only, written by the materializer: the contribution it filed. */
  contribution_id?: string;
  url?: string;
  /** sweep only: a topic tag's slug, or "residual". */
  partition?: string;
  rationale: string;
  /**
   * ingest only: read the document for this subject, in the mandate's
   * words, and extract only the claims bearing on it (a scoped ingest;
   * ingest-focus-service.ts). Absent = the whole document.
   */
  focus?: string;
  /**
   * attempt_proof: standard or max; sweep: standard or strong;
   * assess/reassess/deepen: the Steward's tier, standard or strong. Every
   * such item is stored with one (normalizePlanItems; standard when its
   * author names none). An item stored before that rule carries none and
   * commissions nothing until its Grantmaker names one (#956).
   */
  variant?: "standard" | "max" | "strong";
  /**
   * assess/reassess/deepen: the budget of each pass the item commissions,
   * in owls. Absent = the row's estimate for the tier.
   */
  budget_owls?: number;
  is_calibration?: boolean;
  lifetime_cap_owls?: number;
  /**
   * assess/reassess/deepen: set when the Grantmaker withdrew the item
   * (amend_plan_items); it orders nothing more.
   */
  withdrawn?: { at: string; note?: string };
  /** assess/reassess/deepen: the last change of tier or budget (amend_plan_items). */
  amended?: { at: string; note?: string };
  /**
   * The item's standing on the ledger, written by the plan-to-ledger
   * materializer (action-service.ts) on every sweep and on extend_plan:
   * the row it became, or why it could not (#416). Absent until the first
   * materialization.
   */
  ledger?: PlanItemLedger;
}

/**
 * What each plan kind needs before it becomes ledger work, in the words
 * the Grantmaker tools show. One text, so every agent reads the same rules
 * (#416: a plan item that quietly never became work is the failure this
 * exists to prevent).
 */
export const PLAN_KIND_RULES =
  "What each kind needs to become a priced ledger row (the tool result " +
  "and grant_overview report each item's standing as open, running, " +
  "done, cancelled, waiting, or blocked, with the reason): " +
  "propose: a claim, quantity or question the graph does not hold in any " +
  "wording (search first): kind, text (the wording, neutral; a quantity's " +
  "says what is measured, in which population and unit) and a rationale " +
  "saying why the graph needs the node, in at least " +
  `${PROPOSAL_RATIONALE_MIN_CHARS} characters, since it is filed with the ` +
  "proposal as the mandate's public record. Nothing is filed until the mandate is live; " +
  "then it goes to the Contribution Reviewer as a contribution like " +
  "anyone's, shown as from a funded mandate, and its review is paid from " +
  "your escrow (cost_sheet: contribution_review_usd), so price it in. The " +
  "item waits while the review is pending, and is done when the proposal " +
  "is accepted: the Matcher settles the node's kind and canonical wording, " +
  "or lands it on a node the graph already holds under other words, and " +
  "the result names the node either way. A rejected proposal reads " +
  "blocked with the Reviewer's reasons; reword it in a new item or drop " +
  "what depended on it. Give the item a ref and other items may name it " +
  "as claim_ref in place of claim_id (and the mandate as scope_ref): they " +
  "wait for the review, take the node's id when it is accepted, and are " +
  "priced and run like any other item from then on. " +
  "assess/reassess/deepen: an active node of any kind (claim, quantity, " +
  "or question; claim_id is the node's id, or claim_ref a proposal's ref). The item is a standing " +
  "order for one Steward pass: your mandate commissions it whole, like a " +
  "commission you make yourself, at budget_owls or, naming none, the " +
  "pass's current estimate on its tier (cost_sheet), on the variant you " +
  "name, standard or strong. Name it: an item that names none is stored " +
  "and commissioned as standard, and strong, which costs several times as " +
  "much, is bought only where you ask for it. " +
  "The budget is held against your mandate's pace and escrow while the pass " +
  "waits and runs, and what it does not spend comes back. Unlike " +
  "`commission`, which is placed now or refused, an order waits for " +
  "room: one the pace's window or your reserve leaves no room for reads " +
  "waiting, with its tier and the figures, and is placed by the first look " +
  "that finds room for it whole. Each look goes through the plan in order " +
  "and places every order the room covers: earlier items have first claim " +
  "on the pace's room, and an order that does not fit never holds the ones " +
  "after it. So a large order can be passed over while smaller ones after " +
  "it take the room, until room returns, you lower your reserve, give it a " +
  "smaller budget, or withdraw what is taking the room. One the " +
  "escrow cannot cover beside the budgets running work holds waits the " +
  "same way. One that could never fit, a budget above a steady pace's whole " +
  "window or above what the escrow could cover with every running budget " +
  "returned, reads blocked with the figures until you change the budget " +
  "or the variant, or the escrow is topped up. An item's work has " +
  "started once its pass is running; until then, whether it is waiting, " +
  "blocked, or commissioned and waiting its turn, and wherever it sits in " +
  "the plan, you can change its variant or budget_owls or withdraw it " +
  "(amend_plan_items, by the index the tool result and grant_overview " +
  "give), and a budget it already holds comes straight back. A pass that " +
  "is running or has run stays as it is. A node that " +
  "already has a pass paid for, by anyone, is not paid for twice: the " +
  "item is met when that pass finishes. Once per item: a finished pass " +
  "stays finished, whoever paid for it; add another item for another " +
  "pass. The pass records the kind's assessment: a " +
  "claim's verdict, a quantity's estimate, a question's standing and best " +
  "answer. assess on a node that already carries one reads done: reassess " +
  "is the ask for a fresh pass. deepen also releases the node's deferred " +
  "children into the queue (a claim's subclaims, a question's " +
  "subquestions, candidate answers and presuppositions) and orders a " +
  "first assessment for each direct child that carries no assessment and " +
  "is queued for a pass, at the same budget and variant, under the same " +
  "pace and escrow, including such children the node's own pass mints. A " +
  "child that already carries an assessment is never ordered a fresh pass " +
  "by a deepen item, however it came to be queued: that is a reassess " +
  "item on the child. The item's standing names the children it ordered " +
  "(children) and those it could not commission yet (children_waiting). " +
  "So price a deepen item as the node's pass plus one per unassessed " +
  "child. It goes one level. If the Steward parks a node after repeated " +
  "failures, the item reads cancelled and its budget is back in your escrow. " +
  "ingest: an http(s) url; executes in plan order from your escrow. An " +
  "optional focus scopes it: the extractor reads the whole document but " +
  "proposes only the claims bearing on the focus (premises those claims " +
  "rest on come in later, through their Stewards' decompositions). Use it " +
  "when the mandate wants one subject from documents that range wider; the " +
  "same URL can be ingested again later for another focus, or whole. " +
  "formalize and attempt_proof: mathematical claims; the mathematics " +
  "skill says when each becomes work. " +
  "sweep: a partition, the slug of a topic tag carrying enough live " +
  "claims to be swept on its own, or \"residual\" for the claims no such " +
  "tag covers; the item opens (or keeps) the partition's two sweep rows " +
  "(standard and strong readers, priced by the partition's assessed " +
  "nodes) and funds one from your escrow within the pace: the variant you " +
  "name, or without one the same marginal-return rule the platform's own " +
  "sweeps follow. The item is done when a sweep of the partition finishes " +
  "after it opened, whoever funded it; add another item for a re-sweep. A " +
  "sweep raises flags, and the passes the flags ask for are separate " +
  "rows, valued and funded like any other. Blocked when the deployment " +
  "runs no sweeps, or when the tag is too small to be its own partition.";

/**
 * The JSON schema of one plan item, as the Grantmaker's tools show it
 * (propose_mandate, adjust_plan, extend_plan, submit_plan). One schema, so
 * every mode of the mandate's agent proposes the same shape. PLAN_KIND_RULES
 * is not in it: each tool carries those rules once, on its own description
 * or its items array (#692).
 */
export const PLAN_ITEM_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "propose",
        "assess",
        "reassess",
        "deepen",
        "ingest",
        "formalize",
        "attempt_proof",
        "sweep",
      ],
    },
    claim_id: {
      type: "string",
      description:
        "Required for every kind but propose, ingest and sweep, unless claim_ref is given: " +
        "the node's id, as a tool result gave it.",
    },
    claim_ref: {
      type: "string",
      description:
        "In place of claim_id, for a node the graph does not hold yet: the ref of a propose item in this plan.",
    },
    ref: {
      type: "string",
      description:
        "propose only, optional: a short label for the proposal (lowercase letters, digits, hyphens; " +
        "at most 40 characters), unique in the plan, for claim_ref and scope_ref to name.",
    },
    kind: {
      type: "string",
      enum: [...NODE_KINDS],
      description: "Required for propose: the kind you propose. The Matcher settles the node's kind.",
    },
    text: {
      type: "string",
      maxLength: PROPOSAL_TEXT_MAX_CHARS,
      description: "Required for propose: the wording you propose, neutral, presupposing no more than it must.",
    },
    partition: {
      type: "string",
      description:
        "Required for sweep: the topic tag's slug, as graph reads return " +
        "it, or \"residual\".",
    },
    url: {
      type: "string",
      description: "Required for ingest; the source URL to extract and match.",
    },
    focus: {
      type: "string",
      description:
        "ingest only, optional: the subject to read the document for, in " +
        "your words (e.g. \"the author's claims about grid reliability and " +
        "electricity prices\"). Omit to extract the whole document.",
    },
    rationale: { type: "string" },
    variant: {
      type: "string",
      enum: ["standard", "max", "strong"],
      description:
        "attempt_proof: the solver's effort variant, standard or max. " +
        "sweep, optional: the reader, standard or strong; omit for the " +
        "marginal-return rule. assess, reassess, deepen: the Steward's " +
        "model, standard or strong; an item that names none is stored and " +
        "commissioned as standard.",
    },
    budget_owls: {
      type: "number",
      description:
        "assess, reassess, deepen, optional: the budget of each pass the " +
        "item commissions, in owls, held against your mandate's pace and " +
        "escrow until the pass settles. Omit for the pass's current " +
        "estimate on its variant (cost_sheet). A deepen item's budget is " +
        "per pass: the node's, and each child's it orders.",
    },
    is_calibration: {
      type: "boolean",
      description:
        "attempt_proof only: a calibration run on a settled problem.",
    },
    lifetime_cap_owls: {
      type: "number",
      description:
        "attempt_proof only: raise this claim's lifetime attempt spend " +
        "above the policy key (bounded at twice it).",
    },
  },
  required: ["action", "rationale"],
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PLAN_ACTIONS = new Set<PlanItem["action"]>([
  "propose",
  "assess",
  "reassess",
  "deepen",
  "ingest",
  "formalize",
  "attempt_proof",
  "sweep",
]);

/** A sweep item's partition: a tag slug's shape, or the residual bucket. */
const PARTITION_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The mechanical check every plan goes through before it is recorded: a
 * known action, an http(s) url for an ingest, a claim id for everything
 * else. Returns the problem in the agent's words, or null when the items
 * are well-formed. Whether the ids are REAL is the ledger's business (a
 * missing claim blocks the item there, with the reason). A claim_ref must
 * name a propose item among `items` or in `knownRefs`, the refs of the plan
 * these items are joining (extend_plan, adjust_plan).
 *
 * An item whose kind belongs to a feature this deployment has switched off
 * (llm/tools/feature-tools.ts, ACTION_FEATURES) is refused here, with the
 * reason: nothing could carry the work out, and a plan that held it would
 * open a row that spends on a pass that cannot proceed. `config` is the
 * deployment's unless a test passes one.
 */
export function validatePlanItems(
  items: readonly PlanItem[],
  knownRefs: readonly string[] = [],
  config?: FeaturesConfig
): string | null {
  const refs = new Set(knownRefs);
  for (const item of items) {
    if (!item || typeof item !== "object" || item.action !== "propose" || item.ref == null) continue;
    if (typeof item.ref !== "string" || !REF_RE.test(item.ref)) {
      return `a propose item's ref is a label of at most 40 lowercase letters, digits and hyphens (got: ${String(item.ref)})`;
    }
    if (refs.has(item.ref)) return `the ref "${item.ref}" is already used by another propose item in this plan`;
    refs.add(item.ref);
  }
  for (const item of items) {
    if (!item || typeof item !== "object") return "each plan item must be an object";
    if (!PLAN_ACTIONS.has(item.action)) {
      return `unknown plan action "${String(item.action)}" (one of ${[...PLAN_ACTIONS].join(", ")})`;
    }
    const unavailable = actionUnavailable(item.action, config);
    if (unavailable) return `${unavailable}. Leave it out of the plan.`;
    if (typeof item.rationale !== "string" || !item.rationale.trim()) {
      return `${item.action} item needs a rationale`;
    }
    if (item.action === "propose") {
      if (!(NODE_KINDS as readonly unknown[]).includes(item.kind)) {
        return `propose item needs a kind: ${NODE_KINDS.join(", ")} (got: ${String(item.kind ?? "none")})`;
      }
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!text) return "propose item needs text: the wording you propose";
      if (text.length > PROPOSAL_TEXT_MAX_CHARS) {
        return `a propose item's text is over ${PROPOSAL_TEXT_MAX_CHARS} characters: a claim, question or quantity, not an essay`;
      }
      if (item.rationale.trim().length < PROPOSAL_RATIONALE_MIN_CHARS) {
        return (
          `a propose item's rationale is filed with the proposal as its public record: say why the ` +
          `graph needs the node, in at least ${PROPOSAL_RATIONALE_MIN_CHARS} characters`
        );
      }
    } else if (item.action === "ingest") {
      if (!item.url || !/^https?:\/\//.test(item.url)) {
        return `ingest item needs an http(s) url (got: ${item.url ?? "none"})`;
      }
      if (item.focus !== undefined && item.focus !== null && typeof item.focus !== "string") {
        return "an ingest item's focus must be text";
      }
    } else if (item.action === "sweep") {
      const partition = typeof item.partition === "string" ? item.partition.trim().toLowerCase() : "";
      if (!partition || !PARTITION_RE.test(partition)) {
        return (
          `sweep item needs a partition: a topic tag's slug or "residual" ` +
          `(got: ${item.partition ?? "none"})`
        );
      }
      if (item.variant !== undefined && item.variant !== null && item.variant !== "standard" && item.variant !== "strong") {
        return `a sweep item's variant is standard or strong (got: ${String(item.variant)})`;
      }
    }
    if (item.action === "assess" || item.action === "reassess" || item.action === "deepen") {
      if (item.variant !== undefined && item.variant !== null && item.variant !== "standard" && item.variant !== "strong") {
        return `${item.action === "assess" ? "an" : "a"} ${item.action} item's variant is standard or strong (got: ${String(item.variant)})`;
      }
      if (
        item.budget_owls !== undefined && item.budget_owls !== null &&
        !(typeof item.budget_owls === "number" && Number.isFinite(item.budget_owls) && item.budget_owls > 0)
      ) {
        return `${item.action === "assess" ? "an" : "a"} ${item.action} item's budget_owls is a number of owls above zero (got: ${String(item.budget_owls)}); omit it for the pass's estimate`;
      }
    }
    if (item.action === "propose" || item.action === "ingest" || item.action === "sweep") {
      // Checked above.
    } else if (item.claim_ref && !item.claim_id) {
      if (!refs.has(item.claim_ref)) {
        return `${item.action} item's claim_ref "${String(item.claim_ref)}" names no propose item in this plan`;
      }
      if (item.action === "attempt_proof" && item.variant === "strong") {
        return "an attempt_proof item's variant is standard or max";
      }
    } else if (!item.claim_id || !UUID_RE.test(item.claim_id)) {
      return (
        `${item.action} item needs a claim_id from your survey results, or the claim_ref of a ` +
        `propose item for a node the graph does not hold yet`
      );
    } else if (item.action === "attempt_proof" && item.variant === "strong") {
      return "an attempt_proof item's variant is standard or max";
    }
  }
  return null;
}

/**
 * The stored form of validated plan items: every field PlanItem defines
 * and nothing else (#684). One function on every path that writes a plan
 * (submit_plan, extend_plan, adjust_plan), so a field the schema offers is
 * never dropped on one of them: an ingest's focus was, on two, and a scoped
 * ingest silently became a whole-document one. A blank focus is no focus.
 */
export function normalizePlanItems(items: readonly PlanItem[]): PlanItem[] {
  return items.map((it) => {
    const focus = it.action === "ingest" && typeof it.focus === "string" ? it.focus.trim() : "";
    const partition =
      it.action === "sweep" && typeof it.partition === "string" ? it.partition.trim().toLowerCase() : "";
    const propose = it.action === "propose";
    return {
      action: it.action,
      rationale: String(it.rationale ?? ""),
      // A propose item's claim_id and contribution_id are the materializer's
      // to write, never the plan's author's.
      ...(it.claim_id && !propose ? { claim_id: it.claim_id } : {}),
      ...(it.claim_ref && !it.claim_id && !propose ? { claim_ref: it.claim_ref } : {}),
      ...(propose ? { kind: it.kind, text: String(it.text).trim(), ...(it.ref ? { ref: it.ref } : {}) } : {}),
      ...(it.url ? { url: it.url } : {}),
      ...(focus ? { focus } : {}),
      ...(partition ? { partition } : {}),
      // A stewarding item always says its tier (#956): standard when its
      // author names none, written here so nothing later has to guess.
      ...(["assess", "reassess", "deepen"].includes(it.action)
        ? { variant: it.variant === "strong" ? "strong" : "standard" }
        : it.variant
          ? { variant: it.variant }
          : {}),
      ...(["assess", "reassess", "deepen"].includes(it.action) && Number(it.budget_owls) > 0
        ? { budget_owls: Number(it.budget_owls) }
        : {}),
      ...(it.is_calibration !== undefined ? { is_calibration: !!it.is_calibration } : {}),
      ...(it.lifetime_cap_owls !== undefined ? { lifetime_cap_owls: Number(it.lifetime_cap_owls) } : {}),
    };
  });
}

export type CreateGrantResult =
  | { ok: true; grant: Grant }
  | {
      ok: false;
      code: "INSUFFICIENT_OWLS" | "SCOPE_REQUIRED" | "CLAIM_NOT_FOUND" | "BAD_POLICY";
      message: string;
    };

/** Create and fund a grant. The escrow happens here — funding is the act. */
export async function createGrant(input: {
  funderUserId: string;
  name: string;
  policy: string;
  budgetOwls: number;
  scopeClaimId?: string | null;
  scopeQuery?: string | null;
}): Promise<CreateGrantResult> {
  if (!GRANT_POLICIES.includes(input.policy as GrantPolicy)) {
    return {
      ok: false,
      code: "BAD_POLICY",
      message: `Policy must be one of: ${GRANT_POLICIES.join(", ")}`,
    };
  }
  if (!input.scopeClaimId && !input.scopeQuery?.trim()) {
    return {
      ok: false,
      code: "SCOPE_REQUIRED",
      message: "A grant needs a scope: a claim (subtree) and/or a topic query",
    };
  }
  if (input.scopeClaimId) {
    const [claim] = await rawQuery<{ id: string }>(
      `SELECT id FROM claims WHERE id = $1 AND state = 'active'`,
      [input.scopeClaimId]
    );
    if (!claim) {
      // A merged node names its survivor (#884).
      const merged = await mergedAliasRefusal(input.scopeClaimId);
      return {
        ok: false,
        code: "CLAIM_NOT_FOUND",
        message: merged?.message ?? "Scope claim not found or not active",
      };
    }
  }

  const db = getDb();
  const budgetMicro = owlsToMicroUsd(input.budgetOwls);
  const [job] = await db
    .insert(budgetJobs)
    .values({
      userId: input.funderUserId,
      kind: "grant",
      claimId: input.scopeClaimId ?? null,
      budgetMicroUsd: 0,
      status: "running",
      sensitivityLabel: currentLabel(),
    })
    .returning();

  // Escrow behind the balance guard, under the owl-balance lock (same
  // shape as chargeOwls).
  const held = await withOwlBalanceLock(input.funderUserId, (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
       SELECT $1, $2, 'escrow_hold', $3
        WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
                 FROM owl_ledger WHERE user_id = $1) >= $4
       RETURNING id`,
      [input.funderUserId, -budgetMicro, job!.id, budgetMicro]
    )
  );
  if (held.length === 0) {
    await db.delete(budgetJobs).where(eq(budgetJobs.id, job!.id));
    return {
      ok: false,
      code: "INSUFFICIENT_OWLS",
      message: `Funding this grant takes ${input.budgetOwls} owls and your balance can't cover it`,
    };
  }
  await db
    .update(budgetJobs)
    .set({ budgetMicroUsd: budgetMicro })
    .where(eq(budgetJobs.id, job!.id));

  const [grant] = await db
    .insert(grants)
    .values({
      funderUserId: input.funderUserId,
      // The label of the request that creates the mandate (src/labels.ts).
      sensitivityLabel: currentLabel(),
      budgetJobId: job!.id,
      name: input.name,
      scopeClaimId: input.scopeClaimId ?? null,
      scopeQuery: input.scopeQuery?.trim() || null,
      policy: input.policy,
      // The agent policy plans first and spends nothing until approval.
      status: input.policy === "agent" ? "planning" : "active",
    })
    .returning();
  return { ok: true, grant: grant! };
}

/** Approve a grantor agent's proposed plan; its work is commissioned at once. */
export async function approveGrantPlan(input: {
  grantId: string;
  funderUserId: string;
}): Promise<
  | { ok: true; grant: Grant }
  | { ok: false; code: "NOT_FOUND" | "NOT_PENDING"; message: string }
> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, input.grantId))
    .limit(1);
  if (!grant || grant.funderUserId !== input.funderUserId) {
    return { ok: false, code: "NOT_FOUND", message: "Grant not found" };
  }
  if (grant.status !== "pending_approval") {
    return {
      ok: false,
      code: "NOT_PENDING",
      message: `Grant is ${grant.status}; only a proposed plan can be approved`,
    };
  }
  const [updated] = await db
    .update(grants)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(grants.id, grant.id))
    .returning();
  // The plan is live: its proposals are filed and its standing orders placed
  // now, not a sweep later (never throws; the sweep retries).
  const { materializeLivePlan } = await import("./action-service.js");
  await materializeLivePlan(grant.id);
  return { ok: true, grant: updated! };
}

/** Cancel a grant: stop the mandate and refund the unspent budget. */
export async function cancelGrant(input: {
  grantId: string;
  funderUserId: string;
}): Promise<
  | { ok: true; refundedMicroUsd: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_CANCELLABLE"; message: string }
> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, input.grantId))
    .limit(1);
  if (!grant || grant.funderUserId !== input.funderUserId) {
    return { ok: false, code: "NOT_FOUND", message: "Grant not found" };
  }
  if (grant.status === "completed" || grant.status === "cancelled") {
    return {
      ok: false,
      code: "NOT_CANCELLABLE",
      message: `Grant is ${grant.status}`,
    };
  }
  await db
    .update(grants)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(grants.id, grant.id));
  const [job] = await db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.id, grant.budgetJobId))
    .limit(1);
  let refunded = 0;
  if (job) {
    await db
      .update(budgetJobs)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(budgetJobs.id, job.id));
    refunded = await refundUnspentBudget({
      id: job.id,
      userId: job.userId,
      budgetMicroUsd: Number(job.budgetMicroUsd),
    });
  }
  await (await import("./gate-handoff.js")).offerMandateBelow(grant.id);
  return { ok: true, refundedMicroUsd: refunded };
}

export async function listGrants(
  funderUserId: string,
  limit = 50
): Promise<Grant[]> {
  const db = getDb();
  return db
    .select()
    .from(grants)
    .where(eq(grants.funderUserId, funderUserId))
    .orderBy(desc(grants.createdAt))
    .limit(limit);
}

export async function getGrant(grantId: string): Promise<Grant | null> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(grants)
    .where(eq(grants.id, grantId))
    .limit(1);
  return grant ?? null;
}

/**
 * The funding behind a funded assessment, for the §19 disclosure on public
 * surfaces. A mandate is named by its title and linked, so a reader can see
 * who funded it, what they declared, and what else it bought: the title is
 * the Grantmaker's, held to be neutral and faithful (docs/allocation.md,
 * "Who funds a mandate"), never the funder's message. A reader's order is
 * described, not named. Never shown to the agents that judge.
 */
export async function getFundingLabelForJob(
  jobId: string
): Promise<{
  type: "grant" | "user_order" | "job";
  label: string;
  mandate?: { id: string; title: string };
} | null> {
  const [grant] = await rawQuery<{ id: string; title: string; public: boolean }>(
    `SELECT id, COALESCE(mandate->>'title', name) AS title,
            (status IN ('active', 'completed', 'cancelled')
             OR mandate->>'origin' = 'deep_decomposition') AS public
       FROM grants WHERE budget_job_id = $1`,
    [jobId]
  );
  if (grant) {
    return {
      type: "grant",
      label: "a funded mandate",
      ...(grant.public ? { mandate: { id: grant.id, title: grant.title } } : {}),
    };
  }
  const [order] = await rawQuery<{ id: string }>(
    `SELECT id FROM assessment_orders WHERE id = $1`,
    [jobId]
  );
  if (order) return { type: "user_order", label: "a reader's assessment order" };
  const [job] = await rawQuery<{ kind: string }>(
    `SELECT kind FROM budget_jobs WHERE id = $1`,
    [jobId]
  );
  if (job) return { type: "job", label: `a funded ${job.kind.replace(/_/g, " ")} job` };
  return null;
}

/** Dashboard payload: live spend, progress, and the claims this grant touched. */
export async function serializeGrant(grant: Grant) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(budgetJobs)
    .where(eq(budgetJobs.id, grant.budgetJobId))
    .limit(1);
  // Spent as every mandate report counts it (grantEscrowBreakdown, #849).
  const spent = job
    ? (await grantEscrowBreakdown({ id: grant.id, budgetJobId: job.id })).spent
    : 0;
  const budget = job ? Number(job.budgetMicroUsd) : 0;

  // What the grant actually bought: assessments stamped with its job id.
  const funded = await rawQuery<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: Date;
  }>(
    `SELECT a.claim_id, c.text, a.status, a.assessed_at
       FROM assessments a JOIN claims c ON c.id = a.claim_id
      WHERE a.funded_by_job_id = $1
      ORDER BY a.assessed_at DESC
      LIMIT 50`,
    [grant.budgetJobId]
  );

  return {
    id: grant.id,
    name: grant.name,
    policy: grant.policy,
    status: grant.status,
    scope_claim_id: grant.scopeClaimId,
    scope_query: grant.scopeQuery,
    budget_owls: microUsdToOwls(budget),
    spent_owls: microUsdToOwls(Math.min(spent, budget)),
    budget_status: job?.status ?? null,
    budget_job_id: grant.budgetJobId,
    plan: grant.plan ?? null,
    plan_cursor: grant.planCursor,
    funded_assessments: funded.map((f) => ({
      claim_id: f.claim_id,
      text: f.text,
      status: f.status,
      assessed_at: f.assessed_at?.toISOString(),
    })),
    created_at: grant.createdAt?.toISOString(),
    updated_at: grant.updatedAt?.toISOString(),
  };
}
