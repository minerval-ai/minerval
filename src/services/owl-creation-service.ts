/**
 * Owls a deployment creates for itself (docs/accounts.md, "Owls a
 * deployment creates for itself").
 *
 * On the public graph owls are bought. A deployment that pays its own model
 * providers has nobody to buy them from: its owls are its own unit for
 * budgeting its agents' work, one owl for one dollar of metered cost at the
 * prices it is configured with, and its administrators create them
 * (OWLS=created). They never convert to or from owls on the public graph.
 *
 * Creating is an administrator's act, made from a signed-in session, and
 * each act writes its row to `administrative_events` in the same
 * transaction as the ledger entry, with the amount and who received it.
 * There is no cap: it is the organization's own budget, spent at its own
 * model providers, and a ceiling here would be a number nobody chose. What
 * stands in its place is that any member can read how much has been
 * created, by whom, and how much has been spent (createdOwlsSummary).
 *
 * Owls are created into an account's balance, from which a person who
 * holds `fund` puts them behind mandates exactly as on the public graph, or
 * straight into a mandate's budget. The second kind is held in the name of
 * the deployment's own account, the one account nobody signs in to
 * (platform-account.ts): if the mandate closes with money unspent, that
 * share returns to this account's balance, as any funder's does, and the
 * summary shows it.
 */
