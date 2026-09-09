/**
 * Agent findings (#394): the channel every administrator has for saying, in
 * the graph's voice, something people who hold a question would be better
 * for knowing. The sibling of agent reports (report-service.ts) with the
 * same two commitments and one more:
 *
 *   - Fire-and-forget. noteFinding never throws. A validation problem, an
 *     embedding outage, a DB failure: all of it comes back as an
 *     acknowledgment, so the channel can never fail a run.
 *   - Cited by construction. A finding rests on the graph's record, so every
 *     ref is checked against the table it names before the row is written;
 *     an id that does not resolve is dropped and named to the agent, and a
 *     finding with no resolving ref is not recorded at all.
 *   - Matched before written. The same finding recurs across runs and across
 *     roles, and wording drifts, so an exact-title dedupe would mint
 *     paraphrases. Instead the finding is embedded and searched against every
 *     finding on record; a near match is shown to the agent and nothing is
 *     written until the agent answers with `joins` (a sighting) or
 *     `distinct_from` (a new finding, saying what the earlier lacks). The
 *     Matcher's match-or-create, applied to findings.
 *
 * Findings are public and published as written: the read side is the
 * unauthenticated /findings API and the findings page. There is no cap, no
 * kind, no triage queue; the restraint is in the prompt, and the operator's
 * only lever is `withdraw`.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { findingStatusEnum } from "../schemas/common.js";
import { generateEmbedding } from "./embedding-service.js";

export type FindingStatus = (typeof findingStatusEnum.options)[number];

/** The record kinds a finding may cite, and the table each resolves in. */
export const FINDING_REF_KINDS = [
  "claim",
  "assessment",
  "argument",
  "contribution",
  "lean_check",
  "proof_attempt",
  "formalization",
] as const;
export type FindingRefKind = (typeof FINDING_REF_KINDS)[number];

const REF_TABLES: Record<FindingRefKind, string> = {
  claim: "claims",
  assessment: "assessments",
  argument: "arguments",
  contribution: "contributions",
  lean_check: "lean_checks",
  proof_attempt: "proof_attempts",
  formalization: "claim_formalizations",
};

export interface FindingRef {
  kind: FindingRefKind;
  id: string;
}

