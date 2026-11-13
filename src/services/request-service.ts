/**
 * Requests (constitution Part VIII, Requests): something someone could do
 * that would improve what the graph knows. A request says what is asked,
 * why it matters (what the judgments it bears on would become under its
 * possible outcomes), and what would satisfy it.
 *
 * The keeper is fixed when the request is filed: the Steward of the one
 * node it bears on, or the Curator when it bears on several, on a source,
 * or on nothing the graph holds yet. The keeper decides when it is met. Work
 * on a request is recorded with its outcome, and every outcome (a negative
 * result, a finding that it cannot be met, a refusal) is a complete one.
 */
import { takenUpOn, type TakenUp } from "./request-take-up-service.js";
import { rawQuery, requestTextMatch, withTransaction } from "../db/client.js";
import {
  CLOSED_REQUEST_STATES,
  REQUEST_OUTCOMES,
  REQUEST_STATES,
  type NodeKind,
  type RequestFilerKind,
  type RequestOutcome,
  type RequestState,
} from "../schemas/kinds.js";
import { generateEmbedding } from "./embedding-service.js";
import {
  closeRequestActions,
  COVERAGE_SQL,
  ensureRequestActions,
  ensureRequestCurateAction,
} from "./action-service.js";
import { getFundingLabelForJob } from "./grant-service.js";
import { enqueueSteward } from "./queue-service.js";
import { mergedAliasRefusals } from "./claim-alias-service.js";
import { currentLabel } from "../llm/usage-context.js";

export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/** Embedding text: the ask carries the identity, the why what it turns on. */
export function requestEmbeddingText(ask: string, why: string): string {
  return `${ask.trim()}\n\n${why.trim()}`.slice(0, 4000);
}

/**
 * A request's embedding as a vector literal, or null when the embedder is
 * down. A failure is not the filer's problem: the request is recorded
 * without one, keyword search still finds it, and the backfill script
 * (scripts/backfill-request-embeddings.ts) embeds it later.
 */
