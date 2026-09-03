/**
 * Formal statements and the checker's records (docs/mathematics.md §5).
 *
 * A claim's formal statement is its own record with a lifecycle: a draft
 * beside the published one, prizes and attempts pinned to it by id and
 * hash, and provenance columns of its own. This module owns every write to
 * `claim_formalizations` and `lean_checks` and the read models the claim
 * page, the list, the map, and MCP derive from them.
 *
 * Two rules hold everywhere here:
 *  - The hashes, the pin, and the pretty-printed proposition come from the
 *    checker's elaboration of the stored file, never from a model's text.
 *  - The statement file is assembled by the server (§5.4): the header, the
 *    namespace, and the docstring are fixed text, so the canonical form is
 *    never interpolated into Lean source, and the Steward's draft is
 *    re-elaborated as stored before anything is recorded.
 *
 * Every write is a transaction; every state change fires a claim event.
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  leanUsageCostMicroUsd,
  type CheckKind,
  type CheckMode,
  type CheckRecord,
  type ElaborateResponse,
  type Verdict,
} from "./lean-checker-client.js";
import { emitClaimEvent } from "./claim-events-service.js";
import type {
  FormalizationSummary,
  VerificationSummary,
} from "./claim-extras-types.js";

export type FormalizationStatus = "draft" | "reviewed" | "published" | "retired";

/** The axiom closure a verdict may use (§5.2, gate 3). */
export const ALLOWED_AXIOMS = ["propext", "Classical.choice", "Quot.sound"] as const;

/** The modes whose accepted verdict can back a machine-checked argument. */
export const VERDICT_MODES: readonly CheckMode[] = ["prize", "attempt", "steward"];

/** Bounty statuses that count as live on a claim surface (§8.3). */
export const LIVE_BOUNTY_STATUSES = [
  "open",
  "claim_pending",
  "house_result_pending",
  "rebinding",
] as const;

/** The static policy (§5.5) as an outside solver reads it. */
export const STATIC_POLICY_SUMMARY = {
  rejected_tokens: [
    "sorry",
    "admit",
    "native_decide",
    "decide +native",
    "unsafe",
    "partial",
    "implemented_by",
    "extern",
    "csimp",
    "axiom",
    "opaque",
    "ofReduceBool",
    "trustCompiler",
    "#eval",
    "run_cmd",
    "run_tac",
    "elab",
    "macro",
    "macro_rules",
    "syntax",
    "initialize",
    "builtin_initialize",
    "import",
  ],
  set_option_allowlist: { maxHeartbeats: 4_000_000, maxRecDepth: 8192 },
  allowed_axioms: [...ALLOWED_AXIOMS],
  target:
    "theorem <namespace>.proof : <namespace>.Statement (or theorem <namespace>.disproof : ¬ <namespace>.Statement), appended after the checker's header; no universe parameters; the type must be alpha-equivalent to the constant the checker elaborated at publication.",
  declarations:
    "No new constant may be unsafe or partial, carry @[implemented_by], @[extern], or @[csimp], or be an axiom or an opaque; every new declaration must replay through the kernel.",
  note:
    "The route gate scans whole words and refuses the unambiguous tokens cheaply; the checker applies the policy on parsed syntax and is the authority.",
} as const;

// ---------------------------------------------------------------------------
// Row and read-model types
// ---------------------------------------------------------------------------

export interface FormalizationRow {
  id: string;
  claim_id: string;
  version: number;
  language: string;
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag: string | null;
  image_digest: string;
  namespace: string;
  statement_source: string;
  source_hash: string;
  expr_hash: string;
  pp_type: string;
  constants: unknown;
  definitions_axioms: unknown;
  witness_present: boolean;
  correspondence: string | null;
  review_notes: string | null;
  status: FormalizationStatus;
  authored_by: string;
  model: string | null;
  created_by_run_id: string | null;
  reviewed_by_run_id: string | null;
  reviewed_at: Date | null;
  published_at: Date | null;
  review_period_ends_at: Date | null;
  retired_at: Date | null;
  retire_reason: string | null;
  superseded_by: string | null;
  created_at: Date;
}

export interface LeanCheckRow {
  id: string;
  formalization_id: string;
  mode: CheckMode;
  kind: CheckKind;
  submission_sha256: string;
  submission_source: string;
  submitted_by: string;
  prize_claim_id: string | null;
  attempt_id: string | null;
  run_id: string | null;
  verdict: Verdict;
  checks: unknown;
  diagnostics: unknown;
  truncated: boolean;
  resource: unknown;
  pin_id: string;
  image_digest: string;
  checker_version: string;
  second_opinion: unknown;
  cost_micro_usd: number;
  created_at: Date;
  finished_at: Date | null;
}

/** One check, summarised for a reading surface (the web app's LeanCheckSummary). */
export interface LeanCheckSummary {
  id: string;
  kind: CheckKind;
  verdict: Verdict;
  checked_at: string;
  pin_id: string;
  submission_sha256: string | null;
  submitted_by: string | null;
}

/** A version row as GET /claims/:id/formalizations lists it. */
export interface FormalizationVersion extends FormalizationSummary {
  claim_id: string;
  image_digest: string;
  witness_present: boolean;
  constants: unknown;
  definitions_axioms: unknown;
  review_notes: string | null;
  authored_by: string;
  model: string | null;
  reviewed_at: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  superseded_by: string | null;
  created_at: string;
}

