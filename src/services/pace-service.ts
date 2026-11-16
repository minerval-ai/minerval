/**
 * A mandate's pace: how fast its money may be committed, and by whom.
 *
 * Most mandates are projects: explore a question, ingest a source, map a
 * literature. Their money is naturally spent as the work arrives, much of
 * it at the start, and a rate per day only gets in the way. A few are
 * upkeep (the General mandate) that should spread their money evenly. So a
 * mandate's pace is one of two kinds, chosen with the funder when the
 * mandate is drafted and changed only with the funder (amend_pace):
 *
 *  - `as_needed`: the escrow is the only bound. The default.
 *  - `steady`: at most `owls` committed in any rolling `period_hours`
 *    (24 for a day's worth, 168 for a week's). Rolling, so there is no
 *    midnight at which a day's room appears all at once.
 *
 * Inside the pace, the Grantmaker holds a reserve (set_reserve): owls its
 * officers, lookouts, plan orders and the mandate's own routine runs cannot
 * commit, and only the Grantmaker can. The reserve is how a project mandate
 * spends freely on the first wave of work while keeping money back for the
 * directions that turn out to be worth pursuing. It says who may commit,
 * never when, and it never makes money unspendable: the Grantmaker draws on
 * it, or lowers it, whenever it judges.
 *
 * Every check of a mandate's money asks paceRoom (or its SQL twin, for the
 * queries that fund many rows at once), and every agent that spends a
 * mandate's money reads the same sentence about where its pace stands, with
 * the figures and the reason.
 */
import { rawQuery, type TxQuery } from "../db/client.js";
import { allocationDayUseSql } from "./day-use.js";
import { grantCommittedMicroUsd } from "./regrant-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";

export type Pace =
  | { kind: "as_needed"; reason?: string | null }
  | { kind: "steady"; owls: number; period_hours: number; reason?: string | null };

/** Who is committing the money: the Grantmaker may draw on the reserve; everyone else may not. */
export type PaceCommitter = "grantmaker" | "delegated";

export const AS_NEEDED: Pace = { kind: "as_needed" };

/** Read a stored pace, tolerating anything malformed as as_needed. */
export function parsePace(raw: unknown): Pace {
  const p = (raw ?? {}) as Record<string, unknown>;
  const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : null;
  if (p.kind === "steady") {
    const owls = Number(p.owls);
    const hours = Number(p.period_hours);
    if (owls > 0 && hours > 0) return { kind: "steady", owls, period_hours: hours, reason };
  }
  return { kind: "as_needed", reason };
}

/** Validate a pace someone proposes; a problem in words, or the pace. */
export function validatePace(raw: unknown): { ok: true; pace: Pace } | { ok: false; problem: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (p.kind === "as_needed") return { ok: true, pace: parsePace(p) };
  if (p.kind === "steady") {
    const owls = Number(p.owls);
    const hours = Number(p.period_hours);
    if (!(owls > 0)) return { ok: false, problem: "A steady pace needs owls above zero: how much may be committed per period." };
    if (!(hours >= 1)) return { ok: false, problem: "A steady pace needs period_hours of at least 1 (24 for a day, 168 for a week)." };
    return { ok: true, pace: parsePace(p) };
  }
  return { ok: false, problem: "kind is as_needed or steady." };
}

/** The pace in a phrase, for briefings and pages. */
export function describePace(pace: Pace): string {
  if (pace.kind === "as_needed") return "as needed: the escrow is the only bound";
  const period =
    pace.period_hours === 24 ? "day" : pace.period_hours === 168 ? "week" : `${pace.period_hours} hours`;
  return `steady: at most ${pace.owls} owls committed in any rolling ${period}`;
}

/**
 * SQL for what a mandate has committed within its pace's window (counted as
 * a commission counts it: amounts while runs may spend them, spend once
 * they settle). `g` is the grants alias; returns 0 for an as_needed pace.
 */
export function windowUseSql(g: string): string {
  return `(CASE WHEN ${g}.pace->>'kind' = 'steady' THEN
      COALESCE((SELECT SUM(${allocationDayUseSql("pal")})
                  FROM minerval_whole.allocation_money pal
                 WHERE pal.grant_id = ${g}.id
                   AND pal.created_at > now() - make_interval(hours => (${g}.pace->>'period_hours')::int)), 0)
    ELSE 0 END)`;
}

/**
 * SQL for the room a mandate's pace leaves within its window (null for as
 * needed, which has no window): owls per period less what the window holds.
 * The escrow and the reserve are checked beside it.
 */
export function windowRoomSql(g: string): string {
  return `(CASE WHEN ${g}.pace->>'kind' = 'steady' THEN
      GREATEST(0, ((${g}.pace->>'owls')::numeric * 1000000)::bigint - ${windowUseSql(g)})
    ELSE NULL END)`;
}

export interface PaceRoom {
  pace: Pace;
  /** What this committer may commit now. */
  availableMicroUsd: number;
  /** Which bound is the tight one. */
  binding: "window" | "reserve" | "escrow";
  escrowMicroUsd: number;
  committedMicroUsd: number;
  reserveMicroUsd: number;
  reserveReason: string | null;
  /** Steady only: what the window holds and allows. */
  windowUsedMicroUsd: number | null;
  windowMicroUsd: number | null;
  /** The one sentence every mandate agent reads about where the pace stands. */
  sentence: string;
}

const owls = (micro: number) => Math.round(microUsdToOwls(micro) * 100) / 100;