async function embedRequest(ask: string, why: string): Promise<string | null> {
  try {
    return `[${(await generateEmbedding(requestEmbeddingText(ask, why))).join(",")}]`;
  } catch (err) {
    console.error(
      "[requests] embedding failed; recording without one:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export type RequestFiler =
  | { kind: "admin"; agent: string; runId?: string | null }
  | { kind: "contributor"; contributorId: string }
  // A mandate files through the Reviewer; the grant is recorded for the
  // funder's own dashboard and never shown on public surfaces.
  | { kind: "mandate"; grantId: string; runId?: string | null };

export async function fileRequest(input: {
  ask: string;
  why: string;
  satisfiedBy: string;
  whoCould?: string | null;
  addressedTo?: string | null;
  bearsOnText?: string | null;
  claimIds?: string[];
  sourceIds?: string[];
  /**
   * What doing it should cost, in USD, when the filer can say. Without one
   * the request is scoped first: a cheap pass whose quote becomes this.
   */
  budgetUsd?: number | null;
  filer: RequestFiler;
}): Promise<{ id: string }> {
  for (const [field, v] of [["ask", input.ask], ["why", input.why], ["satisfied_by", input.satisfiedBy]] as const) {
    if (!v.trim()) throw new RequestError(`A request states its ${field}`);
  }
  const claimIds = [...new Set(input.claimIds ?? [])];
  const sourceIds = [...new Set(input.sourceIds ?? [])];
  if (claimIds.length === 0 && sourceIds.length === 0 && !input.bearsOnText?.trim()) {
    throw new RequestError("A request bears on a node, a source, or something described in bears_on_text");
  }
  const keeperClaimId = claimIds.length === 1 && sourceIds.length === 0 ? claimIds[0]! : null;
  const budgetMicroUsd = budgetMicro(input.budgetUsd);
  const filer = input.filer;
  // Embedded before the transaction, so no row lock waits on the network.
  const embedding = await embedRequest(input.ask, input.why);
  const filed = await withTransaction(async (tx) => {
    if (claimIds.length > 0) {
      const live = await tx.query<{ id: string }>(
        `SELECT id FROM claims WHERE id = ANY($1::uuid[]) AND state = 'active'`,
        [claimIds]
      );
      const found = new Set(live.map((r) => r.id));
      const missing = claimIds.filter((id) => !found.has(id));
      if (missing.length > 0) throw new RequestError(await noActiveNodeMessage(missing));
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO requests
         (ask, why, satisfied_by, who_could, addressed_to, bears_on_text,
          filer_kind, filer_agent, filer_contributor_id, filer_grant_id, filer_run_id,
          keeper_kind, keeper_claim_id, state, embedding, budget_micro_usd, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::vector, $16, $17) RETURNING id`,
      [
        input.ask.trim(),
        input.why.trim(),
        input.satisfiedBy.trim(),
        input.whoCould?.trim() || null,
        input.addressedTo?.trim() || null,
        input.bearsOnText?.trim() || null,
        filer.kind,
        filer.kind === "admin" ? filer.agent : null,
        filer.kind === "contributor" ? filer.contributorId : null,
        filer.kind === "mandate" ? filer.grantId : null,
        filer.kind === "contributor" ? null : (filer.runId ?? null),
        keeperClaimId ? "steward" : "curator",
        keeperClaimId,
        input.addressedTo?.trim() ? "addressed" : "open",
        embedding,
        budgetMicroUsd,
        currentLabel(),
      ]
    );
    const id = row!.id;
    for (const claimId of claimIds) {
      await tx.query(`INSERT INTO request_targets (request_id, claim_id, sensitivity_label) VALUES ($1, $2, $3)`, [id, claimId, currentLabel()]);
    }
    for (const sourceId of sourceIds) {
      await tx.query(`INSERT INTO request_targets (request_id, source_id, sensitivity_label) VALUES ($1, $2, $3)`, [id, sourceId, currentLabel()]);
    }
    return { id };
  });
  // A filed request is work anyone may fund: its row goes on the ledger,
  // priced and offered to the platform lane at once.
  await openRequestWork(filed.id);
  return filed;
}

/** Open the request's next row on the ledger and let the platform lane price it now. */
async function openRequestWork(requestId: string): Promise<void> {
  const actionId = await ensureRequestActions(requestId);
  if (!actionId) return;
  const { fundRequestNow } = await import("./maintenance-funding.js");
  await fundRequestNow(actionId);
}

/** A stated budget in USD as micro-USD; null when none is stated. */
function budgetMicro(usd: number | null | undefined): number | null {
  if (usd == null) return null;
  if (!Number.isFinite(usd) || usd <= 0) throw new RequestError("A request's budget is a positive amount in USD");
  return Math.round(usd * 1_000_000);
}

/**
 * Set what doing a request should cost. The request's `full` row is priced
 * at it and reopens, so a keeper who revises a budget after work came back
 * short asks for, and can be funded for, the rest.
 */
export async function setRequestBudget(input: { requestId: string; budgetUsd: number }): Promise<void> {
  const budget = budgetMicro(input.budgetUsd);
  await withTransaction(async (tx) => {
    const [req] = await tx.query<{ state: RequestState }>(
      `SELECT state FROM requests WHERE id = $1 FOR UPDATE`,
      [input.requestId]
    );
    if (!req) throw new RequestError(`Request ${input.requestId} not found`);
    if (isClosed(req.state)) throw new RequestError(`Request ${input.requestId} is ${req.state}`);
    await tx.query(`UPDATE requests SET budget_micro_usd = $2, updated_at = now() WHERE id = $1`, [
      input.requestId,
      budget,
    ]);
  });
  await openRequestWork(input.requestId);
}

function isClosed(state: string): boolean {
  return (CLOSED_REQUEST_STATES as readonly string[]).includes(state);
}

/**
 * Record work on a request. Work under way (no outcome yet) takes an open
 * request into progress; an outcome does not close it, since whether the
 * request is met is the keeper's call.
 */
export async function recordWork(input: {
  requestId: string;
  byLabel: string;
  contributorId?: string | null;
  researchRunId?: string | null;
  outcome?: RequestOutcome | null;
  summary: string;
  fundedByJobId?: string | null;
  /**
   * For a run on the full work (#885): the budget it was given and what
   * the work was priced at when it started, so the log can say when a run
   * was funded below its quote.
   */
  budgetMicroUsd?: number | null;
  quoteMicroUsd?: number | null;
}): Promise<{ id: string }> {
  if (input.outcome != null && !(REQUEST_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new RequestError(`Unknown outcome "${input.outcome}"`);
  }
  if (!input.summary.trim()) throw new RequestError("Work on a request is summarized");
  return withTransaction(async (tx) => {
    const [req] = await tx.query<{ state: RequestState }>(
      `SELECT state FROM requests WHERE id = $1 FOR UPDATE`,
      [input.requestId]
    );
    if (!req) throw new RequestError(`Request ${input.requestId} not found`);
    if (isClosed(req.state)) throw new RequestError(`Request ${input.requestId} is ${req.state}`);
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO request_work
         (request_id, by_label, contributor_id, research_run_id, outcome, summary, funded_by_job_id,
          budget_micro_usd, quote_micro_usd, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        input.requestId,
        input.byLabel,
        input.contributorId ?? null,
        input.researchRunId ?? null,
        input.outcome ?? null,
        input.summary.trim(),
        input.fundedByJobId ?? null,
        input.budgetMicroUsd == null ? null : Math.round(input.budgetMicroUsd),
        input.quoteMicroUsd == null ? null : Math.round(input.quoteMicroUsd),
        currentLabel(),
      ]
    );
    if (req.state !== "in_progress") {
      await tx.query(`UPDATE requests SET state = 'in_progress', updated_at = now() WHERE id = $1`, [
        input.requestId,
      ]);
    }
    return { id: row!.id };
  });
}

/**
 * Move a request to a new state. A closed request (met, declined,
 * withdrawn, moot) stays closed; closing it other than as met takes a note
 * saying why.
 */
export async function setRequestState(input: {
  requestId: string;
  state: RequestState;
  note?: string | null;
}): Promise<void> {
  if (!(REQUEST_STATES as readonly string[]).includes(input.state)) {
    throw new RequestError(`Unknown request state "${input.state}"`);
  }
  const note = input.note?.trim() || null;
  if (["declined", "withdrawn", "moot"].includes(input.state) && !note) {
    throw new RequestError(`A request ${input.state} says why`);
  }
  await withTransaction(async (tx) => {
    const [req] = await tx.query<{ state: RequestState }>(
      `SELECT state FROM requests WHERE id = $1 FOR UPDATE`,
      [input.requestId]
    );
    if (!req) throw new RequestError(`Request ${input.requestId} not found`);
    if (isClosed(req.state)) throw new RequestError(`Request ${input.requestId} is already ${req.state}`);
    await tx.query(
      `UPDATE requests
          SET state = $2, state_note = COALESCE($3, state_note), updated_at = now(),
              closed_at = CASE WHEN $4 THEN now() ELSE NULL END
        WHERE id = $1`,
      [input.requestId, input.state, note, isClosed(input.state)]
    );
  });
  // A closed request takes no more work: its rows close and its funders'
  // unspent money returns.
  if (isClosed(input.state)) await closeRequestActions(input.requestId);
}

/** Sharpen a request's wording: what it asks, why, what would satisfy it, who could do it, whom it is put to. */
export async function reviseRequest(input: {
  requestId: string;
  ask?: string | null;
  why?: string | null;
  satisfiedBy?: string | null;
  whoCould?: string | null;
  addressedTo?: string | null;
  bearsOnText?: string | null;
}): Promise<void> {
  const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
  const fields: [string, string | null | undefined][] = [
    ["ask", text(input.ask)],
    ["why", text(input.why)],
    ["satisfied_by", text(input.satisfiedBy)],
    ["who_could", text(input.whoCould)],
    ["addressed_to", text(input.addressedTo)],
    ["bears_on_text", text(input.bearsOnText)],
  ];
  for (const [col, v] of fields) {
    if (["ask", "why", "satisfied_by"].includes(col) && v === null) {
      throw new RequestError(`A request keeps its ${col}`);
    }
  }
  const set = fields.filter(([, v]) => v !== undefined);
  if (set.length === 0) throw new RequestError("Nothing to revise");
  await withTransaction(async (tx) => {
    const [req] = await tx.query<{ state: RequestState; addressed_to: string | null }>(
      `SELECT state, addressed_to FROM requests WHERE id = $1 FOR UPDATE`,
      [input.requestId]
    );
    if (!req) throw new RequestError(`Request ${input.requestId} not found`);
    if (isClosed(req.state)) throw new RequestError(`Request ${input.requestId} is ${req.state}`);
    const params: unknown[] = [input.requestId];
    const assignments = set.map(([col, v]) => {
      params.push(v);
      return `${col} = $${params.length}`;
    });
    // Putting an open request to a party addresses it, and withdrawing the
    // address opens it again; work under way stays under way.
    const addressed = set.find(([col]) => col === "addressed_to");
    if (addressed && req.state !== "in_progress") {
      assignments.push(`state = '${addressed[1] ? "addressed" : "open"}'`);
    }
    await tx.query(`UPDATE requests SET ${assignments.join(", ")}, updated_at = now() WHERE id = $1`, params);
  });
  // New wording, new embedding: re-embedded after the transaction, from the
  // row as it now stands. A failed embed clears it rather than leave search
  // ranking the request by words it no longer says.
  if (set.some(([col]) => col === "ask" || col === "why")) {
    const [row] = await rawQuery<{ ask: string; why: string }>(
      `SELECT ask, why FROM requests WHERE id = $1`,
      [input.requestId]
    );
    if (row) {
      await rawQuery(`UPDATE requests SET embedding = $2::vector WHERE id = $1`, [
        input.requestId,
        await embedRequest(row.ask, row.why),
      ]);
    }
  }
}

/**
 * Set what a request bears on, as the graph comes to hold it, and fix its
 * keeper again: a request that now bears on one node alone passes to that
 * node's Steward, and one that bears on several, on a source, or on nothing
 * the graph holds stays with the Curator.
 */
export async function setRequestTargets(input: {
  requestId: string;
  claimIds: string[];
  sourceIds?: string[];
}): Promise<{ keeper: "steward" | "curator"; keeperClaimId: string | null }> {
  const claimIds = [...new Set(input.claimIds)];
  const sourceIds = [...new Set(input.sourceIds ?? [])];
  return withTransaction(async (tx) => {
    const [req] = await tx.query<{ state: RequestState; bears_on_text: string | null }>(
      `SELECT state, bears_on_text FROM requests WHERE id = $1 FOR UPDATE`,
      [input.requestId]
    );
    if (!req) throw new RequestError(`Request ${input.requestId} not found`);
    if (isClosed(req.state)) throw new RequestError(`Request ${input.requestId} is ${req.state}`);
    if (claimIds.length === 0 && sourceIds.length === 0 && !req.bears_on_text) {
      throw new RequestError("A request bears on a node, a source, or something described in bears_on_text");
    }
    if (claimIds.length > 0) {
      const live = await tx.query<{ id: string }>(
        `SELECT id FROM claims WHERE id = ANY($1::uuid[]) AND state = 'active'`,
        [claimIds]
      );
      const found = new Set(live.map((r) => r.id));
      const missing = claimIds.filter((id) => !found.has(id));
      if (missing.length > 0) throw new RequestError(await noActiveNodeMessage(missing));
    }
    await tx.query(`DELETE FROM request_targets WHERE request_id = $1`, [input.requestId]);
    for (const claimId of claimIds) {
      await tx.query(`INSERT INTO request_targets (request_id, claim_id, sensitivity_label) VALUES ($1, $2, $3)`, [input.requestId, claimId, currentLabel()]);
    }
    for (const sourceId of sourceIds) {
      await tx.query(`INSERT INTO request_targets (request_id, source_id, sensitivity_label) VALUES ($1, $2, $3)`, [input.requestId, sourceId, currentLabel()]);
    }
    const keeperClaimId = claimIds.length === 1 && sourceIds.length === 0 ? claimIds[0]! : null;
    const keeper = keeperClaimId ? "steward" : "curator";
    await tx.query(
      `UPDATE requests SET keeper_kind = $2, keeper_claim_id = $3, updated_at = now() WHERE id = $1`,
      [input.requestId, keeper, keeperClaimId]
    );
    return { keeper, keeperClaimId };
  });
}

/**
 * Tell the agents a request answers to that work on it has come back (Part
 * VIII: what the work finds goes to the request's keeper, who decides
 * whether it has been met, and to the Steward of each node it bears on,
 * who weighs it for that node). Every bears-on node's Steward gets a pass,
 * the keeper's told to judge the request and the others to weigh the work
 * for their node. A request the Curator keeps opens its curate:request row
 * (#722), the one route by which a request on several nodes or none can
 * wake it. `researchRunId` names the run whose full report and notebook
 * get_research_run serves to each of them; the note is the work as
 * recorded, never cut shorter (#718). True when anyone was told.
 */
export async function notifyRequestKeeper(
  requestId: string,
  note: string,
  opts: { researchRunId?: string | null } = {}
): Promise<boolean> {
  const [req] = await rawQuery<{ keeper_kind: string; keeper_claim_id: string | null; ask: string }>(
    `SELECT keeper_kind, keeper_claim_id, ask FROM requests WHERE id = $1`,
    [requestId]
  );
  if (!req) return false;
  const targets = await rawQuery<{ claim_id: string }>(
    `SELECT DISTINCT t.claim_id FROM request_targets t JOIN claims c ON c.id = t.claim_id
      WHERE t.request_id = $1 AND c.state = 'active'`,
    [requestId]
  );
  const named = `Request ${requestId} ("${req.ask.slice(0, 160)}")`;
  const where = opts.researchRunId
    ? ` The full report (findings with their evidence, sources, caveats, what would change it) and the run's notebook: get_research_run ${opts.researchRunId}.`
    : "";
  const keeper = req.keeper_kind === "steward" ? req.keeper_claim_id : null;
  let told = false;
  if (keeper) {
    await enqueueSteward({
      claimId: keeper,
      trigger: "request_returned",
      context: `${named}, which you keep: ${note}${where} Decide whether it has been met.`,
    });
    told = true;
  }
  for (const { claim_id } of targets) {
    if (claim_id === keeper) continue;
    await enqueueSteward({
      claimId: claim_id,
      trigger: "request_returned",
      context:
        `${named} bears on this node and is kept by ` +
        `${req.keeper_kind === "curator" ? "the Curator" : "another node's Steward"}: ${note}${where} ` +
        "Weigh what it found for this node; whether the request is met is its keeper's call.",
    });
    told = true;
  }
  if (req.keeper_kind === "curator") {
    const actionId = await ensureRequestCurateAction(requestId);
    if (actionId) {
      const { fundCurationNow } = await import("./maintenance-funding.js");
      await fundCurationNow(actionId);
      told = true;
    }
  }
  return told;
}

// ---------------------------------------------------------------------------
// Reads, in the shape the API serves (web/lib/types.ts RequestItem).
// ---------------------------------------------------------------------------

export interface RequestView {
  id: string;
  ask: string;
  why: string;
  satisfied_by: string;
  who_could: string | null;
  addressed_to: string | null;
  bears_on: { id: string; text: string; kind: NodeKind }[];
  bears_on_sources: { id: string; title: string; url: string | null }[];
  bears_on_text: string | null;
  filed_by: { kind: RequestFilerKind; label: string };
  keeper: { kind: "steward" | "curator"; label: string };
  state: RequestState;
  state_note: string | null;
  filed_at: Date;
  /** What doing it should cost, in USD; null until stated or quoted. */
  budget_usd: number | null;
  /**
   * Its standing on the action ledger: the row now open to funding (a
   * scoping pass, or the full work at its budget), what it costs and what
   * is behind it. Null when no row is open or running.
   */
  ledger: {
    action_id: string;
    variant: "scope" | "full";
    status: "open" | "running";
    cost_usd: number;
    backing_usd: number;
  } | null;
  /**
   * The work done on it. research_run_id names the Researcher's run, whose
   * full report and notebook get_research_run serves to the keeper and the
   * Stewards of what it bears on (#718); the public API leaves it out.
   * run_id is the agent run that did the work, which get_run and
   * list_run_steps read (they take either id). budget_usd and quote_usd
   * are set on a run of the full work: what it was funded at and what the
   * work was priced at then, and funding says so in words when the first
   * was below the second (#885), so a starved partial result can be told
   * from a real one.
   */
  work: {
    by: string;
    outcome: RequestOutcome | null;
    summary: string;
    at: Date;
    funded_by: string | null;
    research_run_id: string | null;
    run_id: string | null;
    budget_usd: number | null;
    quote_usd: number | null;
    funding: string | null;
  }[];
  /**
   * The accounts that have said they are taking the request up
   * (request-take-up-service.ts), each with what followed as the record
   * shows it. Such a statement is not work: it is listed here and not
   * above.
   */
  taken_up: TakenUp[];
}

interface RequestRowJoined {
  id: string;
  ask: string;
  why: string;
  satisfied_by: string;
  who_could: string | null;
  addressed_to: string | null;
  bears_on_text: string | null;
  filer_kind: RequestFilerKind;
  filer_agent: string | null;
  contributor_name: string | null;
  keeper_kind: "steward" | "curator";
  keeper_node_kind: NodeKind | null;
  state: RequestState;
  state_note: string | null;
  created_at: Date;
  budget_micro_usd: string | null;
}

const AGENT_LABELS: Record<string, string> = {
  claim_steward: "Claim Steward",
  question_steward: "Question Steward",
  curator: "Curator",
  reviewer: "Reviewer",
  consistency_checker: "Consistency Checker",
  researcher: "Researcher",
};

function filerLabel(r: RequestRowJoined): string {
  switch (r.filer_kind) {
    case "admin":
      return (r.filer_agent && AGENT_LABELS[r.filer_agent]) ?? r.filer_agent ?? "an administrator";
    case "contributor":
      return r.contributor_name ?? "a contributor";
    case "mandate":
      // §12/§19: the arrangement, never the party.
      return "a funded mandate";
  }
}

function keeperLabel(r: RequestRowJoined): string {
  if (r.keeper_kind === "curator") return "the Curator";
  return `the ${r.keeper_node_kind ?? "claim"}'s Steward`;
}

const REQUEST_SELECT = `
  SELECT r.id, r.ask, r.why, r.satisfied_by, r.who_could, r.addressed_to, r.bears_on_text,
         r.filer_kind, r.filer_agent, fc.display_name AS contributor_name,
         r.keeper_kind, kc.kind AS keeper_node_kind, r.state, r.state_note, r.created_at,
         r.budget_micro_usd
    FROM requests r
    LEFT JOIN contributors fc ON fc.id = r.filer_contributor_id
    LEFT JOIN claims kc ON kc.id = r.keeper_claim_id`;

async function assemble(rows: RequestRowJoined[]): Promise<RequestView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [nodes, sources, work, ledger] = await Promise.all([
    rawQuery<{ request_id: string; id: string; text: string; kind: NodeKind }>(
      `SELECT t.request_id, c.id, c.text, c.kind
         FROM request_targets t JOIN claims c ON c.id = t.claim_id
        WHERE t.request_id = ANY($1::uuid[]) ORDER BY t.id`,
      [ids]
    ),
    rawQuery<{ request_id: string; id: string; title: string; url: string | null }>(
      `SELECT t.request_id, s.id, s.title, s.url
         FROM request_targets t JOIN sources s ON s.id = t.source_id
        WHERE t.request_id = ANY($1::uuid[]) ORDER BY t.id`,
      [ids]
    ),
    rawQuery<{
      request_id: string;
      by_label: string;
      outcome: RequestOutcome | null;
      summary: string;
      created_at: Date;
      funded_by_job_id: string | null;
      research_run_id: string | null;
      run_id: string | null;
      budget_micro_usd: string | null;
      quote_micro_usd: string | null;
    }>(
      `SELECT w.request_id, w.by_label, w.outcome, w.summary, w.created_at, w.funded_by_job_id,
              w.research_run_id, rr.run_id, w.budget_micro_usd, w.quote_micro_usd
         FROM request_work w LEFT JOIN research_runs rr ON rr.id = w.research_run_id
        WHERE w.request_id = ANY($1::uuid[]) AND NOT w.taken_up ORDER BY w.created_at, w.id`,
      [ids]
    ),
    rawQuery<{
      request_id: string;
      id: string;
      variant: "scope" | "full";
      status: "open" | "running";
      cost: string;
      backing: string;
    }>(
      `SELECT a.target_ref AS request_id, a.id, a.variant, a.status,
              a.cost_est_micro_usd AS cost, ${COVERAGE_SQL} AS backing
         FROM actions a
        WHERE a.kind = 'request' AND a.target_ref = ANY($1::text[])
          AND a.status IN ('open', 'running')`,
      [ids]
    ),
  ]);
  const takenUp = await takenUpOn(ids);
  const jobIds = [...new Set(work.map((w) => w.funded_by_job_id).filter((j): j is string => !!j))];
  const fundingLabels = new Map<string, string | null>(
    await Promise.all(
      jobIds.map(async (j) => [j, (await getFundingLabelForJob(j))?.label ?? null] as const)
    )
  );
  const group = <T extends { request_id: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(x.request_id, [...(m.get(x.request_id) ?? []), x]);
    return m;
  };
  const nodesBy = group(nodes);
  const sourcesBy = group(sources);
  const workBy = group(work);
  const ledgerBy = new Map(ledger.map((l) => [l.request_id, l]));
  const usd = (micro: string | number) => Math.round(Number(micro) / 10_000) / 100;
  return rows.map((r) => ({
    id: r.id,
    ask: r.ask,
    why: r.why,
    satisfied_by: r.satisfied_by,
    who_could: r.who_could,
    addressed_to: r.addressed_to,
    bears_on: (nodesBy.get(r.id) ?? []).map(({ id, text, kind }) => ({ id, text, kind })),
    bears_on_sources: (sourcesBy.get(r.id) ?? []).map(({ id, title, url }) => ({ id, title, url })),
    bears_on_text: r.bears_on_text,
    filed_by: { kind: r.filer_kind, label: filerLabel(r) },
    keeper: { kind: r.keeper_kind, label: keeperLabel(r) },
    state: r.state,
    state_note: r.state_note,
    filed_at: r.created_at,
    budget_usd: r.budget_micro_usd == null ? null : usd(r.budget_micro_usd),
    ledger: (() => {
      const l = ledgerBy.get(r.id);
      return l
        ? { action_id: l.id, variant: l.variant, status: l.status, cost_usd: usd(l.cost), backing_usd: usd(l.backing) }
        : null;
    })(),
    work: (workBy.get(r.id) ?? []).map((w) => ({
      by: w.by_label,
      outcome: w.outcome,
      summary: w.summary,
      at: w.created_at,
      funded_by: w.funded_by_job_id ? (fundingLabels.get(w.funded_by_job_id) ?? null) : null,
      research_run_id: w.research_run_id ?? null,
      run_id: w.run_id ?? null,
      budget_usd: w.budget_micro_usd == null ? null : usd(w.budget_micro_usd),
      quote_usd: w.quote_micro_usd == null ? null : usd(w.quote_micro_usd),
      funding: underQuoteMark(
        w.budget_micro_usd == null ? null : Number(w.budget_micro_usd),
        w.quote_micro_usd == null ? null : Number(w.quote_micro_usd)
      ),
    })),
    taken_up: takenUp.get(r.id) ?? [],
  }));
}

/**
 * Whether a budget is below a quote, to the cent: a quote of $4.50 funded
 * at $4.50 is funded at its quote however the micro-dollars round.
 */
export function isUnderQuote(budgetMicroUsd: number | null, quoteMicroUsd: number | null): boolean {
  if (budgetMicroUsd == null || quoteMicroUsd == null || !(quoteMicroUsd > 0)) return false;
  return Math.round(budgetMicroUsd / 10_000) < Math.round(quoteMicroUsd / 10_000);
}

/**
 * How a run funded below what its work was priced at reads on the work log
 * (#885): "funded at $2.00 of a $5.00 quote". Null for a run funded at its
 * quote or above, and for work that carried no price.
 */
export function underQuoteMark(budgetMicroUsd: number | null, quoteMicroUsd: number | null): string | null {
  if (!isUnderQuote(budgetMicroUsd, quoteMicroUsd)) return null;
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
  return `funded at ${usd(budgetMicroUsd!)} of a ${usd(quoteMicroUsd!)} quote`;
}

/** One piece of work as a brief lists it: who, the outcome, the funding mark when under quote. */
export function workLabel(w: RequestView["work"][number]): string {
  const marks = [w.outcome, w.funding].filter(Boolean).join("; ");
  return `${w.by}${marks ? ` (${marks})` : ""}`;
}

/**
 * What the payer of a commission on a request's full work is told about its
 * quote (#885), by every path that commissions one (commissionAction): the
 * quote, plainly whether the budget is below it and what that means for the
 * run, and the earlier runs on the request that were funded below theirs,
 * with how each ended. It informs and refuses nothing: a commission's
 * budget is its payer's choice, a stage of a large request is a fair thing
 * to buy, and the quote is an estimate. What it stops is paying for a
 * starved run, or a third one, without knowing.
 */
export async function requestQuoteNote(input: {
  requestId: string;
  budgetMicroUsd: number;
  quoteMicroUsd: number;
}): Promise<{ underQuote: boolean; note: string }> {
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
  const earlier = await rawQuery<{ outcome: string | null; budget: string; quote: string }>(
    `SELECT outcome, budget_micro_usd AS budget, quote_micro_usd AS quote
       FROM request_work
      WHERE request_id = $1 AND outcome IS NOT NULL
        AND budget_micro_usd IS NOT NULL AND quote_micro_usd IS NOT NULL
      ORDER BY created_at, id`,
    [input.requestId]
  ).catch(() => []);
  const starved = earlier.filter((w) => isUnderQuote(Number(w.budget), Number(w.quote)));
  const history = starved.length
    ? ` ${starved.length === 1 ? "One earlier run" : `${starved.length} earlier runs`} on this request ${starved.length === 1 ? "was" : "were"} funded below ${starved.length === 1 ? "its" : "their"} quote: ` +
      starved.map((w) => `${usd(Number(w.budget))} of ${usd(Number(w.quote))} (${w.outcome})`).join(", ") +
      ". Another run below the quote is likely to end the same way; get_request shows what each left."
    : "";
  if (!isUnderQuote(input.budgetMicroUsd, input.quoteMicroUsd)) {
    return { underQuote: false, note: `The work is quoted at ${usd(input.quoteMicroUsd)}; this budget covers it.${history}` };
  }
  return {
    underQuote: true,
    note:
      `Below the quote: the work is quoted at ${usd(input.quoteMicroUsd)} and this commission gives it ${usd(input.budgetMicroUsd)}. ` +
      "It runs all the same, since the budget is yours to set, but the run is told it is funded below the quote and will do only the part of the plan this covers. " +
      `Its work is recorded on the request as "${underQuoteMark(input.budgetMicroUsd, input.quoteMicroUsd)}", and what it leaves needs a further commission.` +
      history,
  };
}

/**
 * The brief a run that takes up (or scopes) a request works from: the
 * request as filed, verbatim, and the work already done on it. Whoever
 * funded it adds nothing to it.
 */
export function requestBrief(request: RequestView): string {
  return [
    `Request ${request.id}`,
    `Asks for: ${request.ask}`,
    `Why: ${request.why}`,
    `What would satisfy it: ${request.satisfied_by}`,
    request.who_could ? `Who could do it: ${request.who_could}` : null,
    request.addressed_to ? `Addressed to: ${request.addressed_to}` : null,
    request.bears_on.length
      ? `Bears on: ${request.bears_on.map((n) => `${n.kind} ${n.id} ("${n.text}")`).join("; ")}`
      : null,
    request.bears_on_sources.length
      ? `Bears on sources: ${request.bears_on_sources.map((src) => `${src.title}${src.url ? ` (${src.url})` : ""}`).join("; ")}`
      : null,
    request.bears_on_text ? `Bears on, in words: ${request.bears_on_text}` : null,
    request.work.length
      ? `Work already done on it: ${request.work.map((w) => `${workLabel(w)}: ${w.summary}`).join(" | ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The document a request asks to have reviewed (#865): the one source it
 * bears on, when it bears on that source and on no node. A run that takes
 * such a request up examines the document for its own sake, and its
 * findings go on the document's page. A request that bears on a source and
 * on nodes too is about those nodes; one on several sources is not one
 * document's review. Null for every other request.
 */
export function documentUnderReview(
  request: Pick<RequestView, "bears_on" | "bears_on_sources">
): { id: string; title: string; url: string | null } | null {
  if (request.bears_on.length > 0 || request.bears_on_sources.length !== 1) return null;
  return request.bears_on_sources[0]!;
}

export async function getRequest(id: string): Promise<RequestView | null> {
  const rows = await rawQuery<RequestRowJoined>(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  return (await assemble(rows))[0] ?? null;
}

/**
 * Requests, newest first. `live` keeps the ones still open to work (open,
 * addressed, in progress); `claimId` keeps the ones that bear on that node.
 */
// The cosine similarity a request needs to match a query by meaning alone,
// the same floor claim search defaults to (claimSearchParams.min_similarity).
const REQUEST_MIN_SIMILARITY = 0.3;

export async function listRequests(opts: {
  state?: RequestState;
  live?: boolean;
  claimId?: string;
  /** Keep the ones that bear on this document. */
  sourceId?: string;
  /**
   * Who keeps it: the Curator (a request bearing on several nodes or on
   * none) or a node's Steward (#764), so the Curator can list what it keeps.
   */
  keeper?: "curator" | "steward";
  /**
   * A search over what requests ask and why: by meaning, and by keyword
   * (web-search syntax) for exact terms, ranked by meaning.
   */
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ items: RequestView[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.state) {
    params.push(opts.state);
    where.push(`r.state = $${params.length}`);
  } else if (opts.live) {
    where.push(`r.state IN ('open', 'addressed', 'in_progress')`);
  }
  if (opts.keeper) {
    params.push(opts.keeper);
    where.push(`r.keeper_kind = $${params.length}`);
  }
  if (opts.claimId) {
    params.push(opts.claimId);
    where.push(`EXISTS (SELECT 1 FROM request_targets t WHERE t.request_id = r.id AND t.claim_id = $${params.length})`);
  }
  if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`EXISTS (SELECT 1 FROM request_targets t WHERE t.request_id = r.id AND t.source_id = $${params.length})`);
  }
  // A search works as claim search does (search-service.ts): keyword OR
  // semantic match for recall, ranked by cosine similarity to the query,
  // keyword rank (the ask weighs most; see requests.text_search) and then
  // recency breaking ties. A request with no embedding ranks after every
  // scored one. Without an embedding of the query it falls back to keyword
  // matching, loudly. Without a query the list is simply newest first.
  let order = "r.created_at DESC, r.id";
  const q = opts.q?.trim();
  if (q) {
    params.push(q);
    const tsq = `websearch_to_tsquery('english', $${params.length})`;
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await generateEmbedding(q);
    } catch (err) {
      console.warn(
        `Request search embedding failed; falling back to keyword-only matching: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (queryEmbedding) {
      params.push(`[${queryEmbedding.join(",")}]`, REQUEST_MIN_SIMILARITY);
      const similarity = `1 - (r.embedding <=> $${params.length - 1}::vector)`;
      where.push(`(r.text_search @@ ${tsq} OR ${similarity} > $${params.length})`);
      order = `COALESCE(${similarity}, 0) DESC, ts_rank(r.text_search, ${tsq}) DESC, ${order}`;
    } else {
      where.push(await requestTextMatch("r", tsq));
      order = `ts_rank(r.text_search, ${tsq}) DESC, ${order}`;
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [count] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM requests r ${clause}`, params);
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  const rows = await rawQuery<RequestRowJoined>(
    `${REQUEST_SELECT} ${clause} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: await assemble(rows), total: count?.n ?? 0 };
}

/**
 * Why a request cannot bear on these ids. A node that was merged names its
 * survivor (#884), so the filer can address the request to it.
 */
async function noActiveNodeMessage(missing: string[]): Promise<string> {
  const merged = await mergedAliasRefusals(missing);
  const gone = missing.filter((id) => !merged.has(id));
  return [
    ...[...merged.values()].map((m) => m.message),
    ...(gone.length > 0 ? [`No active node ${gone.join(", ")}`] : []),
  ].join(" ");
}