import { loadConfig } from "../config.js";
import { deploymentHoldsLabels, rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { currentClearance, currentLabel } from "../llm/usage-context.js";
import { membersOnly } from "../permissions.js";
import { unpricedConfiguredModels } from "../llm/pricing.js";
import { CREATED_OWLS_STATEMENT, microUsdToOwls, owlsCreatedHere, owlsToMicroUsd } from "./owl.js";
import { OWL_REASONS } from "./owl-ledger-service.js";
import { logAdministrativeEvent } from "./permission-service.js";
import { getPlatformAccountId } from "./platform-account.js";
import {
  GENERAL_MANDATE_KEY,
  GOVERNANCE_MANDATE_KEY,
  STANDING_NOTES,
  createStandingMandate,
  ensureLookouts,
  standingMandates,
} from "./standing-mandates.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest note an administrator may leave with created owls. */
export const OWL_CREATION_NOTE_MAX_CHARS = 500;

/** What the deployment's own account is called where no party says what the organization is. */
const OWN_ACCOUNT_FALLBACK_NAME = "This organization";

/**
 * The deployment's own account, named for the organization. On the public
 * graph the account is Minerval's and is called that. In a members-only
 * deployment it is the organization's, so it carries the name of the party
 * that is the organization itself, or says "This organization" until an
 * administrator has added that party. Called by the acts that use the
 * account, which is when its name is brought up to date.
 */
export async function deploymentOwnAccountId(): Promise<string> {
  const id = await getPlatformAccountId();
  if (!membersOnly()) return id;
  const [own] = await rawQuery<{ name: string }>(
    `SELECT name FROM parties WHERE is_own_organization = true LIMIT 1`
  );
  await rawQuery(
    `UPDATE contributors SET display_name = $2 WHERE id = $1 AND display_name IS DISTINCT FROM $2`,
    [id, own?.name ?? OWN_ACCOUNT_FALLBACK_NAME]
  );
  return id;
}

export type CreateOwlsFailure =
  | "INVALID_AMOUNT"
  | "ONE_RECIPIENT"
  | "ACCOUNT_NOT_FOUND"
  | "MANDATE_NOT_FOUND"
  | "MANDATE_NOT_OPEN";

export type CreateOwlsResult =
  | {
      ok: true;
      amount_owls: number;
      account?: { id: string; display_name: string; balance_owls: number };
      mandate?: { id: string; title: string; budget_owls: number };
    }
  | { ok: false; code: CreateOwlsFailure; message: string };

/** Rolls the transaction back when the mandate stopped taking money while it ran. */
class MandateNotOpen extends Error {}

/**
 * Create owls into an account's balance or a mandate's budget. The caller
 * has already checked that this deployment creates its own owls and that
 * the actor administers it (routes/owls.ts).
 */
export async function createOwls(input: {
  actorId: string;
  amountOwls: number;
  accountId?: string | null;
  mandateId?: string | null;
  note?: string | null;
}): Promise<CreateOwlsResult> {
  const amountMicro = owlsToMicroUsd(input.amountOwls);
  if (!Number.isFinite(input.amountOwls) || !(amountMicro > 0)) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "The amount is a number of owls greater than zero.",
    };
  }
  const accountId = input.accountId ?? null;
  const mandateId = input.mandateId ?? null;
  if ((accountId === null) === (mandateId === null)) {
    return {
      ok: false,
      code: "ONE_RECIPIENT",
      message:
        "Owls are created into one account's balance (account_id) or one mandate's budget " +
        "(mandate_id): name one of the two.",
    };
  }
  const note = (input.note ?? "").trim().slice(0, OWL_CREATION_NOTE_MAX_CHARS) || null;

  if (accountId !== null) {
    const [account] = UUID_RE.test(accountId)
      ? await rawQuery<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM contributors WHERE id = $1`,
          [accountId]
        )
      : [];
    if (!account) return { ok: false, code: "ACCOUNT_NOT_FOUND", message: "Account not found" };
    const balance = await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason) VALUES ($1, $2, $3)`,
        [account.id, amountMicro, OWL_REASONS.owlCreated]
      );
      await logAdministrativeEvent(tx, "owls_created", input.actorId, {
        amount_micro_usd: String(amountMicro),
        account_id: account.id,
        note,
      });
      const [row] = await tx.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS balance FROM owl_ledger WHERE user_id = $1`,
        [account.id]
      );
      return Number(row?.balance ?? 0);
    });
    return {
      ok: true,
      amount_owls: microUsdToOwls(amountMicro),
      account: { id: account.id, display_name: account.display_name, balance_owls: microUsdToOwls(balance) },
    };
  }

  const [mandate] = UUID_RE.test(mandateId!)
    ? await rawQuery<{ id: string; title: string; status: string; budget_job_id: string }>(
        `SELECT id, COALESCE(mandate->>'title', name) AS title, status, budget_job_id
           FROM grants WHERE id = $1`,
        [mandateId]
      )
    : [];
  if (!mandate) return { ok: false, code: "MANDATE_NOT_FOUND", message: "Mandate not found" };
  const notOpen = (status: string): CreateOwlsResult => ({
    ok: false,
    code: "MANDATE_NOT_OPEN",
    message: `This mandate is ${status} and no longer taking money. No owls were created.`,
  });
  if (mandate.status !== "active") return notOpen(mandate.status);

  const ownAccountId = await deploymentOwnAccountId();
  try {
    const budget = await withTransaction(async (tx) => {
      // The owls enter the deployment's own account and are escrowed into
      // the mandate in the same transaction, the two rows a funder's
      // contribution writes, so the mandate's accounting (who put in what,
      // what returns to whom) needs no second kind of money.
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason) VALUES ($1, $2, $3)`,
        [ownAccountId, amountMicro, OWL_REASONS.owlCreated]
      );
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
         VALUES ($1, $2, 'escrow_hold', $3)`,
        [ownAccountId, -amountMicro, mandate.budget_job_id]
      );
      // The same guarded increment a contribution makes: a job paused for
      // budget resumes, and a job that is no longer running takes nothing.
      const updated = await tx.query<{ budget: string }>(
        `UPDATE budget_jobs
            SET budget_micro_usd = budget_micro_usd + $2,
                status = 'running', updated_at = now()
          WHERE id = $1 AND status IN ('running', 'paused_budget')
          RETURNING budget_micro_usd::bigint AS budget`,
        [mandate.budget_job_id, amountMicro]
      );
      if (updated.length === 0) throw new MandateNotOpen();
      await logAdministrativeEvent(tx, "owls_created", input.actorId, {
        amount_micro_usd: String(amountMicro),
        grant_id: mandate.id,
        note,
      });
      return Number(updated[0]!.budget);
    });
    return {
      ok: true,
      amount_owls: microUsdToOwls(amountMicro),
      mandate: { id: mandate.id, title: mandate.title, budget_owls: microUsdToOwls(budget) },
    };
  } catch (err) {
    if (err instanceof MandateNotOpen) return notOpen("no longer running");
    throw err;
  }
}

// ---- the standing mandates ---------------------------------------------------

/** The names the routes call the two standing mandates by, and the key each is stored under. */
export const STANDING_MANDATE_KEYS = {
  general: GENERAL_MANDATE_KEY,
  governance: GOVERNANCE_MANDATE_KEY,
} as const;

export type StandingMandateName = keyof typeof STANDING_MANDATE_KEYS;

export function isStandingMandateName(value: string): value is StandingMandateName {
  return value === "general" || value === "governance";
}

interface StandingMandateState {
  id: string;
  status: string;
  budget_owls: number;
  daily_owls: number;
  /** Whether its budget job is running, or waiting for a budget. */
  running: boolean;
}

export interface StandingMandateView {
  name: StandingMandateName;
  title: string;
  /** What it is for, as its page will say. */
  objective: string;
  /**
   * Null until an administrator has set it up, and again once it has been
   * closed. Where the deployment holds material at more than one label
   * there is one at each label an administrator set one up at, and this is
   * the oldest of those the reader reads; `by_label` has each.
   */
  mandate: StandingMandateState | null;
  /**
   * Only where the deployment holds material at more than one label: for
   * each label the reader reads, the mandate set up there, or null. A
   * mandate's work runs at its label, so upkeep at a label is paid for by
   * the General mandate at that label and by no other.
   */
  by_label?: Array<{ label: string; mandate: StandingMandateState | null }>;
}

/** Both standing mandates, each with the mandate it is if it has been set up. */
export async function listStandingMandates(): Promise<StandingMandateView[]> {
  const definitions = standingMandates("deployment");
  const views: StandingMandateView[] = [];
  // Where the deployment holds material at more than one label, the labels
  // the reader reads: their own, so naming them to the reader shows nothing new.
  const held = await deploymentHoldsLabels();
  const labels = held ? [...currentClearance()].sort() : [];
  for (const name of ["general", "governance"] as const) {
    const definition = definitions.find((d) => d.key === STANDING_MANDATE_KEYS[name])!;
    // Every one the reader reads, oldest first: one for each label an
    // administrator set one up at (the database returns those at labels the
    // reader's clearance includes).
    const rows = await rawQuery<{
      id: string;
      status: string;
      budget: string;
      daily: string;
      job_status: string;
      title: string | null;
      objective: string | null;
      label: string;
    }>(
      `SELECT g.id, g.status, j.budget_micro_usd::bigint AS budget,
              g.daily_budget_micro_usd::bigint AS daily, j.status AS job_status,
              g.mandate->>'title' AS title, g.mandate->>'objective' AS objective,
              g.sensitivity_label AS label
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
        WHERE g.is_platform = true AND g.status = 'active' AND g.mandate->>'seed_key' = $1
        ORDER BY g.created_at ASC`,
      [definition.key]
    );
    const state = (row: (typeof rows)[number]): StandingMandateState => ({
      id: row.id,
      status: row.status,
      budget_owls: microUsdToOwls(Number(row.budget)),
      daily_owls: microUsdToOwls(Number(row.daily)),
      running: row.job_status === "running",
    });
    const first = rows[0];
    views.push({
      name,
      title: first?.title ?? definition.title,
      objective: first?.objective ?? definition.objective,
      mandate: first ? state(first) : null,
      ...(held
        ? {
            by_label: labels.map((label) => {
              const at = rows.find((r) => r.label === label);
              return { label, mandate: at ? state(at) : null };
            }),
          }
        : {}),
    });
  }
  return views;
}

export type SetUpStandingMandateResult =
  | { ok: true; mandate_id: string }
  | {
      ok: false;
      code: "ALREADY_SET_UP" | "INVALID_AMOUNT" | "BUDGET_FROM_A_BALANCE";
      message: string;
    };

/** Stops a creation whose mandate turned out to exist. */
class AlreadySetUp extends Error {}

/** Serializes two administrators setting the same mandate up at once. */
const STANDING_MANDATE_LOCK = `SELECT pg_advisory_xact_lock(hashtext('minerval:standing-mandates'))`;

/**
 * Set one standing mandate up: the mandate the seed script creates on the
 * public graph, created here by an administrator. `budgetOwls` is created
 * with it where the deployment creates its own owls; where owls are sold a
 * budget cannot be created, so the mandate starts with none and waits to be
 * funded from a balance. `dailyOwls` is its daily rate; left out, it is the
 * rate the definition starts with.
 */
export async function setUpStandingMandate(input: {
  name: StandingMandateName;
  actorId: string;
  budgetOwls?: number;
  dailyOwls?: number;
}): Promise<SetUpStandingMandateResult> {
  const budgetOwls = input.budgetOwls ?? 0;
  if (!Number.isFinite(budgetOwls) || budgetOwls < 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "The budget is a number of owls, zero or more." };
  }
  if (input.dailyOwls !== undefined && (!Number.isFinite(input.dailyOwls) || input.dailyOwls < 0)) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "The daily rate is a number of owls, zero or more. Zero means no daily rate.",
    };
  }
  if (budgetOwls > 0 && !owlsCreatedHere()) {
    return {
      ok: false,
      code: "BUDGET_FROM_A_BALANCE",
      message:
        "This deployment sells its owls, so a mandate's budget comes from an account's " +
        "balance. Set the mandate up without a budget, then fund it as any mandate is funded " +
        "(POST /mandates/:id/contribute).",
    };
  }

  const definition = standingMandates("deployment").find(
    (d) => d.key === STANDING_MANDATE_KEYS[input.name]
  )!;
  const mandate = {
    ...definition,
    budgetOwls,
    dailyBudgetOwls: input.dailyOwls ?? definition.dailyBudgetOwls,
  };
  const ownAccountId = await deploymentOwnAccountId();

  // Checked and created under one lock, in one transaction, so two
  // requests cannot both find none and both create one.
  let created: string;
  try {
    created = await createStandingMandate({
      mandate,
      funderId: ownAccountId,
      budgetReason: "owl_created",
      note: STANDING_NOTES.deployment,
      firstInTransaction: async (tx: TxQuery) => {
        await tx.query(STANDING_MANDATE_LOCK);
        // One at each label: the mandate's work runs at its label, so the
        // one this request would create is at the label the request works at.
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM grants
            WHERE is_platform = true AND status = 'active' AND mandate->>'seed_key' = $1
              AND sensitivity_label = $2
            LIMIT 1`,
          [definition.key, currentLabel()]
        );
        if (existing.length > 0) throw new AlreadySetUp();
      },
      alsoInTransaction: async (tx: TxQuery, grantId: string) => {
        await logAdministrativeEvent(tx, "standing_mandate_created", input.actorId, {
          standing_mandate: input.name,
          grant_id: grantId,
          amount_micro_usd: String(owlsToMicroUsd(budgetOwls)),
        });
      },
    });
  } catch (err) {
    if (!(err instanceof AlreadySetUp)) throw err;
    return {
      ok: false,
      code: "ALREADY_SET_UP",
      message:
        `The ${definition.title} mandate is already set up. Its budget is added to like any ` +
        `mandate's, and its Grantmaker revises its policy from there.`,
    };
  }
  await ensureLookouts(mandate, created);
  return { ok: true, mandate_id: created };
}

