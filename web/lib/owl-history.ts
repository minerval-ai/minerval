// The owl history as the account page shows it: one line per piece of work,
// with what it cost in the end, instead of one line per ledger entry.
//
// The ledger records a capped operation as two entries: the ceiling held when
// the work starts, and the unused part returned when it finishes. Read entry
// by entry that is "-2, +1.443"; what the reader wants is "an assessment,
// 0.557". This module folds each return into its hold and gathers the small
// repeated charges of a day (the Assistant bills as it works) into one line.
// It is arithmetic over what the ledger already says and changes no amount:
// the lines of a history sum to exactly what its entries sum to.

import type { OwlLedgerEntry } from "./account-api";

export interface HistoryLine {
  /** Stable within one history: the id of the line's first entry. */
  key: string;
  /** The reason of the entry that opened the line (charge, escrow_hold, purchase, ...). */
  reason: string;
  op: string | null;
  claimId: string | null;
  contributionId: string | null;
  jobId: string | null;
  /** How many like pieces of work the line gathers; 1 for a single one. */
  count: number;
  /** What was taken from the balance, as a positive number. */
  heldMicroUsd: number;
  /** What came back to it. */
  returnedMicroUsd: number;
  /** The line's effect on the balance: returned less held. */
  netMicroUsd: number;
  /** When the line's first and latest entries were written. */
  startedAt: string;
  latestAt: string;
  entries: OwlLedgerEntry[];
}

export interface HistoryDay {
  /** YYYY-MM-DD, the day the work began. */
  date: string;
  lines: HistoryLine[];
}

const CHARGE = "charge";
const SETTLEMENT = "meter_settlement";
const REFUND = "refund";
const ESCROW_HOLD = "escrow_hold";

function lineFrom(e: OwlLedgerEntry): HistoryLine {
  const line: HistoryLine = {
    key: e.id,
    reason: e.reason,
    op: e.op,
    claimId: e.claim_id,
    contributionId: e.contribution_id,
    jobId: e.job_id,
    count: 1,
    heldMicroUsd: 0,
    returnedMicroUsd: 0,
    netMicroUsd: 0,
    startedAt: e.created_at,
    latestAt: e.created_at,
    entries: [],
  };
  add(line, e);
  return line;
}

function add(line: HistoryLine, e: OwlLedgerEntry): void {
  line.entries.push(e);
  if (e.amount_micro_usd < 0) line.heldMicroUsd -= e.amount_micro_usd;
  else line.returnedMicroUsd += e.amount_micro_usd;
  line.netMicroUsd += e.amount_micro_usd;
  if (e.created_at > line.latestAt) line.latestAt = e.created_at;
  line.claimId ??= e.claim_id;
  line.contributionId ??= e.contribution_id;
}

function absorb(into: HistoryLine, other: HistoryLine): void {
  for (const e of other.entries) add(into, e);
  into.count += other.count;
}

/** Whether a return or refund belongs to this charge, going by what both name. */
function sameWork(charge: HistoryLine, e: OwlLedgerEntry): boolean {
  if (charge.op !== e.op) return false;
  if (e.contribution_id) return charge.contributionId === e.contribution_id;
  if (e.claim_id) return charge.claimId === e.claim_id;
  return false;
}

/**
 * Fold a ledger (any order) into days of lines, newest first.
 *
 * A return joins the charge the API says it settles. Where the API does not
 * say, it joins the latest charge for the same operation on the same claim
 * or contribution that has had nothing returned yet. A return whose charge
 * is not in the list (it is older than the list reaches) stands alone, and
 * is not guessed onto another charge.
 */
export function groupOwlHistory(entries: OwlLedgerEntry[]): HistoryDay[] {
  const oldestFirst = [...entries].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
  );

  const lines: HistoryLine[] = [];
  const chargeById = new Map<string, HistoryLine>();
  const charges: HistoryLine[] = [];

  for (const e of oldestFirst) {
    if (e.reason === CHARGE) {
      const line = lineFrom(e);
      lines.push(line);
      charges.push(line);
      chargeById.set(e.id, line);
      continue;
    }
    if (e.reason === SETTLEMENT || e.reason === REFUND) {
      let home = e.settles_entry_id ? chargeById.get(e.settles_entry_id) : undefined;
      if (!home) {
        for (let i = charges.length - 1; i >= 0; i--) {
          const c = charges[i]!;
          if (!sameWork(c, e)) continue;
          // A settlement closes a charge; a refund may follow a settlement.
          if (e.reason === SETTLEMENT && c.returnedMicroUsd > 0) continue;
          home = c;
          break;
        }
      }
      if (home) add(home, e);
      else lines.push(lineFrom(e));
      continue;
    }
    lines.push(lineFrom(e));
  }

  // Gather a day's repeats: charges that name no claim or contribution (the
  // Assistant's, an extension chat's), by operation; and the holds that
  // funded one job in several parts.
  const byDay = new Map<string, HistoryLine[]>();
  for (const line of lines) {
    const date = line.startedAt.slice(0, 10);
    const day = byDay.get(date) ?? [];
    if (!byDay.has(date)) byDay.set(date, day);
    const like = day.find((other) => {
      if (other.reason !== line.reason) return false;
      if (line.reason === CHARGE) {
        return (
          other.op === line.op &&
          !line.claimId && !line.contributionId && !line.jobId &&
          !other.claimId && !other.contributionId && !other.jobId
        );
      }
      if (line.reason === ESCROW_HOLD) return line.jobId !== null && other.jobId === line.jobId;
      return false;
    });
    if (like) absorb(like, line);
    else day.push(line);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, day]) => ({
      date,
      lines: day.sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0)),
    }));
}

/**
 * A day's lines as the page lists them: lines for the same operation that
 * each name their own claim stay separate lines, but four or more of them in
 * one day are offered folded, under one summed line the reader can open.
 */
export interface HistoryFold {
  op: string;
  lines: HistoryLine[];
  heldMicroUsd: number;
  returnedMicroUsd: number;
  netMicroUsd: number;
}

export const FOLD_FROM = 4;

export function foldDay(lines: HistoryLine[]): Array<HistoryLine | HistoryFold> {
  const byOp = new Map<string, HistoryLine[]>();
  for (const l of lines) {
    if (l.reason !== CHARGE || !l.op || l.count > 1) continue;
    byOp.set(l.op, [...(byOp.get(l.op) ?? []), l]);
  }
  const out: Array<HistoryLine | HistoryFold> = [];
  const folded = new Set<string>();
  for (const l of lines) {
    const group = l.reason === CHARGE && l.op && l.count === 1 ? byOp.get(l.op) : undefined;
    if (!group || group.length < FOLD_FROM) {
      out.push(l);
      continue;
    }
    if (folded.has(l.op!)) continue;
    folded.add(l.op!);
    out.push({
      op: l.op!,
      lines: group,
      heldMicroUsd: group.reduce((n, g) => n + g.heldMicroUsd, 0),
      returnedMicroUsd: group.reduce((n, g) => n + g.returnedMicroUsd, 0),
      netMicroUsd: group.reduce((n, g) => n + g.netMicroUsd, 0),
    });
  }
  return out;
}

export function isFold(x: HistoryLine | HistoryFold): x is HistoryFold {
  return "lines" in x;
}