/** Write-time caps: a finding is a record, not an essay. */
export const FINDING_HEADLINE_MAX_CHARS = 300;
export const FINDING_ACCOUNT_MAX_CHARS = 6000;
export const FINDING_MAX_REFS = 20;
/** How many near matches the tool shows before writing. */
export const FINDING_MATCH_CANDIDATES = 3;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/** Embedding text: the headline carries the identity, the account the detail. */
export function findingEmbeddingText(headline: string, account: string): string {
  return `${headline.trim()}\n\n${account.trim()}`.slice(0, 4000);
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

export interface NoteFindingInput {
  headline: string;
  account: string;
  claimId: string;
  refs: unknown;
  importance: unknown;
  /** Second call: the finding on record this one is a sighting of. */
  joins?: string | null;
  /** Second call: the findings on record this one is not. */
  distinctFrom?: unknown;
  agent: string;
  model?: string | null;
  runId?: string | null;
  jobId?: string | null;
  skills?: string[] | null;
}

export interface FindingMatch {
  id: string;
  headline: string;
  claim_id: string;
  agent: string;
  importance: number;
  sighting_count: number;
  first_noted_at: string;
  similarity: number;
  same_claim: boolean;
}

export type NoteFindingResult =
  | {
      outcome: "recorded";
      findingId: string;
      droppedRefs: FindingRef[];
    }
  | {
      outcome: "joined";
      findingId: string;
      sightingCount: number;
      droppedRefs: FindingRef[];
    }
  | { outcome: "possible_duplicate"; matches: FindingMatch[] }
  | { outcome: "not_recorded"; problem: string };

class FindingValidationError extends Error {}

/**
 * Parse the refs the agent passed: an array of {kind, id}. Malformed entries
 * are dropped here (shape problems) and reported back; existence is checked
 * separately, against the database.
 */
export function parseFindingRefs(raw: unknown): {
  refs: FindingRef[];
  malformed: number;
} {
  if (!Array.isArray(raw)) return { refs: [], malformed: raw == null ? 0 : 1 };
  const refs: FindingRef[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  for (const entry of raw) {
    if (refs.length >= FINDING_MAX_REFS) break;
    if (!entry || typeof entry !== "object") {
      malformed++;
      continue;
    }
    const kind = String((entry as { kind?: unknown }).kind ?? "").trim();
    const id = uuidOrNull((entry as { id?: unknown }).id);
    if (!(FINDING_REF_KINDS as readonly string[]).includes(kind) || !id) {
      malformed++;
      continue;
    }
    const key = `${kind}:${id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: kind as FindingRefKind, id });
  }
  return { refs, malformed };
}

/** Split refs into those that exist in the table their kind names and those that do not. */
export async function resolveFindingRefs(
  refs: FindingRef[]
): Promise<{ resolved: FindingRef[]; dropped: FindingRef[] }> {
  const resolved: FindingRef[] = [];
  const dropped: FindingRef[] = [];
  const byKind = new Map<FindingRefKind, FindingRef[]>();
  for (const ref of refs) {
    const list = byKind.get(ref.kind) ?? [];
    list.push(ref);
    byKind.set(ref.kind, list);
  }
  for (const [kind, list] of byKind) {
    const rows = await rawQuery<{ id: string }>(
      `SELECT id FROM ${REF_TABLES[kind]} WHERE id = ANY($1::uuid[])`,
      [list.map((r) => r.id)]
    );
    const found = new Set(rows.map((r) => r.id.toLowerCase()));
    for (const ref of list) {
      (found.has(ref.id.toLowerCase()) ? resolved : dropped).push(ref);
    }
  }
  return { resolved, dropped };
}

function validate(input: NoteFindingInput): {
  headline: string;
  account: string;
  claimId: string;
  importance: number;
  agent: string;
} {
  const headline = String(input.headline ?? "").trim();
  if (!headline) throw new FindingValidationError("headline is required");
  const account = String(input.account ?? "").trim();
  if (!account) throw new FindingValidationError("account is required");
  const claimId = uuidOrNull(input.claimId);
  if (!claimId) throw new FindingValidationError("claim_id must be a claim id");
  const importance = Number(input.importance);
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    throw new FindingValidationError("importance must be an integer from 1 to 10");
  }
  const agent = String(input.agent ?? "").trim();
  if (!agent) throw new FindingValidationError("agent is required");
  return {
    headline: headline.slice(0, FINDING_HEADLINE_MAX_CHARS),
    account: account.slice(0, FINDING_ACCOUNT_MAX_CHARS),
    claimId,
    importance,
    agent: agent.slice(0, 64),
  };
}

/**
 * The match-before-write search: every published finding by cosine
 * similarity of headline + account, with the lower same-claim bar applied
 * to candidates on the finding's own claim.
 */
export async function findNearFindings(
  embedding: number[],
  claimId: string,
  opts: { exclude?: string[] } = {}
): Promise<FindingMatch[]> {
  const config = loadConfig();
  const rows = await rawQuery<{
    id: string;
    headline: string;
    claim_id: string;
    agent: string;
    importance: number;
    sighting_count: number;
    first_noted_at: Date;
    similarity: number;
  }>(
    `SELECT id, headline, claim_id, agent, importance, sighting_count,
            first_noted_at,
            1 - (embedding <=> $1::vector) AS similarity
       FROM agent_findings
      WHERE status = 'published'
        AND embedding IS NOT NULL
        AND NOT (id = ANY($5::uuid[]))
        AND (1 - (embedding <=> $1::vector) >= $2
             OR (claim_id = $3 AND 1 - (embedding <=> $1::vector) >= $4))
      ORDER BY similarity DESC
      LIMIT ${FINDING_MATCH_CANDIDATES}`,
    [
      toVectorLiteral(embedding),
      config.findingMatchSimilarity,
      claimId,
      config.findingMatchSimilaritySameClaim,
      opts.exclude ?? [],
    ]
  );
  return rows.map((r) => ({
    id: r.id,
    headline: r.headline,
    claim_id: r.claim_id,
    agent: r.agent,
    importance: Number(r.importance),
    sighting_count: Number(r.sighting_count),
    first_noted_at: iso(r.first_noted_at) ?? "",
    similarity: Number(r.similarity),
    same_claim: r.claim_id === claimId,
  }));
}

/**
 * Record a finding. Never throws; see the file header for the three
 * commitments this enforces.
 */
export async function noteFinding(input: NoteFindingInput): Promise<NoteFindingResult> {
  try {
    const v = validate(input);
    const parsed = parseFindingRefs(input.refs);
    const { resolved, dropped } = await resolveFindingRefs(parsed.refs);
    if (resolved.length === 0) {
      return {
        outcome: "not_recorded",
        problem:
          parsed.refs.length === 0 && parsed.malformed === 0
            ? "refs is required: a finding must rest on the graph's record"
            : "none of the refs resolve to a record, and a finding must rest on the graph's record",
      };
    }

    // Second call, joining a finding on record: a sighting, no new row.
    const joins = uuidOrNull(input.joins);
    if (joins) {
      const rows = await rawQuery<{ id: string; sighting_count: number }>(
        `UPDATE agent_findings
            SET sighting_count = sighting_count + 1,
                last_noted_at = now()
          WHERE id = $1 AND status = 'published'
          RETURNING id, sighting_count`,
        [joins]
      );
      const row = rows[0];
      if (!row) {
        return {
          outcome: "not_recorded",
          problem: `joins names no published finding (${joins})`,
        };
      }
      await rawQuery(
        `INSERT INTO agent_finding_sightings
           (finding_id, account, refs, importance, agent, model, run_id, job_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.id,
          v.account,
          JSON.stringify(resolved),
          v.importance,
          v.agent,
          input.model ?? null,
          uuidOrNull(input.runId),
          uuidOrNull(input.jobId),
        ]
      );
      return {
        outcome: "joined",
        findingId: row.id,
        sightingCount: Number(row.sighting_count),
        droppedRefs: dropped,
      };
    }

    // The match-before-write search. An embedding failure is not the
    // agent's problem: the finding is recorded without one and without the
    // search, and a later sweep can embed it.
    let embedding: number[] | null = null;
    try {
      embedding = await generateEmbedding(findingEmbeddingText(v.headline, v.account));
    } catch (err) {
      console.error(
        "[findings] embedding failed; recording without a match search:",
        err instanceof Error ? err.message : String(err)
      );
    }

    const distinctFrom = Array.isArray(input.distinctFrom)
      ? input.distinctFrom.map(uuidOrNull).filter((id): id is string => !!id)
      : [];

    if (embedding) {
      const matches = await findNearFindings(embedding, v.claimId, { exclude: distinctFrom });
      if (matches.length > 0) {
        return { outcome: "possible_duplicate", matches };
      }
    }

    const rows = await rawQuery<{ id: string }>(
      `INSERT INTO agent_findings
         (headline, account, claim_id, refs, importance, embedding, agent,
          model, run_id, job_id, skills)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        v.headline,
        v.account,
        v.claimId,
        JSON.stringify(resolved),
        v.importance,
        embedding ? toVectorLiteral(embedding) : null,
        v.agent,
        input.model ?? null,
        uuidOrNull(input.runId),
        uuidOrNull(input.jobId),
        input.skills ?? null,
      ]
    );
    const row = rows[0];
    if (!row) {
      return { outcome: "not_recorded", problem: "the finding was not persisted" };
    }
    return { outcome: "recorded", findingId: row.id, droppedRefs: dropped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof FindingValidationError)) {
      console.error("[findings] failed to record finding:", message);
    }
    return {
      outcome: "not_recorded",
      problem:
        err instanceof FindingValidationError
          ? message
          : "the finding could not be persisted right now",
    };
  }
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

export interface AgentFindingRow {
  id: string;
  headline: string;
  account: string;
  claim_id: string;
  claim_text: string | null;
  refs: FindingRef[];
  importance: number;
  agent: string;
  model: string | null;
  run_id: string | null;
  skills: string[] | null;
  status: string;
  withdrawn_note: string | null;
  sighting_count: number;
  first_noted_at: Date;
  last_noted_at: Date;
  /**
   * True when the finding cites an assessment that is no longer the claim's
   * current one: the graph has moved since the note was written. Computed
   * at read time, never stored.
   */
  stale: boolean;
}

const FINDING_SELECT = `
  SELECT f.id, f.headline, f.account, f.claim_id, c.text AS claim_text,
         f.refs, f.importance, f.agent, f.model, f.run_id, f.skills,
         f.status, f.withdrawn_note, f.sighting_count,
         f.first_noted_at, f.last_noted_at,
         EXISTS (
           SELECT 1 FROM jsonb_array_elements(f.refs) r
             JOIN assessments a ON a.id = (r->>'id')::uuid
            WHERE r->>'kind' = 'assessment' AND a.is_current = false
         ) AS stale
    FROM agent_findings f
    JOIN claims c ON c.id = f.claim_id`;

export interface ListFindingsParams {
  claimId?: string;
  status?: string;
  minImportance?: number;
  /** Findings on claims carrying this tag slug (through the claim's taggings). */
  tag?: string;
  since?: Date;
  limit?: number;
  offset?: number;
  /** 'recent' (default) or 'importance'. */
  order?: "recent" | "importance";
}

export async function listFindings(
  params: ListFindingsParams = {}
): Promise<AgentFindingRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (clause: (n: number) => string, value: unknown) => {
    values.push(value);
    conditions.push(clause(values.length));
  };
  add((n) => `f.status = $${n}`, params.status ?? "published");
  if (params.claimId) add((n) => `f.claim_id = $${n}`, params.claimId);
  if (typeof params.minImportance === "number") {
    add((n) => `f.importance >= $${n}`, params.minImportance);
  }
  if (params.since) add((n) => `f.last_noted_at >= $${n}`, params.since);
  if (params.tag) {
    add(
      (n) => `EXISTS (
        SELECT 1 FROM taggings tg JOIN tags t ON t.id = tg.tag_id
         WHERE tg.subject_kind = 'claim' AND tg.subject_id = f.claim_id
           AND (t.slug = $${n} OR t.merged_into IN (SELECT id FROM tags WHERE slug = $${n})))`,
      params.tag
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order =
    params.order === "importance"
      ? "ORDER BY f.importance DESC, f.last_noted_at DESC"
      : "ORDER BY f.last_noted_at DESC";
  const limit = Math.max(1, Math.min(100, params.limit ?? 20));
  const offset = Math.max(0, params.offset ?? 0);
  values.push(limit, offset);
  return rawQuery<AgentFindingRow>(
    `${FINDING_SELECT} ${where} ${order}
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
}

export async function getFindingById(id: string): Promise<AgentFindingRow | null> {
  const rows = await rawQuery<AgentFindingRow>(`${FINDING_SELECT} WHERE f.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface FindingSightingRow {
  id: string;
  account: string;
  refs: FindingRef[];
  importance: number | null;
  agent: string;
  model: string | null;
  noted_at: Date;
}

export async function listFindingSightings(findingId: string): Promise<FindingSightingRow[]> {
  return rawQuery<FindingSightingRow>(
    `SELECT id, account, refs, importance, agent, model, noted_at
       FROM agent_finding_sightings
      WHERE finding_id = $1
      ORDER BY noted_at ASC`,
    [findingId]
  );
}

/**
 * The operator's one lever: take a note off the page, keeping the row so
 * the id still resolves and the reason is on record. Restoring is the same
 * call with status 'published'.
 */
export async function setFindingStatus(
  id: string,
  status: FindingStatus,
  note: string | null
): Promise<AgentFindingRow | null> {
  const parsed = findingStatusEnum.parse(status);
  const rows = await rawQuery<{ id: string }>(
    `UPDATE agent_findings
        SET status = $2,
            withdrawn_note = CASE WHEN $2 = 'withdrawn' THEN $3 ELSE NULL END
      WHERE id = $1
      RETURNING id`,
    [id, parsed, note?.trim() ? note.trim().slice(0, 2000) : null]
  );
  if (!rows[0]) return null;
  return getFindingById(id);
}

function iso(d: Date | string | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : d ? String(d) : null;
}

/** Wire shape for the API and the claim context: snake_case, ISO dates. */
export function formatFinding(row: AgentFindingRow): Record<string, unknown> {
  return {
    id: row.id,
    headline: row.headline,
    account: row.account,
    claim_id: row.claim_id,
    claim_text: row.claim_text,
    refs: Array.isArray(row.refs) ? row.refs : [],
    importance: Number(row.importance),
    agent: row.agent,
    model: row.model,
    skills: row.skills ?? [],
    status: row.status,
    withdrawn_note: row.withdrawn_note,
    sighting_count: Number(row.sighting_count),
    first_noted_at: iso(row.first_noted_at),
    last_noted_at: iso(row.last_noted_at),
    stale: row.stale === true,
  };
}

export function formatFindingSighting(row: FindingSightingRow): Record<string, unknown> {
  return {
    id: row.id,
    account: row.account,
    refs: Array.isArray(row.refs) ? row.refs : [],
    importance: row.importance == null ? null : Number(row.importance),
    agent: row.agent,
    model: row.model,
    noted_at: iso(row.noted_at),
  };
}
