/**
 * Lookouts — the standing watches a mandate funds (docs/allocation.md,
 * "Lookouts: cheap standing watch").
 *
 * A lookout is the cheapest agent in the system with the narrowest
 * question: has anything happened, in the scope its brief describes, that
 * warrants work? It is set up by a Grantmaker (in the owner's chat or on
 * an autonomous review pass), funded from the mandate's escrow one
 * `lookout_run` action at a time, and woken by triggers: its own heartbeat,
 * or an input event queued for it by a poller or a person.
 *
 * This module is the MECHANISM around it, in the ledger's sense:
 *   - the lookout's lifecycle (create, update, retire) with every bound the
 *     brief cannot enforce: the ceiling on the value a flag may carry on the
 *     mandate's behalf, the ingests a run may append, the heartbeat range;
 *   - the trigger queue (lookout_events) and the due computation the
 *     reconcile sweep reads;
 *   - the flag record (lookout_flags): what each run raised, folded so the
 *     same target is never re-flagged while still open, and snapshotted so
 *     the lookout's PRECISION can be read later — did the passes it bought
 *     move anything? — which is how its Grantmaker decides whether to keep
 *     paying for it.
 *
 * What a lookout can cause to happen is deliberately a candidate on the
 * ledger, never a conclusion: a reassess valued within its ceiling (its
 * mandate's allocator then funds it or not, best value per owl first, like
 * any other row), an ingest appended to its mandate's plan (priced and
 * escrow-bounded like any plan item), a note for the Grantmaker. Money it
 * never touches directly; importance and assessments it cannot reach.
 */
import { rawQuery } from "../db/client.js";
import { resolveProvider, unresolvableModelIdMessage } from "../llm/providers/routing.js";
import { ensureAssessActions, ASSESS_GROUP } from "./action-service.js";
import { enqueueSteward } from "./queue-service.js";
import { setMandateValuations } from "./mandate-valuer-service.js";
import { assertPublicHttpUrl, UnsafeUrlError } from "./url-guard.js";

/** Input kinds a lookout can wake on, beyond its heartbeat. */
export const LOOKOUT_TRIGGER_KINDS = [
  // The Crossref poller matched a retraction, correction, or expression of
  // concern to a source in the graph (workers/lookout-triggers.ts).
  "retraction",
  // A person or a Grantmaker poked the lookout with a note.
  "manual",
] as const;
export type LookoutTriggerKind = (typeof LOOKOUT_TRIGGER_KINDS)[number];

export const LOOKOUT_STATUSES = ["active", "paused", "retired"] as const;
export type LookoutStatus = (typeof LOOKOUT_STATUSES)[number];

/** Bounds the brief cannot enforce; every write clamps to these. */
export const LOOKOUT_BOUNDS = {
  titleChars: { min: 3, max: 200 },
  briefChars: { min: 40, max: 20_000 },
  /** 0 = event-only; at most monthly. */
  heartbeatHours: { min: 0, max: 24 * 30 },
  maxValue: { min: 0, max: 10 },
  maxIngestsPerRun: { min: 0, max: 20 },
  workspaceChars: 50_000,
  noteChars: 2_000,
  rationaleChars: 2_000,
} as const;