const FORMALIZATION_COLUMNS = `
  id, claim_id, version, language, pin_id, lean_toolchain, mathlib_rev,
  mathlib_tag, image_digest, namespace, statement_source, source_hash,
  expr_hash, pp_type, constants, definitions_axioms, witness_present,
  correspondence, review_notes, status, authored_by, model,
  created_by_run_id, reviewed_by_run_id, reviewed_at, published_at,
  review_period_ends_at, retired_at, retire_reason, superseded_by, created_at`;

const LEAN_CHECK_COLUMNS = `
  id, formalization_id, mode, kind, submission_sha256, submission_source,
  submitted_by, prize_claim_id, attempt_id, run_id, verdict, checks,
  diagnostics, truncated, resource, pin_id, image_digest, checker_version,
  second_opinion, cost_micro_usd::bigint AS cost_micro_usd, created_at, finished_at`;

/** The same columns qualified with the `lc` alias, for joined reads. */
const LEAN_CHECK_COLUMNS_LC = LEAN_CHECK_COLUMNS.split(",")
  .map((c) => `lc.${c.trim()}`)
  .join(", ");

// ---------------------------------------------------------------------------
// The statement convention (§5.4)
// ---------------------------------------------------------------------------

/** `Minerval.S<first 8 hex of the claim id>_v<version>`. */
export function formalizationNamespace(claimId: string, version: number): string {
  const hex = claimId.replace(/-/g, "").toLowerCase().slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(hex)) {
    throw new Error(`claim id ${claimId} does not yield eight hex digits`);
  }
  return `Minerval.S${hex}_v${version}`;
}

/** The fixed docstring: it names the version and the claim, never the canonical form. */
export function statementDocstring(claimId: string, version: number): string {
  const hex = claimId.replace(/-/g, "").toLowerCase().slice(0, 8);
  return `/-- Statement ${version} of claim ${hex}. The canonical form is in the correspondence note. -/`;
}

const STATEMENT_DEF_RE = /^\s*def\s+Statement\s*:\s*Prop\s*:=/;
const STRIPPED_LINE_RES = [
  /^\s*import\s+\S+/,
  /^\s*set_option\s+autoImplicit\b/,
  /^\s*namespace\s+Minerval\.\S+\s*$/,
  /^\s*end\s+Minerval\.\S+\s*$/,
];

/**
 * Assemble the checker-owned statement file: the only import, autoImplicit
 * forced off, the assigned namespace, the fixed docstring, then the
 * author's declarations (the `def Statement : Prop :=` and any witness
 * `example`) verbatim.
 */
export function assembleStatementFile(input: {
  claimId: string;
  version: number;
  declarations: string;
}): string {
  const ns = formalizationNamespace(input.claimId, input.version);
  const lines = input.declarations.replace(/\r\n/g, "\n").split("\n");
  const defIndex = lines.findIndex((l) => STATEMENT_DEF_RE.test(l));
  if (defIndex < 0) {
    throw new Error("the declarations carry no `def Statement : Prop :=`");
  }
  const body = [
    ...lines.slice(0, defIndex),
    statementDocstring(input.claimId, input.version),
    ...lines.slice(defIndex),
  ]
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  return [
    "import Mathlib",
    "set_option autoImplicit false",
    `namespace ${ns}`,
    body,
    `end ${ns}`,
    "",
  ].join("\n");
}

/**
 * Bring a Steward-supplied draft (a whole file, or bare declarations) into
 * the convention for the version being recorded: the header, namespace,
 * and `end` lines are the server's, and any docstring the author put on
 * `Statement` is replaced by the fixed one. Everything else is kept verbatim,
 * so what the checker elaborates is what the reviewer reads.
 */
