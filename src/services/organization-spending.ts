/**
 * Allowances on what an organization's members and deployments spend
 * (docs/organizations.md, "What an organization grants": money, not counts).
 *
 * A grant of `spend` may carry an allowance: a sum of the organization's owls
 * that grantee may spend, set by an admin. Every guarded debit of an account
 * runs under that account's balance lock (owl-ledger-service.ts,
 * withOwlBalanceLock), so the allowance is kept there: when a request made as
 * an organization debits it, the debits the transaction wrote are added to
 * what the grantee has spent, and a transaction that would pass the allowance
 * is rolled back, before anything moves, with the figures.
 *
 * Who is spending is carried with the request (runAsSpender), set where the
 * request is known to act as the organization (server/plugins/organization-
 * spending.ts), and it goes on into work the request starts, such as an
 * Assistant turn, which spends as it runs. An admin has no grant to count
 * against, and spends from the whole balance.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { rawQuery, type TxQuery } from "../db/client.js";

export interface Spender {
  /** The organization's account, the one being debited. */
  organizationId: string;
  /** The grant of spend the debit counts against, or null where none does (an admin). */
  grantId: string | null;
}

const store = new AsyncLocalStorage<Spender | null>();

/** Run `fn` as a spender of an organization's owls: its debits count against the grant's allowance. */
export function runAsSpender<T>(spender: Spender, fn: () => T): T {
  return store.run(spender, fn);
}

/** The spender debiting `accountId` now, where the account is an organization being spent as one. */
function spenderFor(accountId: string): Spender | null {
  const spender = store.getStore() ?? null;
  return spender && spender.organizationId === accountId && spender.grantId ? spender : null;
}

export class AllowanceExceededError extends Error {
  readonly code = "ALLOWANCE_EXCEEDED";
  constructor(
    readonly allowanceMicroUsd: number,
    readonly spentMicroUsd: number,
    readonly wantedMicroUsd: number
  ) {
    super(
      `This would spend ${owls(wantedMicroUsd)} of the organization's owls, and the allowance an admin set for this ` +
        `leaves ${owls(Math.max(0, allowanceMicroUsd - spentMicroUsd))} of ${owls(allowanceMicroUsd)}. ` +
        `An admin of the organization raises it on its Members or Deployments tab.`
    );
  }
}

function owls(micro: number): string {
  return `${(micro / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} owls`;
}

/** The allowance left to the spender debiting `accountId`, in micro-USD, or null where none limits it. */
export async function allowanceLeft(tx: TxQuery, accountId: string): Promise<number | null> {
  const spender = spenderFor(accountId);
  if (!spender) return null;
  const [grant] = await tx.query<{ allowance: string | null; spent: string }>(
    `SELECT allowance_micro_usd AS allowance, allowance_spent_micro_usd AS spent
       FROM organization_grants WHERE id = $1 AND withdrawn_at IS NULL`,
    [spender.grantId]
  );
  if (!grant || grant.allowance === null) return null;
  return Math.max(0, Number(grant.allowance) - Number(grant.spent));
}

/**
 * Count what this transaction debited from `accountId` against the spender's
 * allowance, inside the account's balance lock, so debits of the same
 * organization are counted one at a time. Throws, rolling the transaction
 * back, where it would pass the allowance.
 */
export async function countAgainstAllowance(tx: TxQuery, accountId: string): Promise<void> {
  const spender = spenderFor(accountId);
  if (!spender) return;
  const [debited] = await tx.query<{ micro: string }>(
    `SELECT COALESCE(-SUM(amount_micro_usd), 0)::bigint AS micro
       FROM owl_ledger
      WHERE user_id = $1 AND amount_micro_usd < 0 AND xmin = pg_current_xact_id()::xid`,
    [accountId]
  );
  const wanted = Number(debited?.micro ?? 0);
  if (wanted <= 0) return;
  const [grant] = await tx.query<{ allowance: string | null; spent: string }>(
    `SELECT allowance_micro_usd AS allowance, allowance_spent_micro_usd AS spent
       FROM organization_grants WHERE id = $1 FOR UPDATE`,
    [spender.grantId]
  );
  if (!grant) return;
  const spent = Number(grant.spent);
  if (grant.allowance !== null && spent + wanted > Number(grant.allowance)) {
    throw new AllowanceExceededError(Number(grant.allowance), spent, wanted);
  }
  await tx.query(`UPDATE organization_grants SET allowance_spent_micro_usd = allowance_spent_micro_usd + $2 WHERE id = $1`, [
    spender.grantId,
    wanted,
  ]);
}

/**
 * The grant of spend a request made as an organization counts against: the
 * member's, or the deployment's. Null for an admin, who holds every
 * permission without a grant.
 */
export async function spendGrantOf(organizationId: string, grantee: { accountId?: string; deploymentId?: string }): Promise<string | null> {
  const [row] = await rawQuery<{ id: string }>(
    grantee.deploymentId
      ? `SELECT id FROM organization_grants WHERE deployment_id = $1 AND permission = 'spend' AND withdrawn_at IS NULL LIMIT 1`
      : `SELECT id FROM organization_grants WHERE organization_id = $2 AND account_id = $1 AND permission = 'spend' AND withdrawn_at IS NULL LIMIT 1`,
    grantee.deploymentId ? [grantee.deploymentId] : [grantee.accountId, organizationId]
  );
  return row?.id ?? null;
}