export interface LookoutRow {
  id: string;
  grant_id: string;
  title: string;
  brief: string;
  status: LookoutStatus;
  heartbeat_hours: number;
  triggers: LookoutTriggerKind[];
  model: string | null;
  max_value: number;
  max_ingests_per_run: number;
  workspace: string | null;
  last_note: string | null;
  last_run_at: Date | null;
  next_due_at: Date;
  runs: number;
  flags: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const LOOKOUT_SELECT = `
  SELECT id, grant_id, title, brief, status, heartbeat_hours, triggers, model,
         max_value, max_ingests_per_run, workspace, last_note, last_run_at,
         next_due_at, runs, flags, created_by, created_at, updated_at
    FROM lookouts`;

export type LookoutWriteResult =
  | { ok: true; lookoutId: string }
  | { ok: false; code: string; message: string };

function normalizeTriggers(raw: unknown): LookoutTriggerKind[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "triggers must be a list";
  const out: LookoutTriggerKind[] = [];
  for (const t of raw) {
    const s = String(t).trim() as LookoutTriggerKind;
    if (!LOOKOUT_TRIGGER_KINDS.includes(s)) {
      return `unknown trigger "${s}"; known: ${LOOKOUT_TRIGGER_KINDS.join(", ")}`;
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A model-supplied id that is not a uuid must be a tool problem, not a query error. */
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampReal(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Stand up a lookout on an active mandate. The brief is the lookout's
 * scope and instructions in the Grantmaker's words; everything numeric is
 * clamped to LOOKOUT_BOUNDS rather than refused, except a model id that
 * resolves to no provider, which would fail every run.
 */
export async function createLookout(input: {
  grantId: string;
  title: string;
  brief: string;
  heartbeatHours?: number;
  triggers?: unknown;
  model?: string | null;
  maxValue?: number;
  maxIngestsPerRun?: number;
  createdBy: string;
}): Promise<LookoutWriteResult> {
  const [grant] = await rawQuery<{ id: string }>(
    `SELECT id FROM grants WHERE id = $1 AND status = 'active'`,
    [input.grantId]
  );
  if (!grant) {
    return { ok: false, code: "MANDATE_NOT_ACTIVE", message: "Mandate not found or not active" };
  }
  const title = String(input.title ?? "").trim();
  if (title.length < LOOKOUT_BOUNDS.titleChars.min) {
    return { ok: false, code: "TITLE", message: "A title of a few words is required" };
  }
  const brief = String(input.brief ?? "").trim();
  if (brief.length < LOOKOUT_BOUNDS.briefChars.min) {
    return {
      ok: false,
      code: "BRIEF",
      message:
        `The brief is the lookout's whole instruction set: scope, where to ` +
        `look, what to look out for, what to leave alone. Write at least ` +
        `${LOOKOUT_BOUNDS.briefChars.min} characters.`,
    };
  }
  const triggers = normalizeTriggers(input.triggers);
  if (typeof triggers === "string") return { ok: false, code: "TRIGGERS", message: triggers };
  const model = input.model?.trim() || null;
  if (model && !resolveProvider(model)) {
    return { ok: false, code: "MODEL", message: unresolvableModelIdMessage(model) };
  }
  const heartbeat = clampInt(
    input.heartbeatHours,
    LOOKOUT_BOUNDS.heartbeatHours.min,
    LOOKOUT_BOUNDS.heartbeatHours.max,
    24
  );
  if (heartbeat === 0 && triggers.length === 0) {
    return {
      ok: false,
      code: "NEVER_WAKES",
      message: "A lookout with no heartbeat and no triggers would never run",
    };
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO lookouts
       (grant_id, title, brief, heartbeat_hours, triggers, model, max_value,
        max_ingests_per_run, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.grantId,
      title.slice(0, LOOKOUT_BOUNDS.titleChars.max),
      brief.slice(0, LOOKOUT_BOUNDS.briefChars.max),
      heartbeat,
      JSON.stringify(triggers),
      model,
      clampReal(input.maxValue, LOOKOUT_BOUNDS.maxValue.min, LOOKOUT_BOUNDS.maxValue.max, 6),
      clampInt(
        input.maxIngestsPerRun,
        LOOKOUT_BOUNDS.maxIngestsPerRun.min,
        LOOKOUT_BOUNDS.maxIngestsPerRun.max,
        3
      ),
      input.createdBy,
    ]
  );
  return { ok: true, lookoutId: row!.id };
}

/**
 * Amend a lookout the mandate owns. Only the fields given change; the same
 * bounds apply. Retiring is final; pausing keeps the record and the
 * workspace for a later resume.
 */
export async function updateLookout(input: {
  grantId: string;
  lookoutId: string;
  title?: string;
  brief?: string;
  status?: string;
  heartbeatHours?: number;
  triggers?: unknown;
  model?: string | null;
  maxValue?: number;
  maxIngestsPerRun?: number;
}): Promise<LookoutWriteResult> {
  const current = isUuid(input.lookoutId) ? await getLookout(input.lookoutId) : null;
  if (!current || current.grant_id !== input.grantId) {
    return { ok: false, code: "NOT_FOUND", message: "No such lookout on this mandate" };
  }
  if (current.status === "retired") {
    return { ok: false, code: "RETIRED", message: "A retired lookout cannot be changed" };
  }
  const sets: string[] = [];
  const params: unknown[] = [input.lookoutId];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.title !== undefined) {
    const t = String(input.title).trim();
    if (t.length < LOOKOUT_BOUNDS.titleChars.min) return { ok: false, code: "TITLE", message: "Title too short" };
    set("title", t.slice(0, LOOKOUT_BOUNDS.titleChars.max));
  }
  if (input.brief !== undefined) {
    const b = String(input.brief).trim();
    if (b.length < LOOKOUT_BOUNDS.briefChars.min) return { ok: false, code: "BRIEF", message: "Brief too short" };
    set("brief", b.slice(0, LOOKOUT_BOUNDS.briefChars.max));
  }
  if (input.status !== undefined) {
    if (!LOOKOUT_STATUSES.includes(input.status as LookoutStatus)) {
      return { ok: false, code: "STATUS", message: `status must be one of ${LOOKOUT_STATUSES.join(", ")}` };
    }
    set("status", input.status);
    // Resuming makes the heartbeat due now rather than whenever it was.
    if (input.status === "active" && current.status !== "active") set("next_due_at", new Date());
  }
  if (input.heartbeatHours !== undefined) {
    set(
      "heartbeat_hours",
      clampInt(input.heartbeatHours, LOOKOUT_BOUNDS.heartbeatHours.min, LOOKOUT_BOUNDS.heartbeatHours.max, current.heartbeat_hours)
    );
  }
  if (input.triggers !== undefined) {
    const triggers = normalizeTriggers(input.triggers);
    if (typeof triggers === "string") return { ok: false, code: "TRIGGERS", message: triggers };
    params.push(JSON.stringify(triggers));
    sets.push(`triggers = $${params.length}::jsonb`);
  }
  if (input.model !== undefined) {
    const model = input.model?.trim() || null;
    if (model && !resolveProvider(model)) return { ok: false, code: "MODEL", message: unresolvableModelIdMessage(model) };
    set("model", model);
  }
  if (input.maxValue !== undefined) {
    set("max_value", clampReal(input.maxValue, LOOKOUT_BOUNDS.maxValue.min, LOOKOUT_BOUNDS.maxValue.max, current.max_value));
  }
  if (input.maxIngestsPerRun !== undefined) {
    set(
      "max_ingests_per_run",
      clampInt(input.maxIngestsPerRun, LOOKOUT_BOUNDS.maxIngestsPerRun.min, LOOKOUT_BOUNDS.maxIngestsPerRun.max, current.max_ingests_per_run)
    );
  }
  if (sets.length === 0) return { ok: true, lookoutId: input.lookoutId };
  await rawQuery(
    `UPDATE lookouts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    params
  );
  return { ok: true, lookoutId: input.lookoutId };
}

export async function getLookout(lookoutId: string): Promise<LookoutRow | null> {
  const [row] = await rawQuery<LookoutRow>(`${LOOKOUT_SELECT} WHERE id = $1`, [lookoutId]);
  return row ?? null;
}

export async function listLookouts(grantId: string): Promise<LookoutRow[]> {
  return rawQuery<LookoutRow>(
    `${LOOKOUT_SELECT} WHERE grant_id = $1 ORDER BY created_at ASC`,
    [grantId]
  );
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Queue one input event for a lookout; the reconcile sweep makes it due. */
export async function queueLookoutEvent(input: {
  lookoutId: string;
  kind: LookoutTriggerKind;
  payload?: Record<string, unknown>;
}): Promise<{ queued: boolean }> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO lookout_events (lookout_id, kind, payload)
     SELECT $1, $2, $3::jsonb
       FROM lookouts WHERE id = $1 AND status = 'active'
     RETURNING id`,
    [input.lookoutId, input.kind, JSON.stringify(input.payload ?? {})]
  );
  return { queued: rows.length > 0 };
}

/**
 * Fan an event out to every active lookout that watches for `kind` on an
 * active mandate. Which lookouts care about THIS retraction is their
 * judgment, so every subscriber gets it; the per-lookout event cap keeps a
 * noisy poller from queueing more than one run can read.
 */
export async function queueLookoutEventsByTrigger(input: {
  kind: LookoutTriggerKind;
  payload: Record<string, unknown>;
  /** Unconsumed events a lookout may hold before further ones are dropped. */
  maxPendingPerLookout?: number;
}): Promise<{ queued: number }> {
  const cap = input.maxPendingPerLookout ?? 50;
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO lookout_events (lookout_id, kind, payload)
     SELECT l.id, $1, $2::jsonb
       FROM lookouts l
       JOIN grants g ON g.id = l.grant_id
      WHERE l.status = 'active' AND g.status = 'active'
        AND l.triggers ? $1
        AND (SELECT COUNT(*) FROM lookout_events e
              WHERE e.lookout_id = l.id AND e.consumed_at IS NULL) < $3
     RETURNING id`,
    [input.kind, JSON.stringify(input.payload), cap]
  );
  return { queued: rows.length };
}

export interface LookoutEventRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export async function pendingLookoutEvents(lookoutId: string, limit = 50): Promise<LookoutEventRow[]> {
  return rawQuery<LookoutEventRow>(
    `SELECT id, kind, payload, created_at FROM lookout_events
      WHERE lookout_id = $1 AND consumed_at IS NULL
      ORDER BY created_at ASC LIMIT $2`,
    [lookoutId, limit]
  );
}

export async function consumeLookoutEvents(lookoutId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await rawQuery(
    `UPDATE lookout_events SET consumed_at = now()
      WHERE lookout_id = $1 AND id = ANY($2::uuid[]) AND consumed_at IS NULL`,
    [lookoutId, ids]
  );
}

/**
 * Stamp the end of a run: the heartbeat's next due time (from now, so a
 * late run does not immediately re-fire), the counters, the note. A
 * heartbeat of 0 pushes next_due_at far out; only events wake such a
 * lookout, and the reconcile sweep's EXISTS clause does that.
 */
export async function recordLookoutRun(input: {
  lookoutId: string;
  note: string | null;
  flagsRaised: number;
  /** A failed run backs off rather than retrying on the next sweep. */
  failed?: boolean;
}): Promise<void> {
  await rawQuery(
    `UPDATE lookouts
        SET last_run_at = now(),
            next_due_at = CASE
              WHEN $4::boolean THEN now() + GREATEST(make_interval(hours => heartbeat_hours), interval '6 hours')
              WHEN heartbeat_hours > 0 THEN now() + make_interval(hours => heartbeat_hours)
              ELSE 'infinity'::timestamptz END,
            runs = runs + 1,
            flags = flags + $3,
            last_note = COALESCE($2, last_note),
            updated_at = now()
      WHERE id = $1`,
    [
      input.lookoutId,
      input.note ? input.note.slice(0, LOOKOUT_BOUNDS.noteChars) : null,
      input.flagsRaised,
      input.failed === true,
    ]
  );
}

export async function updateLookoutWorkspace(lookoutId: string, content: string): Promise<number> {
  const text = content.slice(0, LOOKOUT_BOUNDS.workspaceChars);
  await rawQuery(`UPDATE lookouts SET workspace = $2, updated_at = now() WHERE id = $1`, [
    lookoutId,
    text,
  ]);
  return text.length;
}

// ---------------------------------------------------------------------------
// Flags — what a run raised
// ---------------------------------------------------------------------------

export type FlagResult =
  | {
      ok: true;
      flag_id: string;
      duplicate: false;
      action_id: string | null;
      value_written: number | null;
      note: string;
    }
  | { ok: true; flag_id: string; duplicate: true; note: string }
  | { ok: false; code: string; problem: string };

/**
 * A reassess flag: the claim becomes a candidate (enqueued to the Steward
 * lane with the lookout's trigger and context, which materializes its
 * assess/reassess rows), and the funding mandate's valuation on the
 * standard variant is written at the lookout's urgency clamped to its
 * ceiling. Whether the row then RUNS is the mandate allocator's call,
 * by value per owl against everything else the mandate values — the
 * lookout has raised a candidate, not spent money.
 *
 * Folding: a second flag on the same claim while the earlier one's action
 * is still open or running is a repeat, not a new flag, and rewrites
 * nothing (a lookout that keeps seeing the same retraction every heartbeat
 * must not keep bumping the value).
 */
export async function flagReassessment(input: {
  lookoutId: string;
  grantId: string;
  maxValue: number;
  claimId: string;
  rationale: string;
  urgency: number;
}): Promise<FlagResult> {
  const rationale = String(input.rationale ?? "").trim().slice(0, LOOKOUT_BOUNDS.rationaleChars);
  if (rationale.length < 10) {
    return { ok: false, code: "RATIONALE", problem: "Say why, in a sentence or two" };
  }
  if (!isUuid(input.claimId)) {
    return { ok: false, code: "CLAIM", problem: "claim_id must be a claim id you saw in a tool result" };
  }
  const [claim] = await rawQuery<{ id: string; state: string }>(
    `SELECT id, state FROM claims WHERE id = $1`,
    [input.claimId]
  );
  if (!claim || claim.state !== "active") {
    return { ok: false, code: "CLAIM", problem: "No active claim with that id" };
  }
  const [open] = await rawQuery<{ id: string; created_at: Date; repeats: number }>(
    `SELECT f.id, f.created_at, f.repeats
       FROM lookout_flags f
       LEFT JOIN actions a ON a.id = f.action_id
      WHERE f.lookout_id = $1 AND f.kind = 'reassess' AND f.claim_id = $2
        AND (a.status IN ('open', 'running') OR (f.action_id IS NULL AND f.created_at > now() - interval '7 days'))
      ORDER BY f.created_at DESC LIMIT 1`,
    [input.lookoutId, input.claimId]
  );
  if (open) {
    await rawQuery(
      `UPDATE lookout_flags SET repeats = repeats + 1, updated_at = now() WHERE id = $1`,
      [open.id]
    );
    return {
      ok: true,
      flag_id: open.id,
      duplicate: true,
      note:
        `Already flagged on ${open.created_at.toISOString().slice(0, 10)} and still ` +
        `waiting for its pass; counted as a repeat, nothing rewritten. Note it in ` +
        `your workspace so you stop re-raising it.`,
    };
  }

  const urgency = clampReal(input.urgency, 0, 10, 5);
  const value = Math.min(urgency, clampReal(input.maxValue, 0, 10, 0));
  const [current] = await rawQuery<{ id: string; status: string; claim_credence: number | null }>(
    `SELECT id, status, claim_credence FROM assessments
      WHERE claim_id = $1 AND is_current = true LIMIT 1`,
    [input.claimId]
  );

  await enqueueSteward({
    claimId: input.claimId,
    trigger: "lookout_flag",
    context:
      `A lookout funded by a mandate reports a development bearing on this ` +
      `claim and asks for a fresh look: ${rationale}`,
  });
  await ensureAssessActions(input.claimId);
  const [standard] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions
      WHERE exclusion_group = $1 AND variant = 'standard' AND status = 'open'
      LIMIT 1`,
    [ASSESS_GROUP(input.claimId)]
  );
  let valueWritten: number | null = null;
  if (standard && value > 0) {
    const res = await setMandateValuations(input.grantId, [
      {
        action_id: standard.id,
        value,
        rationale: `[lookout] ${rationale}`,
      },
    ]);
    if (res.written > 0) valueWritten = value;
  }
  const [flag] = await rawQuery<{ id: string }>(
    `INSERT INTO lookout_flags
       (lookout_id, kind, claim_id, action_id, rationale, urgency, value_written,
        status_at_flag, credence_at_flag, assessment_id_at_flag)
     VALUES ($1, 'reassess', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.lookoutId,
      input.claimId,
      standard?.id ?? null,
      rationale,
      urgency,
      valueWritten,
      current?.status ?? null,
      current?.claim_credence ?? null,
      current?.id ?? null,
    ]
  );
  return {
    ok: true,
    flag_id: flag!.id,
    duplicate: false,
    action_id: standard?.id ?? null,
    value_written: valueWritten,
    note:
      valueWritten === null
        ? "Recorded as a candidate; no valuation written (the mandate's ceiling for you is 0, or the ledger row is not open)."
        : `Recorded. The claim is a candidate for reassessment with your mandate valuing it at ${valueWritten}/10; its allocator decides whether that buys a pass today.`,
  };
}

/**
 * An ingest flag: append the URL to the funding mandate's plan as an
 * ingest item, priced and escrow-bounded like any plan item (the reconcile
 * sweep opens its row; fundGrantSelfActions covers it). Refused for a URL
 * already in the graph, already planned, or not safely fetchable.
 */
export async function flagIngest(input: {
  lookoutId: string;
  grantId: string;
  url: string;
  rationale: string;
}): Promise<FlagResult> {
  const rationale = String(input.rationale ?? "").trim().slice(0, LOOKOUT_BOUNDS.rationaleChars);
  if (rationale.length < 10) {
    return { ok: false, code: "RATIONALE", problem: "Say why, in a sentence or two" };
  }
  let url: string;
  try {
    url = (await assertPublicHttpUrl(String(input.url ?? "").trim())).toString();
  } catch (err) {
    return {
      ok: false,
      code: "URL",
      problem: err instanceof UnsafeUrlError ? err.message : "Not a fetchable public URL",
    };
  }
  const [existing] = await rawQuery<{ id: string; title: string }>(
    `SELECT id, title FROM sources WHERE url = $1`,
    [url]
  );
  if (existing) {
    return {
      ok: false,
      code: "ALREADY_IN_GRAPH",
      problem: `That source is already in the graph ("${existing.title}", ${existing.id}). If it changed materially, flag the claims that rest on it for reassessment instead.`,
    };
  }
  const [planned] = await rawQuery<{ id: string }>(
    `SELECT id FROM grants
      WHERE id = $1 AND status = 'active'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(plan->'items', '[]'::jsonb)) t
                     WHERE t->>'action' = 'ingest' AND t->>'url' = $2)`,
    [input.grantId, url]
  );
  if (planned) {
    const [flag] = await rawQuery<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM lookout_flags
        WHERE lookout_id = $1 AND kind = 'ingest' AND url = $2
        ORDER BY created_at DESC LIMIT 1`,
      [input.lookoutId, url]
    );
    if (flag) {
      await rawQuery(`UPDATE lookout_flags SET repeats = repeats + 1, updated_at = now() WHERE id = $1`, [flag.id]);
      return { ok: true, flag_id: flag.id, duplicate: true, note: "Already on the mandate's plan from an earlier flag of yours; counted as a repeat." };
    }
    return { ok: false, code: "ALREADY_PLANNED", problem: "That URL is already on the mandate's plan" };
  }
  const item = { action: "ingest", url, rationale: `[lookout] ${rationale}` };
  await rawQuery(
    `UPDATE grants
        SET plan = jsonb_set(
              COALESCE(plan, '{"items": []}'::jsonb), '{items}',
              COALESCE(plan->'items', '[]'::jsonb) || $2::jsonb),
            updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [input.grantId, JSON.stringify([item])]
  );
  const [flag] = await rawQuery<{ id: string }>(
    `INSERT INTO lookout_flags (lookout_id, kind, url, rationale)
     VALUES ($1, 'ingest', $2, $3) RETURNING id`,
    [input.lookoutId, url, rationale]
  );
  return {
    ok: true,
    flag_id: flag!.id,
    duplicate: false,
    action_id: null,
    value_written: null,
    note: "Appended to the mandate's plan as an ingest item; it is priced against the escrow and runs when covered.",
  };
}

/** A note for the Grantmaker's next review pass; no ledger effect. */
export async function flagNote(input: {
  lookoutId: string;
  text: string;
  claimId?: string | null;
  url?: string | null;
}): Promise<FlagResult> {
  const text = String(input.text ?? "").trim().slice(0, LOOKOUT_BOUNDS.rationaleChars);
  if (text.length < 10) return { ok: false, code: "TEXT", problem: "Say something" };
  // An anchor that is not a real claim id is dropped, not an error.
  const claimId = isUuid(input.claimId) ? input.claimId : null;
  const [flag] = await rawQuery<{ id: string }>(
    `INSERT INTO lookout_flags (lookout_id, kind, claim_id, url, rationale)
     SELECT $1, 'note', c.id, $3, $4
       FROM (SELECT $2::uuid AS id) want
       LEFT JOIN claims c ON c.id = want.id
     RETURNING id`,
    [input.lookoutId, claimId, input.url ?? null, text]
  );
  return {
    ok: true,
    flag_id: flag!.id,
    duplicate: false,
    action_id: null,
    value_written: null,
    note: "Noted for the Grantmaker's next review pass.",
  };
}

export interface LookoutFlagRow {
  id: string;
  lookout_id: string;
  kind: "reassess" | "ingest" | "note";
  claim_id: string | null;
  claim_text: string | null;
  url: string | null;
  action_id: string | null;
  action_status: string | null;
  rationale: string;
  urgency: number | null;
  value_written: number | null;
  status_at_flag: string | null;
  credence_at_flag: number | null;
  /** The claim's current assessment, for the moved/unchanged read. */
  status_now: string | null;
  credence_now: number | null;
  /** True when a new assessment landed after the flag. */
  ran: boolean;
  /** True when that assessment changed status, or credence by > 0.1. */
  moved: boolean;
  repeats: number;
  created_at: Date;
}

const FLAG_SELECT = `
  SELECT f.id, f.lookout_id, f.kind, f.claim_id, c.text AS claim_text, f.url,
         f.action_id, a.status AS action_status, f.rationale, f.urgency,
         f.value_written, f.status_at_flag, f.credence_at_flag,
         cur.status AS status_now, cur.claim_credence AS credence_now,
         (f.kind = 'reassess' AND cur.id IS NOT NULL
            AND cur.id IS DISTINCT FROM f.assessment_id_at_flag) AS ran,
         (f.kind = 'reassess' AND cur.id IS NOT NULL
            AND cur.id IS DISTINCT FROM f.assessment_id_at_flag
            AND (cur.status IS DISTINCT FROM f.status_at_flag
                 OR ABS(COALESCE(cur.claim_credence, 0) - COALESCE(f.credence_at_flag, 0)) > 0.1)) AS moved,
         f.repeats, f.created_at
    FROM lookout_flags f
    LEFT JOIN claims c ON c.id = f.claim_id
    LEFT JOIN actions a ON a.id = f.action_id
    LEFT JOIN assessments cur ON cur.claim_id = f.claim_id AND cur.is_current = true`;

export async function listLookoutFlags(
  lookoutId: string,
  opts: { limit?: number; since?: Date } = {}
): Promise<LookoutFlagRow[]> {
  return rawQuery<LookoutFlagRow>(
    `${FLAG_SELECT}
      WHERE f.lookout_id = $1 AND ($3::timestamptz IS NULL OR f.created_at > $3)
      ORDER BY f.created_at DESC LIMIT $2`,
    [lookoutId, opts.limit ?? 50, opts.since ?? null]
  );
}

/** Every flag raised by the mandate's lookouts since `since` (for the review briefing). */
export async function listMandateLookoutFlags(
  grantId: string,
  opts: { since?: Date | null; limit?: number } = {}
): Promise<Array<LookoutFlagRow & { lookout_title: string }>> {
  return rawQuery<LookoutFlagRow & { lookout_title: string }>(
    `${FLAG_SELECT.replace("SELECT f.id,", "SELECT l.title AS lookout_title, f.id,")}
      JOIN lookouts l ON l.id = f.lookout_id
      WHERE l.grant_id = $1 AND ($2::timestamptz IS NULL OR f.created_at > $2)
      ORDER BY f.created_at DESC LIMIT $3`,
    [grantId, opts.since ?? null, opts.limit ?? 40]
  );
}

export interface LookoutPrecision {
  /** Reassess flags raised. */
  flagged: number;
  /** ...whose pass has since run. */
  ran: number;
  /** ...where that pass changed the verdict or moved credence. */
  moved: number;
  ingests: number;
  notes: number;
}

/**
 * The lookout's track record, read from the flags: of the reassessments it
 * asked for, how many ran, and how many changed anything. The Grantmaker's
 * evidence for keeping, tightening, or retiring the watch — a lookout whose
 * flags never move a verdict is spending the mandate's attention on noise.
 */
export async function lookoutPrecision(lookoutId: string): Promise<LookoutPrecision> {
  const [row] = await rawQuery<{
    flagged: number; ran: number; moved: number; ingests: number; notes: number;
  }>(
    `SELECT COUNT(*) FILTER (WHERE kind = 'reassess')::int AS flagged,
            COUNT(*) FILTER (WHERE kind = 'reassess' AND ran)::int AS ran,
            COUNT(*) FILTER (WHERE kind = 'reassess' AND moved)::int AS moved,
            COUNT(*) FILTER (WHERE kind = 'ingest')::int AS ingests,
            COUNT(*) FILTER (WHERE kind = 'note')::int AS notes
       FROM (${FLAG_SELECT} WHERE f.lookout_id = $1) flags`,
    [lookoutId]
  );
  return {
    flagged: Number(row?.flagged ?? 0),
    ran: Number(row?.ran ?? 0),
    moved: Number(row?.moved ?? 0),
    ingests: Number(row?.ingests ?? 0),
    notes: Number(row?.notes ?? 0),
  };
}

export interface LookoutSummary {
  id: string;
  title: string;
  brief: string;
  status: LookoutStatus;
  heartbeat_hours: number;
  triggers: LookoutTriggerKind[];
  model: string | null;
  max_value: number;
  max_ingests_per_run: number;
  runs: number;
  flags: number;
  last_run_at: string | null;
  next_due_at: string | null;
  last_note: string | null;
  pending_events: number;
  precision: LookoutPrecision;
  created_by: string | null;
  created_at: string;
}

/** The mandate page's lookouts section, and the Grantmaker's list tool. */
export async function summarizeLookouts(grantId: string): Promise<LookoutSummary[]> {
  const rows = await listLookouts(grantId);
  const out: LookoutSummary[] = [];
  for (const l of rows) {
    const [pending] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lookout_events WHERE lookout_id = $1 AND consumed_at IS NULL`,
      [l.id]
    );
    out.push({
      id: l.id,
      title: l.title,
      brief: l.brief,
      status: l.status,
      heartbeat_hours: l.heartbeat_hours,
      triggers: l.triggers ?? [],
      model: l.model,
      max_value: l.max_value,
      max_ingests_per_run: l.max_ingests_per_run,
      runs: l.runs,
      flags: l.flags,
      last_run_at: l.last_run_at ? new Date(l.last_run_at).toISOString() : null,
      next_due_at:
        l.next_due_at && Number.isFinite(new Date(l.next_due_at).getTime())
          ? new Date(l.next_due_at).toISOString()
          : null,
      last_note: l.last_note,
      pending_events: Number(pending?.n ?? 0),
      precision: await lookoutPrecision(l.id),
      created_by: l.created_by,
      created_at: new Date(l.created_at).toISOString(),
    });
  }
  return out;
}