export function normalizeStatementSource(
  source: string,
  target: { claimId: string; version: number }
): { ok: true; source: string; declarations: string } | { ok: false; error: string } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((l) => !STRIPPED_LINE_RES.some((re) => re.test(l)));
  const defIndex = kept.findIndex((l) => STATEMENT_DEF_RE.test(l));
  if (defIndex < 0) {
    return {
      ok: false,
      error:
        "The statement must define the proposition as `def Statement : Prop :=` " +
        "inside the checker's convention; nothing else is recorded.",
    };
  }
  // Drop a docstring immediately preceding the definition (blank lines
  // between are allowed); the server supplies the docstring.
  let cut = defIndex;
  let probe = defIndex - 1;
  while (probe >= 0 && kept[probe]!.trim() === "") probe--;
  if (probe >= 0 && kept[probe]!.trim().endsWith("-/")) {
    let start = probe;
    while (start >= 0 && !kept[start]!.trim().startsWith("/--")) start--;
    if (start >= 0) cut = start;
  }
  const declarations = [...kept.slice(0, cut), ...kept.slice(defIndex)]
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  if (/^\s*import\s/m.test(declarations)) {
    return { ok: false, error: "The statement may not import anything beyond Mathlib." };
  }
  try {
    return {
      ok: true,
      declarations,
      source: assembleStatementFile({ ...target, declarations }),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getFormalizationById(
  id: string,
  tx?: TxQuery
): Promise<FormalizationRow | null> {
  const run = tx ? tx.query.bind(tx) : rawQuery;
  const [row] = await run<FormalizationRow>(
    `SELECT ${FORMALIZATION_COLUMNS} FROM claim_formalizations WHERE id = $1`,
    [id]
  );
  return row ?? null;
}

export async function getPublishedFormalization(
  claimId: string
): Promise<FormalizationRow | null> {
  const [row] = await rawQuery<FormalizationRow>(
    `SELECT ${FORMALIZATION_COLUMNS} FROM claim_formalizations
      WHERE claim_id = $1 AND status = 'published'`,
    [claimId]
  );
  return row ?? null;
}

/** Every version of a claim's statement, newest first. */
export async function listFormalizationRows(claimId: string): Promise<FormalizationRow[]> {
  return rawQuery<FormalizationRow>(
    `SELECT ${FORMALIZATION_COLUMNS} FROM claim_formalizations
      WHERE claim_id = $1 ORDER BY version DESC`,
    [claimId]
  );
}

export async function nextFormalizationVersion(
  claimId: string,
  tx?: TxQuery
): Promise<number> {
  const run = tx ? tx.query.bind(tx) : rawQuery;
  const [row] = await run<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM claim_formalizations WHERE claim_id = $1`,
    [claimId]
  );
  return Number(row?.next ?? 1);
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

export function formalizationSummary(row: FormalizationRow): FormalizationSummary {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    pin_id: row.pin_id,
    lean_toolchain: row.lean_toolchain,
    mathlib_rev: row.mathlib_rev,
    mathlib_tag: row.mathlib_tag,
    namespace: row.namespace,
    statement_source: row.statement_source,
    pp_type: row.pp_type,
    source_hash: row.source_hash,
    expr_hash: row.expr_hash,
    correspondence: row.correspondence,
    published_at: iso(row.published_at),
    review_period_ends_at: iso(row.review_period_ends_at),
  };
}

export function formalizationVersion(row: FormalizationRow): FormalizationVersion {
  return {
    ...formalizationSummary(row),
    claim_id: row.claim_id,
    image_digest: row.image_digest,
    witness_present: row.witness_present,
    constants: row.constants,
    definitions_axioms: row.definitions_axioms,
    review_notes: row.review_notes,
    authored_by: row.authored_by,
    model: row.model,
    reviewed_at: iso(row.reviewed_at),
    retired_at: iso(row.retired_at),
    retire_reason: row.retire_reason,
    superseded_by: row.superseded_by,
    created_at: iso(row.created_at)!,
  };
}

/** The published statement of a claim, or null. */
export async function getFormalizationSummary(
  claimId: string
): Promise<FormalizationSummary | null> {
  const row = await getPublishedFormalization(claimId);
  return row ? formalizationSummary(row) : null;
}

/** Every version with status and review notes, newest first. */
export async function listFormalizations(claimId: string): Promise<FormalizationVersion[]> {
  const rows = await listFormalizationRows(claimId);
  return rows.map(formalizationVersion);
}

// ---------------------------------------------------------------------------
// The machine-checked badge and the per-claim SQL fragments
// ---------------------------------------------------------------------------

/**
 * How an argument cites a check: an `arguments.evidence_urls` entry whose
 * path is `/lean-checks/<id>` (relative, or under any host). The arguments
 * table carries no metadata column, so the URL is the reference.
 */
export function leanCheckEvidenceUrl(leanCheckId: string): string {
  return `/lean-checks/${leanCheckId}`;
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** SQL: the lean_checks id an evidence URL `u` names, as text (NULL when none). */
const EVIDENCE_CHECK_ID_SQL = (u: string) =>
  `substring(lower(${u}) from '/lean-checks/(${UUID_PATTERN})(?:/|$)')`;

const VERDICT_MODES_SQL = VERDICT_MODES.map((m) => `'${m}'`).join(", ");

/**
 * SQL: the kind (`proof` | `disproof`) of the accepted check that backs a
 * machine-checked argument on the claim `claimRef` names, or NULL. The
 * badge needs a published statement, an accepted verdict in a mode that can
 * be evidence, and an argument on the claim citing the check.
 */
export function checkedKindSql(claimRef: string): string {
  return `(SELECT lc.kind FROM lean_checks lc
             JOIN claim_formalizations cf
               ON cf.id = lc.formalization_id AND cf.claim_id = ${claimRef}
              AND cf.status = 'published'
            WHERE lc.verdict = 'accepted' AND lc.mode IN (${VERDICT_MODES_SQL})
              AND EXISTS (SELECT 1 FROM arguments ar, unnest(ar.evidence_urls) u
                           WHERE ar.claim_id = ${claimRef}
                             AND ${EVIDENCE_CHECK_ID_SQL("u")} = lc.id::text)
            ORDER BY COALESCE(lc.finished_at, lc.created_at) DESC
            LIMIT 1)`;
}

/**
 * SQL: a lateral subquery yielding the accepted check the argument aliased
 * `argAlias` cites (columns prefixed `lean_check_`), or no row. Join it
 * `LEFT JOIN LATERAL (...) alc ON true` beside the arguments join.
 */
export function argumentLeanCheckLateralSql(argAlias: string): string {
  return `(SELECT lc.id AS lean_check_id, lc.kind AS lean_check_kind,
                  lc.verdict AS lean_check_verdict,
                  COALESCE(lc.finished_at, lc.created_at) AS lean_check_at,
                  lc.pin_id AS lean_check_pin_id,
                  lc.submission_sha256 AS lean_check_sha256,
                  lc.submitted_by AS lean_check_submitted_by
             FROM unnest(${argAlias}.evidence_urls) AS u
             JOIN lean_checks lc ON lc.id::text = ${EVIDENCE_CHECK_ID_SQL("u")}
             JOIN claim_formalizations cf
               ON cf.id = lc.formalization_id AND cf.claim_id = ${argAlias}.claim_id
            WHERE lc.verdict = 'accepted' AND lc.mode IN (${VERDICT_MODES_SQL})
            ORDER BY COALESCE(lc.finished_at, lc.created_at) DESC
            LIMIT 1)`;
}

/** The row shape argumentLeanCheckLateralSql adds, as a summary or null. */
export function leanCheckSummaryFromLateral(row: {
  lean_check_id?: string | null;
  lean_check_kind?: string | null;
  lean_check_verdict?: string | null;
  lean_check_at?: Date | string | null;
  lean_check_pin_id?: string | null;
  lean_check_sha256?: string | null;
  lean_check_submitted_by?: string | null;
}): LeanCheckSummary | null {
  if (!row.lean_check_id) return null;
  return {
    id: row.lean_check_id,
    kind: row.lean_check_kind as CheckKind,
    verdict: (row.lean_check_verdict ?? "accepted") as Verdict,
    checked_at: iso(row.lean_check_at ?? null) ?? new Date(0).toISOString(),
    pin_id: row.lean_check_pin_id ?? "",
    submission_sha256: row.lean_check_sha256 ?? null,
    submitted_by: row.lean_check_submitted_by ?? null,
  };
}

/** SQL: whether the claim `claimRef` names has a published statement. */
export function formalExistsSql(claimRef: string): string {
  return `EXISTS (SELECT 1 FROM claim_formalizations cf
                   WHERE cf.claim_id = ${claimRef} AND cf.status = 'published')`;
}

/** SQL: the live-bounty predicate for a bounties alias. */
export function liveBountySql(bountyAlias: string): string {
  return `${bountyAlias}.status IN (${LIVE_BOUNTY_STATUSES.map((s) => `'${s}'`).join(", ")})`;
}

export function leanCheckSummary(row: {
  id: string;
  kind: string;
  verdict: string;
  finished_at: Date | string | null;
  created_at: Date | string;
  pin_id: string;
  submission_sha256: string | null;
  submitted_by: string | null;
}): LeanCheckSummary {
  return {
    id: row.id,
    kind: row.kind as CheckKind,
    verdict: row.verdict as Verdict,
    checked_at: iso(row.finished_at ?? row.created_at)!,
    pin_id: row.pin_id,
    submission_sha256: row.submission_sha256,
    submitted_by: row.submitted_by,
  };
}

/** The derived badge (§2.3): null unless a qualifying check is cited by an argument. */
export async function getVerificationSummary(
  claimId: string
): Promise<VerificationSummary | null> {
  const [row] = await rawQuery<{
    id: string;
    kind: CheckKind;
    checked_at: Date;
    formalization_id: string;
    pin_id: string;
  }>(
    `SELECT lc.id, lc.kind, COALESCE(lc.finished_at, lc.created_at) AS checked_at,
            lc.formalization_id, lc.pin_id
       FROM lean_checks lc
       JOIN claim_formalizations cf
         ON cf.id = lc.formalization_id AND cf.claim_id = $1 AND cf.status = 'published'
      WHERE lc.verdict = 'accepted' AND lc.mode IN (${VERDICT_MODES_SQL})
        AND EXISTS (SELECT 1 FROM arguments ar, unnest(ar.evidence_urls) u
                     WHERE ar.claim_id = $1
                       AND ${EVIDENCE_CHECK_ID_SQL("u")} = lc.id::text)
      ORDER BY COALESCE(lc.finished_at, lc.created_at) DESC
      LIMIT 1`,
    [claimId]
  );
  if (!row) return null;
  return {
    kind: row.kind,
    lean_check_id: row.id,
    checked_at: iso(row.checked_at)!,
    formalization_id: row.formalization_id,
    pin_id: row.pin_id,
  };
}

/**
 * The accepted check each argument on the claim cites, keyed by argument
 * id, for the deep claim payload and the tree's edges.
 */
export async function leanChecksByArgument(
  claimId: string
): Promise<Map<string, LeanCheckSummary>> {
  const rows = await rawQuery<{
    argument_id: string;
    id: string;
    kind: string;
    verdict: string;
    finished_at: Date | null;
    created_at: Date;
    pin_id: string;
    submission_sha256: string;
    submitted_by: string;
  }>(
    `SELECT DISTINCT ON (ar.id)
            ar.id AS argument_id, lc.id, lc.kind, lc.verdict, lc.finished_at,
            lc.created_at, lc.pin_id, lc.submission_sha256, lc.submitted_by
       FROM arguments ar
       CROSS JOIN LATERAL unnest(ar.evidence_urls) AS u
       JOIN lean_checks lc ON lc.id::text = ${EVIDENCE_CHECK_ID_SQL("u")}
       JOIN claim_formalizations cf
         ON cf.id = lc.formalization_id AND cf.claim_id = ar.claim_id
      WHERE ar.claim_id = $1
        AND lc.verdict = 'accepted' AND lc.mode IN (${VERDICT_MODES_SQL})
      ORDER BY ar.id, COALESCE(lc.finished_at, lc.created_at) DESC`,
    [claimId]
  );
  return new Map(rows.map((r) => [r.argument_id, leanCheckSummary(r)]));
}

/** Every check on any version of the claim's statement, newest first (no source). */
export async function listLeanChecksForClaim(claimId: string): Promise<
  Array<LeanCheckSummary & { formalization_id: string; mode: CheckMode; failed_gate: string | null }>
> {
  const rows = await rawQuery<{
    id: string;
    formalization_id: string;
    mode: CheckMode;
    kind: string;
    verdict: string;
    finished_at: Date | null;
    created_at: Date;
    pin_id: string;
    submission_sha256: string;
    submitted_by: string;
    checks: Record<string, { status?: string }> | null;
  }>(
    `SELECT lc.id, lc.formalization_id, lc.mode, lc.kind, lc.verdict, lc.finished_at,
            lc.created_at, lc.pin_id, lc.submission_sha256, lc.submitted_by, lc.checks
       FROM lean_checks lc
       JOIN claim_formalizations cf ON cf.id = lc.formalization_id
      WHERE cf.claim_id = $1
      ORDER BY COALESCE(lc.finished_at, lc.created_at) DESC`,
    [claimId]
  );
  return rows.map((r) => ({
    ...leanCheckSummary(r),
    formalization_id: r.formalization_id,
    mode: r.mode,
    failed_gate:
      r.verdict === "rejected" && r.checks
        ? (Object.entries(r.checks).find(([, g]) => g?.status === "fail")?.[0] ?? null)
        : null,
  }));
}

// ---------------------------------------------------------------------------
// lean_checks writes and reads
// ---------------------------------------------------------------------------

export async function getLeanCheckById(id: string): Promise<LeanCheckRow | null> {
  const [row] = await rawQuery<LeanCheckRow>(
    `SELECT ${LEAN_CHECK_COLUMNS} FROM lean_checks WHERE id = $1`,
    [id]
  );
  return row ? { ...row, cost_micro_usd: Number(row.cost_micro_usd) } : null;
}

/** The stored row for an identical submission under the same checker and mode. */
export async function findLeanCheck(key: {
  formalizationId: string;
  submissionSha256: string;
  checkerVersion: string;
  mode: CheckMode;
}): Promise<LeanCheckRow | null> {
  const [row] = await rawQuery<LeanCheckRow>(
    `SELECT ${LEAN_CHECK_COLUMNS} FROM lean_checks
      WHERE formalization_id = $1 AND submission_sha256 = $2
        AND checker_version = $3 AND mode = $4`,
    [key.formalizationId, key.submissionSha256, key.checkerVersion, key.mode]
  );
  return row ? { ...row, cost_micro_usd: Number(row.cost_micro_usd) } : null;
}

/**
 * A check record as the public route serves it: the source travels only
 * when the owning prize claim's attachments are public; a Steward or attempt
 * check's source is public once the attempt is published (or, with no
 * attempt, at once).
 */
export async function getLeanCheckPublicRecord(id: string): Promise<
  | (Omit<LeanCheckRow, "submission_source"> & {
      claim_id: string;
      namespace: string;
      source_public: boolean;
      submission_source: string | null;
    })
  | null
> {
  const [row] = await rawQuery<
    LeanCheckRow & { claim_id: string; namespace: string; source_public: boolean }
  >(
    `SELECT ${LEAN_CHECK_COLUMNS_LC},
            cf.claim_id, cf.namespace,
            CASE
              WHEN lc.prize_claim_id IS NOT NULL THEN EXISTS (
                SELECT 1 FROM prize_claims pc
                  JOIN attachments att ON att.contribution_id = pc.contribution_id
                 WHERE pc.id = lc.prize_claim_id AND att.visibility = 'public')
              WHEN lc.attempt_id IS NOT NULL THEN EXISTS (
                SELECT 1 FROM proof_attempts pa
                 WHERE pa.id = lc.attempt_id AND pa.published_at IS NOT NULL)
              ELSE true
            END AS source_public
       FROM lean_checks lc
       JOIN claim_formalizations cf ON cf.id = lc.formalization_id
      WHERE lc.id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    ...row,
    cost_micro_usd: Number(row.cost_micro_usd),
    submission_source: row.source_public ? row.submission_source : null,
  };
}

export interface RecordLeanCheckInput {
  formalizationId: string;
  record: CheckRecord;
  submissionSource: string;
  submittedBy: string;
  prizeClaimId?: string | null;
  attemptId?: string | null;
  runId?: string | null;
  secondOpinion?: unknown;
  /** Defaults to the checker's own resource record priced by config. */
  costMicroUsd?: number;
}

/**
 * Record a finished checker record as a `lean_checks` row. The unique key
 * (formalization, submission hash, checker version, mode) makes a repeat
 * an update of the same row, never a second one.
 */
export async function recordLeanCheck(input: RecordLeanCheckInput): Promise<LeanCheckRow> {
  const r = input.record;
  const verdict: Verdict = r.verdict ?? "error";
  const cost = Math.max(
    0,
    Math.round(input.costMicroUsd ?? leanUsageCostMicroUsd(r.resource))
  );
  const row = await withTransaction(async (tx) => {
    const [inserted] = await tx.query<LeanCheckRow & { claim_id: string }>(
      `INSERT INTO lean_checks
         (formalization_id, mode, kind, submission_sha256, submission_source,
          submitted_by, prize_claim_id, attempt_id, run_id, verdict, checks,
          diagnostics, truncated, resource, pin_id, image_digest,
          checker_version, second_opinion, cost_micro_usd, finished_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9::uuid, $10,
               $11::jsonb, $12::jsonb, $13::boolean, $14::jsonb, $15, $16, $17,
               $18::jsonb, $19::bigint, $20::timestamptz)
       ON CONFLICT (formalization_id, submission_sha256, checker_version, mode)
       DO UPDATE SET
         verdict = EXCLUDED.verdict,
         checks = EXCLUDED.checks,
         diagnostics = EXCLUDED.diagnostics,
         truncated = EXCLUDED.truncated,
         resource = EXCLUDED.resource,
         pin_id = EXCLUDED.pin_id,
         image_digest = EXCLUDED.image_digest,
         second_opinion = COALESCE(EXCLUDED.second_opinion, lean_checks.second_opinion),
         cost_micro_usd = EXCLUDED.cost_micro_usd,
         run_id = COALESCE(EXCLUDED.run_id, lean_checks.run_id),
         prize_claim_id = COALESCE(lean_checks.prize_claim_id, EXCLUDED.prize_claim_id),
         attempt_id = COALESCE(lean_checks.attempt_id, EXCLUDED.attempt_id),
         finished_at = EXCLUDED.finished_at
       RETURNING ${LEAN_CHECK_COLUMNS},
                 (SELECT claim_id FROM claim_formalizations cf
                   WHERE cf.id = lean_checks.formalization_id) AS claim_id`,
      [
        input.formalizationId,
        r.mode,
        r.kind,
        r.submission_sha256,
        input.submissionSource,
        input.submittedBy,
        input.prizeClaimId ?? null,
        input.attemptId ?? null,
        input.runId ?? null,
        verdict,
        JSON.stringify(r.checks ?? {}),
        JSON.stringify(r.diagnostics ?? []),
        Boolean(r.truncated),
        JSON.stringify(r.resource ?? {}),
        r.pin_id,
        r.image_digest,
        r.checker_version,
        input.secondOpinion === undefined ? null : JSON.stringify(input.secondOpinion),
        cost,
        r.finished_at ? new Date(r.finished_at) : null,
      ]
    );
    return inserted!;
  });
  await emitClaimEvent({
    kind: "lean_check",
    id: `lean_check:${row.id}`,
    at: iso(row.finished_at ?? row.created_at)!,
    actor: row.submitted_by,
    claim_id: row.claim_id,
    lean_check_id: row.id,
    formalization_id: row.formalization_id,
    mode: row.mode,
    check_kind: row.kind,
    verdict: row.verdict,
    failed_gate: r.failed_gate ?? null,
    pin_id: row.pin_id,
    submission_sha256: row.submission_sha256,
  });
  const { claim_id: _claimId, ...rest } = row;
  return { ...rest, cost_micro_usd: Number(rest.cost_micro_usd) };
}

// ---------------------------------------------------------------------------
// claim_formalizations writes
// ---------------------------------------------------------------------------

export interface StoreFormalizationInput {
  claimId: string;
  /** The normalized statement file exactly as elaborated. */
  statementSource: string;
  version: number;
  elaboration: ElaborateResponse;
  correspondence?: string | null;
  reviewNotes?: string | null;
  authoredBy: string;
  model?: string | null;
  runId?: string | null;
  status?: "draft" | "reviewed";
}

/**
 * Store an elaborated statement as a new version. The hashes, the pin, and
 * the pretty-printed form are taken from the checker's elaboration; a
 * response that did not elaborate is refused here too, so no caller can
 * record an unchecked string.
 */
export async function storeElaboratedFormalization(
  input: StoreFormalizationInput
): Promise<FormalizationRow> {
  const e = input.elaboration;
  if (!e.ok || !e.expr_hash || e.pp_type === undefined || !e.source_hash) {
    throw new Error("the statement did not elaborate; nothing is recorded");
  }
  const expectedNs = formalizationNamespace(input.claimId, input.version);
  if (e.namespace !== expectedNs) {
    throw new Error(
      `the elaborated namespace ${e.namespace ?? "(none)"} is not ${expectedNs}`
    );
  }
  const status = input.status ?? "draft";
  const row = await withTransaction(async (tx) => {
    const [inserted] = await tx.query<FormalizationRow>(
      `INSERT INTO claim_formalizations
         (claim_id, version, language, pin_id, lean_toolchain, mathlib_rev,
          mathlib_tag, image_digest, namespace, statement_source, source_hash,
          expr_hash, pp_type, constants, definitions_axioms, witness_present,
          correspondence, review_notes, status, authored_by, model,
          created_by_run_id, reviewed_by_run_id, reviewed_at)
       VALUES ($1::uuid, $2::int, 'lean4', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, $15::boolean, $16, $17, $18::text, $19, $20,
               $21::uuid,
               CASE WHEN $18::text = 'reviewed' THEN $21::uuid END,
               CASE WHEN $18::text = 'reviewed' THEN now() END)
       RETURNING ${FORMALIZATION_COLUMNS}`,
      [
        input.claimId,
        input.version,
        e.pin.pin_id,
        e.pin.lean_toolchain,
        e.pin.mathlib_rev,
        e.pin.mathlib_tag ?? null,
        e.pin.image_digest,
        expectedNs,
        input.statementSource,
        e.source_hash,
        e.expr_hash,
        e.pp_type,
        JSON.stringify(e.constants ?? []),
        JSON.stringify(e.definitions_axioms ?? {}),
        Boolean(e.witness_present),
        input.correspondence ?? null,
        input.reviewNotes ?? null,
        status,
        input.authoredBy,
        input.model ?? null,
        input.runId ?? null,
      ]
    );
    return inserted!;
  });
  if (status === "reviewed") {
    await emitFormalizationEvent(row, "reviewed", null);
  }
  return row;
}

async function moveOpenBountiesToRebinding(
  tx: TxQuery,
  formalizationId: string
): Promise<Array<{ id: string }>> {
  return tx.query<{ id: string }>(
    `UPDATE bounties SET status = 'rebinding', updated_at = now()
      WHERE formalization_id = $1 AND status = 'open'
      RETURNING id`,
    [formalizationId]
  );
}

/**
 * Publish a reviewed statement: it becomes the claim's one published
 * statement, the previous one is retired with `superseded_by`, and the
 * review period opens. Refuses anything not in `reviewed`.
 */
export async function publishFormalization(
  formalizationId: string,
  opts: { runId?: string | null; reviewNotes?: string | null } = {}
): Promise<{ published: FormalizationRow; retired: FormalizationRow[] }> {
  const days = loadConfig().formalizationReviewPeriodDays;
  const result = await withTransaction(async (tx) => {
    const [row] = await tx.query<FormalizationRow>(
      `SELECT ${FORMALIZATION_COLUMNS} FROM claim_formalizations WHERE id = $1 FOR UPDATE`,
      [formalizationId]
    );
    if (!row) throw new Error(`formalization ${formalizationId} not found`);
    if (row.status !== "reviewed") {
      throw new Error(
        `formalization ${formalizationId} is ${row.status}; only a reviewed statement publishes`
      );
    }
    const retired = await tx.query<FormalizationRow>(
      `UPDATE claim_formalizations
          SET status = 'retired', retired_at = now(),
              retire_reason = $3, superseded_by = $2
        WHERE claim_id = $1 AND status = 'published' AND id <> $2
        RETURNING ${FORMALIZATION_COLUMNS}`,
      [row.claim_id, formalizationId, `superseded by version ${row.version}`]
    );
    // A bounty bound to the superseded statement follows §8.5: it is held
    // until it rebinds to the new statement.
    for (const r of retired) await moveOpenBountiesToRebinding(tx, r.id);
    const [published] = await tx.query<FormalizationRow>(
      `UPDATE claim_formalizations
          SET status = 'published', published_at = now(),
              review_period_ends_at = now() + make_interval(days => $2::int),
              reviewed_by_run_id = COALESCE($3::uuid, reviewed_by_run_id),
              review_notes = CASE WHEN $4::text IS NULL OR $4::text = '' THEN review_notes
                                  ELSE concat_ws(E'\n\n', review_notes, $4::text) END
        WHERE id = $1::uuid
        RETURNING ${FORMALIZATION_COLUMNS}`,
      [formalizationId, days, opts.runId ?? null, opts.reviewNotes ?? null]
    );
    return { published: published!, retired };
  });
  for (const r of result.retired) {
    await emitFormalizationEvent(r, "retired", r.retire_reason);
  }
  await emitFormalizationEvent(result.published, "published", null);
  return result;
}

/** The fresh-context reviewer sends a reviewed statement back with notes. */
export async function returnFormalizationToDraft(
  formalizationId: string,
  opts: { reviewNotes: string; runId?: string | null }
): Promise<FormalizationRow> {
  const row = await withTransaction(async (tx) => {
    const [updated] = await tx.query<FormalizationRow>(
      `UPDATE claim_formalizations
          SET status = 'draft',
              review_notes = concat_ws(E'\n\n', review_notes, $2::text),
              reviewed_by_run_id = COALESCE($3::uuid, reviewed_by_run_id)
        WHERE id = $1::uuid AND status = 'reviewed'
        RETURNING ${FORMALIZATION_COLUMNS}`,
      [formalizationId, opts.reviewNotes, opts.runId ?? null]
    );
    if (!updated) {
      throw new Error(`formalization ${formalizationId} is not in reviewed`);
    }
    return updated;
  });
  await emitFormalizationEvent(row, "returned_to_draft", opts.reviewNotes);
  return row;
}

/** Retire a statement with a reason; an open bounty bound to it goes to rebinding. */
export async function retireFormalization(
  formalizationId: string,
  opts: { reason: string; runId?: string | null }
): Promise<{ retired: FormalizationRow; bounties: string[] }> {
  const result = await withTransaction(async (tx) => {
    const [row] = await tx.query<FormalizationRow>(
      `UPDATE claim_formalizations
          SET status = 'retired', retired_at = now(), retire_reason = $2::text
        WHERE id = $1::uuid AND status <> 'retired'
        RETURNING ${FORMALIZATION_COLUMNS}`,
      [formalizationId, opts.reason]
    );
    if (!row) throw new Error(`formalization ${formalizationId} not found or already retired`);
    const bounties = await moveOpenBountiesToRebinding(tx, formalizationId);
    return { retired: row, bounties: bounties.map((b) => b.id) };
  });
  await emitFormalizationEvent(result.retired, "retired", opts.reason);
  return result;
}

/**
 * The mechanical consequence of a canonical-form change (§5.7): the claim's
 * published statement returns to `reviewed` pending re-publication, and an
 * `open` bounty bound to it moves to `rebinding` in the same transaction.
 * A claim with no published statement is untouched.
 */
export async function demotePublishedFormalization(
  claimId: string,
  opts: { reason: string; runId?: string | null }
): Promise<{ formalization: FormalizationRow | null; bounties: string[] }> {
  const [existing] = await rawQuery<{ id: string }>(
    `SELECT id FROM claim_formalizations WHERE claim_id = $1 AND status = 'published'`,
    [claimId]
  );
  if (!existing) return { formalization: null, bounties: [] };
  const result = await withTransaction(async (tx) => {
    const [row] = await tx.query<FormalizationRow>(
      `UPDATE claim_formalizations
          SET status = 'reviewed',
              review_notes = concat_ws(E'\n\n', review_notes, $2::text)
        WHERE id = $1::uuid AND status = 'published'
        RETURNING ${FORMALIZATION_COLUMNS}`,
      [existing.id, `Returned to reviewed: ${opts.reason}`]
    );
    if (!row) return { formalization: null, bounties: [] as string[] };
    const bounties = await moveOpenBountiesToRebinding(tx, row.id);
    return { formalization: row, bounties: bounties.map((b) => b.id) };
  });
  if (result.formalization) {
    await emitFormalizationEvent(result.formalization, "reviewed", opts.reason);
  }
  return result;
}

async function emitFormalizationEvent(
  row: FormalizationRow,
  subtype: "reviewed" | "published" | "retired" | "returned_to_draft",
  reason: string | null
): Promise<void> {
  await emitClaimEvent({
    kind: "formalization",
    id: `formalization:${row.id}:${subtype}`,
    at: new Date().toISOString(),
    actor: row.authored_by,
    claim_id: row.claim_id,
    subtype,
    formalization_id: row.id,
    version: row.version,
    status: row.status,
    namespace: row.namespace,
    pin_id: row.pin_id,
    source_hash: row.source_hash,
    expr_hash: row.expr_hash,
    review_period_ends_at: iso(row.review_period_ends_at),
    reason,
  });
}

// ---------------------------------------------------------------------------
// Bounty terms (§11.1, §11.2): what an outside solver needs, from the row
// ---------------------------------------------------------------------------

export interface BountyTerms {
  claim_id: string;
  bounty_id: string;
  amount_micro_usd: number;
  status: string;
  resolution: string;
  condition_type: string;
  rules_version: string;
  opened_at: string | null;
  expires_at: string | null;
  withdraw_effective_at: string | null;
  formalization: {
    id: string;
    version: number;
    status: FormalizationStatus;
    namespace: string;
    pin_id: string;
    lean_toolchain: string;
    mathlib_rev: string;
    mathlib_tag: string | null;
    image_digest: string;
    source_hash: string;
    expr_hash: string;
    review_period_ends_at: string | null;
    statement_url: string;
  };
  allowed_axioms: string[];
  static_policy: typeof STATIC_POLICY_SUMMARY;
  window: {
    /** `review_period` until the statement's period ends; `open` while claims are accepted; `closed` otherwise. */
    state: "review_period" | "open" | "closed";
    review_period_ends_at: string | null;
    accepting_claims: boolean;
    reason: string;
  };
}

/** The live bounty's machine-readable terms, read from the row; null when none is live. */
export async function getBountyTerms(claimId: string): Promise<BountyTerms | null> {
  const [row] = await rawQuery<{
    bounty_id: string;
    amount_micro_usd: string | number;
    status: string;
    resolution: string;
    condition_type: string;
    rules_version: string;
    opened_at: Date | null;
    expires_at: Date | null;
    withdraw_effective_at: Date | null;
    formalization_id: string;
    version: number;
    f_status: FormalizationStatus;
    namespace: string;
    pin_id: string;
    lean_toolchain: string;
    mathlib_rev: string;
    mathlib_tag: string | null;
    image_digest: string;
    source_hash: string;
    expr_hash: string;
    review_period_ends_at: Date | null;
  }>(
    `SELECT b.id AS bounty_id, b.amount_micro_usd, b.status, b.resolution,
            b.condition_type, b.rules_version, b.opened_at, b.expires_at,
            b.withdraw_effective_at,
            f.id AS formalization_id, f.version, f.status AS f_status, f.namespace,
            f.pin_id, f.lean_toolchain, f.mathlib_rev, f.mathlib_tag, f.image_digest,
            f.source_hash, f.expr_hash, f.review_period_ends_at
       FROM bounties b
       JOIN claim_formalizations f ON f.id = b.formalization_id
      WHERE b.claim_id = $1 AND ${liveBountySql("b")}
      LIMIT 1`,
    [claimId]
  );
  if (!row) return null;
  const now = Date.now();
  const periodEnds = row.review_period_ends_at ? new Date(row.review_period_ends_at).getTime() : null;
  const expired = row.expires_at ? new Date(row.expires_at).getTime() <= now : false;
  let state: BountyTerms["window"]["state"];
  let reason: string;
  if (row.f_status !== "published") {
    state = "closed";
    reason = "the formal statement is not published; the prize is held until it is confirmed";
  } else if (periodEnds !== null && periodEnds > now) {
    state = "review_period";
    reason = "the statement's review period has not ended";
  } else if (row.status === "open" && !expired) {
    state = "open";
    reason = "claims are accepted";
  } else {
    state = "closed";
    reason =
      row.status === "open" ? "the bounty has expired" : `the bounty is ${row.status}`;
  }
  const apiBase = loadConfig().publicApiBaseUrl.replace(/\/$/, "");
  return {
    claim_id: claimId,
    bounty_id: row.bounty_id,
    amount_micro_usd: Number(row.amount_micro_usd),
    status: row.status,
    resolution: row.resolution,
    condition_type: row.condition_type,
    rules_version: row.rules_version,
    opened_at: iso(row.opened_at),
    expires_at: iso(row.expires_at),
    withdraw_effective_at: iso(row.withdraw_effective_at),
    formalization: {
      id: row.formalization_id,
      version: row.version,
      status: row.f_status,
      namespace: row.namespace,
      pin_id: row.pin_id,
      lean_toolchain: row.lean_toolchain,
      mathlib_rev: row.mathlib_rev,
      mathlib_tag: row.mathlib_tag,
      image_digest: row.image_digest,
      source_hash: row.source_hash,
      expr_hash: row.expr_hash,
      review_period_ends_at: iso(row.review_period_ends_at),
      statement_url: `${apiBase}/claims/${claimId}/formalization.lean`,
    },
    allowed_axioms: [...ALLOWED_AXIOMS],
    static_policy: STATIC_POLICY_SUMMARY,
    window: {
      state,
      review_period_ends_at: iso(row.review_period_ends_at),
      accepting_claims: state === "open",
      reason,
    },
  };
}
