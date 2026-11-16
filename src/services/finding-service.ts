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
 *   - Searchable before written. The same finding recurs across runs and
 *     roles, and wording drifts, so agents search the findings on record by
 *     meaning (searchFindings, the search_findings tool) and pass `joins`
 *     when theirs is one already noted: a sighting, not a new row.
 *
 * Findings are public and published as written: the read side is the
 * unauthenticated /findings API and the findings page. There is no cap, no
 * kind, no triage queue; the restraint is in the prompt, and the operator's
 * only lever is `withdraw`.
 */
import { rawQuery } from "../db/client.js";
import { markSeveralInForce } from "./judgment-version-service.js";
import { currentLabel } from "../llm/usage-context.js";
import { findingStatusEnum } from "../schemas/common.js";
import { generateEmbedding } from "./embedding-service.js";

export type FindingStatus = (typeof findingStatusEnum.options)[number];

/** The record kinds a finding may cite, and the table each resolves in. */
export const FINDING_REF_KINDS = [
  "claim",
  "assessment",
  "question_assessment",
  "quantity_estimate",
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
  question_assessment: "question_assessments",
  quantity_estimate: "quantity_estimates",
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
/** How many findings a search returns by default, and at most. */
export const FINDING_SEARCH_DEFAULT_LIMIT = 5;
export const FINDING_SEARCH_MAX_LIMIT = 20;

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
  /** The finding on record this one is a sighting of. */
  joins?: string | null;
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
 * Search the published findings by meaning: the query's embedding against
 * each finding's headline and account, closest first, optionally limited to
 * one node. No threshold: the agent reads the headlines and judges.
 */
export async function searchFindings(input: {
  query: string;
  claimId?: string | null;
  limit?: number;
}): Promise<FindingMatch[]> {
  const query = input.query.trim();
  if (!query) return [];
  const limit = Math.min(
    FINDING_SEARCH_MAX_LIMIT,
    Math.max(1, Math.floor(Number(input.limit) || FINDING_SEARCH_DEFAULT_LIMIT))
  );
  const claimId = uuidOrNull(input.claimId);
  const embedding = await generateEmbedding(query.slice(0, 4000));
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
        AND ($2::uuid IS NULL OR claim_id = $2::uuid)
      ORDER BY similarity DESC
      LIMIT $3`,
    [toVectorLiteral(embedding), claimId, limit]
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

    // Joining a finding on record: a sighting, no new row.
    const joins = uuidOrNull(input.joins);
    if (joins) {
      // The finding's own count moves only for a sighting at the finding's
      // label: a finding at another label is not this work's to change
      // (db/clearance.ts). Such a sighting is still recorded, below, as a
      // row at this work's label.
      const rows = await rawQuery<{ id: string; sighting_count: number }>(
        `UPDATE agent_findings
            SET sighting_count = sighting_count + 1,
                last_noted_at = now()
          WHERE id = $1 AND status = 'published' AND sensitivity_label = $2
          RETURNING id, sighting_count`,
        [joins, currentLabel()]
      );
      const row =
        rows[0] ??
        (
          await rawQuery<{ id: string; sighting_count: number }>(
            `SELECT id, sighting_count FROM agent_findings
              WHERE id = $1 AND status = 'published' AND sensitivity_label <> $2`,
            [joins, currentLabel()]
          )
        )[0];
      if (!row) {
        return {
          outcome: "not_recorded",
          problem: `joins names no published finding (${joins})`,
        };
      }
      await rawQuery(
        `INSERT INTO agent_finding_sightings
           (finding_id, account, refs, importance, agent, model, run_id, job_id, sensitivity_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.id,
          v.account,
          JSON.stringify(resolved),
          v.importance,
          v.agent,
          input.model ?? null,
          uuidOrNull(input.runId),
          uuidOrNull(input.jobId),
          // The sighting is the run's that met the finding again; the
          // finding keeps the label it was noted at.
          currentLabel(),
        ]
      );
      return {
        outcome: "joined",
        findingId: row.id,
        sightingCount: Number(row.sighting_count),
        droppedRefs: dropped,
      };
    }

    // The embedding makes the finding searchable. An embedding failure is
    // not the agent's problem: the finding is recorded without one, and a
    // later sweep can embed it.
    let embedding: number[] | null = null;
    try {
      embedding = await generateEmbedding(findingEmbeddingText(v.headline, v.account));
    } catch (err) {
      console.error(
        "[findings] embedding failed; recording without one:",
        err instanceof Error ? err.message : String(err)
      );
    }

    const rows = await rawQuery<{ id: string }>(
      `INSERT INTO agent_findings
         (headline, account, claim_id, refs, importance, embedding, agent,
          model, run_id, job_id, skills, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10, $11, $12)
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
        // The label of the run that notes it (src/labels.ts).
        currentLabel(),
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
  /** The topics of the claim the finding is about, by name. */
  tags: Array<{ slug: string; name: string }> | null;
  /**
   * True when the finding cites an assessment, a question's standing or a
   * quantity's estimate that is no longer the node's current one: the graph
   * has moved since the note was written. Computed at read time, never stored.
   */
  stale: boolean;
}

const FINDING_SELECT = `
  SELECT f.id, f.headline, f.account, f.claim_id, c.text AS claim_text,
         f.refs, f.importance, f.agent, f.model, f.run_id, f.skills,
         f.status, f.withdrawn_note, f.sighting_count,
         f.first_noted_at, f.last_noted_at,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', t.slug, 'name', t.name)
                                    ORDER BY t.name), '[]'::jsonb)
            FROM taggings tg JOIN tags t ON t.id = tg.tag_id
           WHERE tg.subject_kind = 'claim' AND tg.subject_id = f.claim_id
             AND t.merged_into IS NULL) AS tags,
         EXISTS (
           SELECT 1 FROM jsonb_array_elements(f.refs) r
            WHERE (r->>'kind' = 'assessment' AND EXISTS (
                    SELECT 1 FROM assessments a
                     WHERE a.id = (r->>'id')::uuid AND a.is_current = false))
               OR (r->>'kind' = 'question_assessment' AND EXISTS (
                    SELECT 1 FROM question_assessments qa
                     WHERE qa.id = (r->>'id')::uuid AND qa.is_current = false))
               OR (r->>'kind' = 'quantity_estimate' AND EXISTS (
                    SELECT 1 FROM quantity_estimates qe
                     WHERE qe.id = (r->>'id')::uuid AND qe.is_current = false))
         ) AS stale
    FROM agent_findings f
    JOIN claims c ON c.id = f.claim_id`;

const FINDING_FROM = `
    FROM agent_findings f
    JOIN claims c ON c.id = f.claim_id`;

/** What narrows the findings list. Every filter is optional and they combine. */
export interface FindingFilters {
  claimId?: string;
  status?: string;
  minImportance?: number;
  /** Findings on claims carrying this tag slug (through the claim's taggings). */
  tag?: string;
  since?: Date;
  /** Findings noted by any of these agents, by the name each run recorded. */
  agents?: string[];
  /** Findings on claims whose assessment in force has this status. */
  claimStatus?: string;
  /**
   * Words to search by: a finding matches when its headline, its account or
   * its claim's text has the words, or when it is close to them in meaning.
   */
  q?: string;
}

export interface ListFindingsParams extends FindingFilters {
  limit?: number;
  offset?: number;
  /**
   * 'recent' (default), 'importance', or 'relevance': closest in meaning to
   * `q` first, which is 'recent' when there is no `q` or no embedding of it.
   */
  order?: "recent" | "importance" | "relevance";
}

/** A search must be at least this close in meaning to match without the words. */
const FINDING_SEARCH_MIN_SIMILARITY = 0.3;

type FilterKey = "agents" | "claimStatus" | "tag" | "minImportance";

/**
 * The WHERE clause for a set of filters, leaving out the one named in
 * `without`: a facet counts what each of its values would leave, so it is
 * counted under every filter but its own.
 */
function findingWhere(
  filters: FindingFilters,
  embedding: number[] | null,
  without?: FilterKey
): { where: string; values: unknown[]; embeddingAt: number | null } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (clause: (n: number) => string, value: unknown) => {
    values.push(value);
    conditions.push(clause(values.length));
  };
  add((n) => `f.status = $${n}`, filters.status ?? "published");
  if (filters.claimId) add((n) => `f.claim_id = $${n}`, filters.claimId);
  if (typeof filters.minImportance === "number" && without !== "minImportance") {
    add((n) => `f.importance >= $${n}`, filters.minImportance);
  }
  if (filters.since) add((n) => `f.last_noted_at >= $${n}`, filters.since);
  if (filters.tag && without !== "tag") {
    add(
      (n) => `EXISTS (
        SELECT 1 FROM taggings tg JOIN tags t ON t.id = tg.tag_id
         WHERE tg.subject_kind = 'claim' AND tg.subject_id = f.claim_id
           AND (t.slug = $${n} OR t.merged_into IN (SELECT id FROM tags WHERE slug = $${n})))`,
      filters.tag
    );
  }
  if (filters.agents && filters.agents.length > 0 && without !== "agents") {
    add((n) => `f.agent = ANY($${n}::text[])`, filters.agents);
  }
  if (filters.claimStatus && without !== "claimStatus") {
    add(
      // Any judgment in force for the reader: where two are (labels that do
      // not read each other), the finding is found under either's status
      // and neither is chosen. One is in force everywhere else.
      (n) => `EXISTS (
        SELECT 1 FROM assessments_versions a
         WHERE a.claim_id = f.claim_id AND a.in_force AND a.status = $${n})`,
      filters.claimStatus
    );
  }
  let embeddingAt: number | null = null;
  const q = filters.q?.trim();
  if (q) {
    values.push(q);
    const words = `to_tsvector('english', f.headline || ' ' || f.account || ' ' || c.text)
                   @@ websearch_to_tsquery('english', $${values.length})`;
    if (embedding) {
      values.push(toVectorLiteral(embedding));
      embeddingAt = values.length;
      values.push(FINDING_SEARCH_MIN_SIMILARITY);
      conditions.push(
        `(${words} OR (f.embedding IS NOT NULL
            AND 1 - (f.embedding <=> $${embeddingAt}::vector) > $${values.length}))`
      );
    } else {
      conditions.push(`(${words})`);
    }
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
    embeddingAt,
  };
}

/**
 * The embedding of a search, or null when there is none to make. A failure
 * to embed leaves the search to the words alone; it does not fail the list.
 */
async function searchEmbedding(q: string | undefined): Promise<number[] | null> {
  const query = q?.trim();
  if (!query) return null;
  try {
    return await generateEmbedding(query.slice(0, 4000));
  } catch {
    return null;
  }
}

function clampPage(params: ListFindingsParams): { limit: number; offset: number } {
  return {
    limit: Math.max(1, Math.min(100, params.limit ?? 20)),
    offset: Math.max(0, params.offset ?? 0),
  };
}

async function selectFindings(
  params: ListFindingsParams,
  embedding: number[] | null
): Promise<AgentFindingRow[]> {
  const { where, values, embeddingAt } = findingWhere(params, embedding);
  const order =
    params.order === "importance"
      ? "ORDER BY f.importance DESC, f.last_noted_at DESC"
      : params.order === "relevance" && embeddingAt !== null
        ? `ORDER BY COALESCE(1 - (f.embedding <=> $${embeddingAt}::vector), 0) DESC,
                    f.last_noted_at DESC`
        : "ORDER BY f.last_noted_at DESC";
  const { limit, offset } = clampPage(params);
  values.push(limit, offset);
  return rawQuery<AgentFindingRow>(
    `${FINDING_SELECT} ${where} ${order}
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
}