// ---- what any member may read ------------------------------------------------

export interface CreatedOwlsSummary {
  /** What an owl is here, in the words every surface uses. */
  statement: string;
  created: {
    total_owls: number;
    into_accounts_owls: number;
    into_mandates_owls: number;
    by_administrator: Array<{ administrator: string; owls: number; acts: number }>;
  };
  /**
   * Owls that entered balances by a setting and not by an administrator's
   * act (a signup or monthly grant the deployment set, an award), by the
   * ledger's reason. Empty where no such setting is on.
   */
  entered_by_setting: Array<{ reason: string; owls: number }>;
  /** The metered cost of every run so far, in owls, and the day of the first. */
  spent: { total_owls: number; since: string | null };
  /** What the deployment's own account holds: created owls returned from mandates that closed. */
  returned_owls: number;
  /** The acts, newest first. */
  recent: Array<{
    at: string;
    by: string | null;
    amount_owls: number;
    account?: string;
    mandate?: { id: string; title: string; withheld?: true };
    standing_mandate?: string;
    note?: string;
  }>;
  /** The prices an owl is counted at here, beyond the built-in table. */
  prices: {
    stated: Array<{ model: string; input_usd_per_mtok: number; output_usd_per_mtok: number }>;
    /** Models this deployment is configured to run that have no price, so a run on one is refused. */
    unpriced_models: Array<{ setting: string; model: string }>;
  };
}