/** Where a mandate's pace stands for one committer. */
export async function paceRoom(grantId: string, who: PaceCommitter, tx?: TxQuery): Promise<PaceRoom | null> {
  const q = <T,>(text: string, params: unknown[]) => (tx ? tx.query<T>(text, params) : rawQuery<T>(text, params));
  const [g] = await q<{ pace: unknown; reserve: string; reserve_reason: string | null; budget_job_id: string; escrow: string; window_used: string }>(
    `SELECT g.pace, g.reserve_micro_usd AS reserve, g.reserve_reason, g.budget_job_id,
            j.budget_micro_usd AS escrow, ${windowUseSql("g")}::bigint AS window_used
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
    [grantId]
  );
  if (!g) return null;
  const pace = parsePace(g.pace);
  const escrow = Number(g.escrow);
  const committed = await grantCommittedMicroUsd({ id: grantId, budgetJobId: g.budget_job_id }, tx);
  const uncommitted = Math.max(0, escrow - committed);
  const reserve = Math.min(Math.max(0, Number(g.reserve)), uncommitted);
  const windowMicro = pace.kind === "steady" ? owlsToMicroUsd(pace.owls) : null;
  const windowUsed = pace.kind === "steady" ? Number(g.window_used) : null;
  const windowRoom = windowMicro !== null ? Math.max(0, windowMicro - windowUsed!) : Number.POSITIVE_INFINITY;
  const unreserved = who === "grantmaker" ? uncommitted : Math.max(0, uncommitted - reserve);
  const available = Math.min(unreserved, windowRoom);
  const binding: PaceRoom["binding"] =
    windowRoom < unreserved ? "window" : who === "delegated" && reserve > 0 && unreserved < uncommitted ? "reserve" : "escrow";
  const parts = [
    `Pace ${describePace(pace)}${pace.reason ? ` (${pace.reason})` : ""}.`,
    `Committed so far ${owls(committed)} of ${owls(escrow)} owls in escrow; ${owls(uncommitted)} uncommitted.`,
  ];
  if (pace.kind === "steady") {
    parts.push(`The window holds ${owls(windowUsed!)} of ${pace.owls} owls; it frees as running work settles and as commitments age past ${pace.period_hours} hours.`);
  }
  if (reserve > 0) {
    parts.push(
      who === "grantmaker"
        ? `You hold ${owls(reserve)} owls in reserve${g.reserve_reason ? ` (${g.reserve_reason})` : ""}, which only you may commit.`
        : `The Grantmaker holds ${owls(reserve)} owls in reserve${g.reserve_reason ? ` (${g.reserve_reason})` : ""}; only it may commit them.`
    );
  }
  parts.push(`${who === "grantmaker" ? "You" : "Officers, lookouts and the mandate's routine runs"} may commit ${owls(available)} owls now.`);
  return {
    pace,
    availableMicroUsd: available,
    binding,
    escrowMicroUsd: escrow,
    committedMicroUsd: committed,
    reserveMicroUsd: reserve,
    reserveReason: g.reserve_reason,
    windowUsedMicroUsd: windowUsed,
    windowMicroUsd: windowMicro,
    sentence: parts.join(" "),
  };
}

/** A refusal in words: why a budget does not fit, with the figures and when room returns. */
export function paceRefusal(room: PaceRoom, budgetMicroUsd: number): string {
  const ask = `A budget of ${owls(budgetMicroUsd)} owls`;
  if (room.binding === "window") {
    return (
      `${ask} is more than the mandate's pace leaves in its window (${owls(room.availableMicroUsd)} of ` +
      `${owls(room.windowMicroUsd ?? 0)} owls per ${room.pace.kind === "steady" ? room.pace.period_hours : 0} hours). ` +
      `Room returns as running work settles and as commitments age out of the window.`
    );
  }
  if (room.binding === "reserve") {
    return (
      `${ask} is more than the money outside the Grantmaker's reserve (${owls(room.availableMicroUsd)} owls; ` +
      `${owls(room.reserveMicroUsd)} are reserved${room.reserveReason ? `: ${room.reserveReason}` : ""}). ` +
      `Work that should draw on the reserve goes to the Grantmaker.`
    );
  }
  return `${ask} is more than the escrow holds uncommitted (${owls(room.availableMicroUsd)} owls).`;
}

/**
 * Who a commission counts as, from who placed it. Besides the Grantmaker's
 * own commissions, two kinds of spending may draw on the reserve: the
 * system's sittings that decide what to fund (a mandate that cannot pay to
 * decide can never release its reserve either) and a paused session's
 * resumption, which continues work the mandate already committed to.
 */
export function committerFor(commissionedBy: string | null | undefined): PaceCommitter {
  return commissionedBy === "grantmaker" ||
    commissionedBy === "review_pass" ||
    commissionedBy === "system" ||
    commissionedBy === "session_resume"
    ? "grantmaker"
    : "delegated";
}

/** What a mandate committed in the last `hours` (amounts while runs may spend them, spend once settled). */
export async function committedWithinMicroUsd(grantId: string, hours: number, tx?: TxQuery): Promise<number> {
  const q = <T,>(text: string, params: unknown[]) => (tx ? tx.query<T>(text, params) : rawQuery<T>(text, params));
  const [row] = await q<{ used: string }>(
    `SELECT COALESCE(SUM(${allocationDayUseSql()}), 0)::bigint AS used
       FROM minerval_whole.allocation_money WHERE grant_id = $1 AND created_at > now() - make_interval(hours => $2::int)`,
    [grantId, Math.max(1, Math.round(hours))]
  );
  return Number(row?.used ?? 0);
}