export async function listFindings(
  params: ListFindingsParams = {}
): Promise<AgentFindingRow[]> {
  return selectFindings(params, await searchEmbedding(params.q));
}

/**
 * What each value of a filter would leave, counted under the other filters
 * in force: the numbers a reader sees beside the choices on the findings
 * page. Tags are the commonest dozen; the page links to the full vocabulary.
 * A finding whose claim has two judgments in force for the reader is counted
 * under the status of each, which is what choosing that status then lists.
 */
export interface FindingFacets {
  agents: Array<{ agent: string; count: number }>;
  claim_statuses: Array<{ status: string; count: number }>;
  tags: Array<{ slug: string; name: string; count: number }>;
  importance: Array<{ importance: number; count: number }>;
}

const FACET_TAGS = 12;

async function findingFacets(
  filters: FindingFilters,
  embedding: number[] | null
): Promise<FindingFacets> {
  const under = (without: FilterKey) => findingWhere(filters, embedding, without);
  const agents = under("agents");
  const statuses = under("claimStatus");
  const tags = under("tag");
  const importance = under("minImportance");
  const [agentRows, statusRows, tagRows, importanceRows] = await Promise.all([
    rawQuery<{ agent: string; count: string }>(
      `SELECT f.agent, count(*) AS count ${FINDING_FROM} ${agents.where}
        GROUP BY f.agent ORDER BY count(*) DESC, f.agent`,
      agents.values
    ),
    rawQuery<{ status: string; count: string }>(
      `SELECT a.status, count(*) AS count ${FINDING_FROM}
         JOIN assessments_versions a ON a.claim_id = f.claim_id AND a.in_force
        ${statuses.where}
        GROUP BY a.status ORDER BY count(*) DESC, a.status`,
      statuses.values
    ),
    rawQuery<{ slug: string; name: string; count: string }>(
      `SELECT t.slug, t.name, count(*) AS count ${FINDING_FROM}
         JOIN taggings tg ON tg.subject_kind = 'claim' AND tg.subject_id = f.claim_id
         JOIN tags t ON t.id = tg.tag_id AND t.merged_into IS NULL
        ${tags.where}
        GROUP BY t.slug, t.name ORDER BY count(*) DESC, t.name
        LIMIT ${FACET_TAGS}`,
      tags.values
    ),
    rawQuery<{ importance: number; count: string }>(
      `SELECT f.importance, count(*) AS count ${FINDING_FROM} ${importance.where}
        GROUP BY f.importance ORDER BY f.importance`,
      importance.values
    ),
  ]);
  return {
    agents: agentRows.map((r) => ({ agent: r.agent, count: Number(r.count) })),
    claim_statuses: statusRows.map((r) => ({ status: r.status, count: Number(r.count) })),
    tags: tagRows.map((r) => ({ slug: r.slug, name: r.name, count: Number(r.count) })),
    importance: importanceRows.map((r) => ({
      importance: Number(r.importance),
      count: Number(r.count),
    })),
  };
}