const SPENT_TOTAL_REASON =
  "Every member is told how many owls the deployment's runs have spent in all, which is a sum over the meter's rows at every label.";

/** How much has been created, by whom, and how much has been spent. Any member may read it. */
export async function createdOwlsSummary(limit = 50): Promise<CreatedOwlsSummary> {
  const config = loadConfig();
  const acts = await rawQuery<{
    at: Date;
    action: string;
    by_name: string | null;
    detail: Record<string, string | null>;
    account_name: string | null;
    mandate_title: string | null;
  }>(
    `SELECT e.created_at AS at, e.action, actor.display_name AS by_name, e.detail,
            a.display_name AS account_name,
            COALESCE(g.mandate->>'title', g.name) AS mandate_title
       FROM administrative_events e
       LEFT JOIN contributors actor ON actor.id = e.actor_id
       LEFT JOIN contributors a ON a.id::text = e.detail->>'account_id'
       LEFT JOIN grants g ON g.id::text = e.detail->>'grant_id'
      WHERE e.action IN ('owls_created', 'standing_mandate_created')
        AND COALESCE((e.detail->>'amount_micro_usd')::bigint, 0) > 0
      ORDER BY e.created_at DESC, e.id DESC`
  );
  let intoAccounts = 0;
  let intoMandates = 0;
  const byAdministrator = new Map<string, { owls: number; acts: number }>();
  for (const act of acts) {
    const micro = Number(act.detail.amount_micro_usd ?? 0);
    if (typeof act.detail.account_id === "string") intoAccounts += micro;
    else intoMandates += micro;
    const who = act.by_name ?? "";
    const sum = byAdministrator.get(who) ?? { owls: 0, acts: 0 };
    byAdministrator.set(who, { owls: sum.owls + micro, acts: sum.acts + 1 });
  }

  const entered = await rawQuery<{ reason: string; total: string }>(
    `SELECT reason, SUM(amount_micro_usd)::bigint AS total
       FROM owl_ledger
      WHERE reason = ANY($1::text[]) AND amount_micro_usd > 0
      GROUP BY reason`,
    [
      [
        OWL_REASONS.signupGrant,
        OWL_REASONS.monthlyGrant,
        OWL_REASONS.contributionAward,
        OWL_REASONS.prizeAward,
        OWL_REASONS.adminAdjust,
      ],
    ]
  );
  // Every member may read how much has been spent in all, whatever labels
  // they read: that is what stands in a ceiling's place. The meter's rows
  // carry the label of the run each is for, so the sum is taken with the
  // system's clearance, and is a total and a date.
  const [spent] = await withSystemClearance(SPENT_TOTAL_REASON, () =>
    rawQuery<{ total: string; since: Date | null }>(
      `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS total, MIN(created_at) AS since FROM llm_usage`
    )
  );
  const ownAccountId = await getPlatformAccountId();
  const [own] = await rawQuery<{ balance: string }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS balance FROM owl_ledger WHERE user_id = $1`,
    [ownAccountId]
  );

  return {
    statement: CREATED_OWLS_STATEMENT,
    created: {
      total_owls: microUsdToOwls(intoAccounts + intoMandates),
      into_accounts_owls: microUsdToOwls(intoAccounts),
      into_mandates_owls: microUsdToOwls(intoMandates),
      by_administrator: [...byAdministrator.entries()]
        .map(([administrator, sum]) => ({
          administrator,
          owls: microUsdToOwls(sum.owls),
          acts: sum.acts,
        }))
        .sort((a, b) => b.owls - a.owls || a.administrator.localeCompare(b.administrator)),
    },
    entered_by_setting: entered
      .map((row) => ({ reason: row.reason, owls: microUsdToOwls(Number(row.total)) }))
      .sort((a, b) => a.reason.localeCompare(b.reason)),
    spent: {
      total_owls: microUsdToOwls(Number(spent?.total ?? 0)),
      since: spent?.since ? spent.since.toISOString() : null,
    },
    returned_owls: microUsdToOwls(Math.max(0, Number(own?.balance ?? 0))),
    recent: acts.slice(0, Math.min(Math.max(1, Math.trunc(limit)), 500)).map((act) => ({
      at: act.at.toISOString(),
      by: act.by_name,
      amount_owls: microUsdToOwls(Number(act.detail.amount_micro_usd ?? 0)),
      ...(typeof act.detail.account_id === "string" ? { account: act.account_name ?? "" } : {}),
      // A mandate at a label the reader does not read is named by its id alone.
      ...(typeof act.detail.grant_id === "string"
        ? {
            mandate:
              act.mandate_title === null
                ? { id: act.detail.grant_id, title: "", withheld: true as const }
                : { id: act.detail.grant_id, title: act.mandate_title },
          }
        : {}),
      ...(typeof act.detail.standing_mandate === "string"
        ? { standing_mandate: act.detail.standing_mandate }
        : {}),
      ...(typeof act.detail.note === "string" && act.detail.note ? { note: act.detail.note } : {}),
    })),
    prices: {
      stated: (config.modelPrices ?? []).map((p) => ({
        model: p.model,
        input_usd_per_mtok: p.inputUsdPerMtok,
        output_usd_per_mtok: p.outputUsdPerMtok,
      })),
      unpriced_models: unpricedConfiguredModels(config),
    },
  };
}
