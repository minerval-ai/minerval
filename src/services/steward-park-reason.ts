/**
 * The public reason a Steward pass failed (#846).
 *
 * `claims.steward_error` holds the raw error text: provider error bodies with
 * request ids, Postgres messages naming internal roles and relations,
 * hostnames. That is for logs and the service-scoped report, never for a
 * public page. Beside it, `claims.steward_error_reason` holds one of the
 * fixed classes below, chosen when the error is written, and every public
 * surface (GET /monitors queue health, a plan item's explanation, the parked
 * marker on a subclaim, a commission's note, public_read.nodes) shows only
 * that class.
 *
 * The classes are deliberately few and say whose fault the failure was, which
 * is what a reader deciding whether to commission another attempt needs:
 * a deployment fault clears on its own, a refusal follows the claim and the
 * model, and the rest need a maintainer.
 */
import { LlmRefusalError } from "../llm/errors.js";
import { MAX_STEWARD_ATTEMPTS } from "./steward-lease.js";

export const STEWARD_ERROR_REASONS = [
  "credentials_fault",
  "model_refusal",
  "database_fault",
  "tool_failure",
  "provider_error",
  "other",
] as const;
export type StewardErrorReason = (typeof STEWARD_ERROR_REASONS)[number];

/** One short phrase per class, safe to publish. Reads after "because of". */
export const STEWARD_ERROR_REASON_LABELS: Record<StewardErrorReason, string> = {
  credentials_fault: "a credentials fault in the deployment (not the claim's)",
  model_refusal: "the model refused the request",
  database_fault: "a database fault",
  tool_failure: "a tool failure",
  provider_error: "a model or provider error",
  other: "an internal error",
};

export function isStewardErrorReason(v: unknown): v is StewardErrorReason {
  return typeof v === "string" && (STEWARD_ERROR_REASONS as readonly string[]).includes(v);
}

/** A stored value read back: anything unrecognised or missing is 'other'. */
export function stewardErrorReasonOf(v: unknown): StewardErrorReason {
  return isStewardErrorReason(v) ? v : "other";
}

/**
 * The text patterns behind each class, in the order they are tried. One list
 * serves both classifiers: the TypeScript one below (which also reads the
 * error's class and status) and the SQL one that backfilled the rows parked
 * before the column existed (migration 0113), so the two cannot drift.
 * Lower-case substrings, matched against the lower-cased error text; none
 * contains a quote, a percent sign or an underscore-sensitive wildcard that
 * SQL LIKE would read differently (underscores are escaped in the SQL).
 */
const TEXT_PATTERNS: ReadonlyArray<[StewardErrorReason, readonly string[]]> = [
  [
    "credentials_fault",
    ["authentication_error", "invalid x-api-key", "api key is invalid", "invalid api key"],
  ],
  ["model_refusal", ["refused the request"]],
  [
    "database_fault",
    [
      "violates ",
      "does not exist",
      "permission denied for",
      "deadlock detected",
      "syntax error at or near",
      "invalid input syntax",
      "could not serialize access",
      "statement timeout",
      "connection terminated",
      "too many clients",
      "sqlstate",
    ],
  ],
  ["tool_failure", ["tool failed", "tool error", "tool_use", "tool call", "unknown tool"]],
  [
    "provider_error",
    [
      "invalid_request_error",
      "not_found_error",
      "permission_error",
      "request_too_large",
      "overloaded_error",
      "api_error",
      "openrouter",
      "anthropic",
      "openai",
      "max_tokens",
      "stop_reason",
      "structured output",
      "context window",
      "prompt is too long",
    ],
  ],
];

function classifyText(text: string): StewardErrorReason {
  const lower = text.toLowerCase();
  for (const [reason, patterns] of TEXT_PATTERNS) {
    if (patterns.some((p) => lower.includes(p))) return reason;
  }
  return "other";
}

/** The class of raw error text already stored, with no error object to read. */
export function classifyStewardErrorText(text: string | null | undefined): StewardErrorReason {
  return classifyText(text ?? "");
}

/**
 * The class of a failure as it is caught. What the error is (its class, its
 * SQLSTATE, its HTTP status) outranks what its message happens to say.
 */
export function classifyStewardFailure(err: unknown): StewardErrorReason {
  if (err instanceof LlmRefusalError) return "model_refusal";
  const e = (err ?? {}) as { status?: unknown; name?: unknown; code?: unknown; severity?: unknown };
  if (e.status === 401 || e.name === "AuthenticationError") return "credentials_fault";
  // node-postgres' DatabaseError: a five-character SQLSTATE and a severity.
  if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === "string") {
    return "database_fault";
  }
  const byText = classifyText(err instanceof Error ? err.message : String(err ?? ""));
  if (byText !== "other") return byText;
  // An HTTP status with nothing more specific said: the provider answered
  // with an error.
  if (typeof e.status === "number" && e.status >= 400) return "provider_error";
  return "other";
}