/**
 * One page of the list with how many findings match in all and, when asked,
 * the facets. The search is embedded once and used for all of it.
 */
export async function findingsPage(
  params: ListFindingsParams & { facets?: boolean } = {}
): Promise<{ rows: AgentFindingRow[]; total: number; facets: FindingFacets | null }> {
  const embedding = await searchEmbedding(params.q);
  const counted = findingWhere(params, embedding);
  const [rows, totals, facets] = await Promise.all([
    selectFindings(params, embedding),
    rawQuery<{ count: string }>(
      `SELECT count(*) AS count ${FINDING_FROM} ${counted.where}`,
      counted.values
    ),
    params.facets ? findingFacets(params, embedding) : Promise.resolve(null),
  ]);
  return { rows, total: Number(totals[0]?.count ?? 0), facets };
}

/**
 * What a finding's cited assessments are of, for the finding's page: an
 * assessment is cited by id so the finding still points at what it rested on
 * after a reassessment, and a reader is owed its claim, its verdict as it was
 * written, and whether it is still the claim's current one. The other kinds
 * of ref are named by the page from what it already reads.
 */
export interface FindingAssessmentRef {
  id: string;
  claim_id: string;
  claim_text: string;
  status: string;
  confidence: number | null;
  /**
   * False once the claim has been assessed again at the label this was made
   * at. A judgment at another label does not replace it.
   */
  current: boolean;
  /** Present only where more than one judgment of the claim is in force for the asker (judgment-version-service.ts). */
  judgments_in_force?: number;
  judgments_in_force_note?: string;
}

export async function describeAssessmentRefs(refs: FindingRef[]): Promise<FindingAssessmentRef[]> {
  const ids = refs.filter((r) => r.kind === "assessment").map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await rawQuery<{
    id: string;
    claim_id: string;
    claim_text: string;
    status: string;
    confidence: string | number | null;
    current: boolean;
  }>(
    `SELECT a.id, a.claim_id, c.text AS claim_text, a.status, a.confidence,
            EXISTS (SELECT 1 FROM assessments_versions v WHERE v.id = a.id) AS current
       FROM assessments a
       JOIN claims c ON c.id = a.claim_id
      WHERE a.id = ANY($1::uuid[])`,
    [ids]
  );
  const described: FindingAssessmentRef[] = rows.map((r) => ({
    ...r,
    confidence: r.confidence == null ? null : Number(r.confidence),
    current: r.current === true,
  }));
  await markSeveralInForce(described, (r) => r.claim_id);
  return described;
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
    tags: Array.isArray(row.tags) ? row.tags : [],
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