function sqlLikePattern(p: string): string {
  return `%${p.replace(/\\/g, "\\\\").replace(/_/g, "\\_").replace(/%/g, "\\%")}%`;
}

/**
 * The same text classification as a SQL CASE over `column` (a text
 * expression). Migration 0113's backfill is this expression over
 * `steward_error`, verbatim; tests/unit/services/steward-park-reason.test.ts
 * holds the two together.
 */
export function stewardErrorReasonSql(column: string): string {
  const whens = TEXT_PATTERNS.map(([reason, patterns]) => {
    const tests = patterns.map((p) => `lower(${column}) LIKE '${sqlLikePattern(p)}'`).join("\n         OR ");
    return `    WHEN ${tests}\n      THEN '${reason}'`;
  });
  return `CASE\n${whens.join("\n")}\n    ELSE 'other'\n  END`;
}

/** A parked node, as public surfaces describe it. */
export interface StewardPark {
  reason: StewardErrorReason;
  /** The class in words. */
  reason_label: string;
  /** When its last pass ended (the park), ISO 8601; null if never recorded. */
  since: string | null;
  failed_passes: number;
}

export function stewardPark(row: {
  reason: string | null;
  since: Date | string | null;
  attempts: number | null;
}): StewardPark {
  const reason = stewardErrorReasonOf(row.reason);
  const since =
    row.since instanceof Date ? row.since.toISOString() : row.since ? new Date(row.since).toISOString() : null;
  return {
    reason,
    reason_label: STEWARD_ERROR_REASON_LABELS[reason],
    since,
    failed_passes: Number(row.attempts ?? 0),
  };
}

/**
 * The columns behind a parked marker, for a query whose node alias is
 * `alias`: the reason is non-null only where the node is parked AND carries
 * no current judgment of its kind (`unjudged`, a SQL boolean expression the
 * caller supplies from its own joins). A parked node that was assessed
 * before it parked still reads by its assessment; the marker is for the
 * premise a parent would otherwise take to be merely waiting its turn.
 */
export function stewardParkSelectSql(alias: string, unjudged: string): string {
  return `CASE WHEN ${alias}.steward_state = 'error' AND (${unjudged})
                 THEN COALESCE(${alias}.steward_error_reason, 'other') END AS park_reason,
            ${alias}.stewarded_at AS park_since, ${alias}.steward_attempts AS park_attempts`;
}

export interface StewardParkRow {
  park_reason?: string | null;
  park_since?: Date | string | null;
  park_attempts?: number | null;
}

/** `{ steward_parked }` for a row that carries the marker, else nothing. */
export function stewardParkedField(row: StewardParkRow): { steward_parked?: StewardPark } {
  if (!row.park_reason) return {};
  return {
    steward_parked: stewardPark({
      reason: row.park_reason,
      since: row.park_since ?? null,
      attempts: row.park_attempts ?? 0,
    }),
  };
}

/** How the marker is described wherever a tool or a route returns it. */
export const STEWARD_PARKED_DESCRIPTION =
  "A node with no judgment that carries `steward_parked` is not waiting its " +
  "turn: its Steward's passes failed and it is out of the queue (`reason` is " +
  "one of credentials_fault, model_refusal, database_fault, tool_failure, " +
  "provider_error, other; `since` and `failed_passes` say when and how " +
  "often). It will not be judged on its own. Commissioning a pass on it buys " +
  "another attempt.";

/**
 * What whoever commissions a parked node is told (#846). There is no
 * automatic retry of a genuine park: a commission is the retry, and its payer
 * should know that is what the money buys. The attempt counter is not reset
 * by a commission, so a node parked at the cap parks again on its next
 * failure; one parked early (a refusal parks on the first) has what is left
 * of the cap.
 */
export function stewardParkNote(park: StewardPark): string {
  const left = Math.max(1, MAX_STEWARD_ATTEMPTS - park.failed_passes);
  const failures = `${park.failed_passes} failed pass${park.failed_passes === 1 ? "" : "es"}`;
  return (
    `This node was parked${park.since ? ` since ${park.since.slice(0, 10)}` : ""} after ${failures}: ` +
    `${park.reason_label}. The Steward does not retry a parked node on its own; this commission buys ` +
    (left === 1
      ? "one more attempt, and the node parks again if that fails."
      : `at most ${left} more attempts (one if it fails as before), after which the node parks again.`)
  );
}
