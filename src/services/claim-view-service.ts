/**
 * The one reading of a node that `get_claim` returns (#774), for every
 * caller: the graph's own agents (Stewards, Curator, Reviewer, Arbitrator,
 * Audit, Consistency Checker, Researcher, Grantmaker, Lookout) and MCP
 * clients. There used to be two tools named `get_claim` with different
 * payloads, so a skill shared across roles could not say what the tool
 * returned. Now there is one view, one description and one set of
 * `include` sections, and a caller asks for the sections its work needs.
 *
 * The base view is everything cheap enough to read on every call: the node
 * row, its current assessment, the kind's record, the formalization record,
 * the requests bearing on it, and counts. Sections that grow with the graph
 * (arguments, subclaims, instances, dependents, related links, findings,
 * check records) come only when asked for.
 */
import { waitingMessages } from "./inbox-service.js";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { getClaimById, getClaimInstances } from "./claim-service.js";
import { getCurrentAssessment } from "./assessment-service.js";
import {
  getArgumentsForClaim,
  getEvaluationStateForClaim,
  getRetiredArgumentsForClaim,
  hasWrittenForm,
} from "./argument-service.js";
import { getSubclaimCount, listClaimDependents } from "./tree-service.js";
import { getTagsForSubject } from "./tag-service.js";
import {
  getClaimFormalizationRecord,
  leanChecksByArgument,
  listLeanChecksForClaim,
} from "./formalization-service.js";
import { getQuantityDetail, getThresholdOf } from "./quantity-service.js";
import { getQuestionDetail } from "./question-service.js";
import { listRequests } from "./request-service.js";
import { countClaimInstances } from "./claim-instance-service.js";
import { listUnplacedPassages } from "./argument-instance-service.js";
import { getClaimSourceMap, getSourceMapSummary } from "./source-map-service.js";
import { listRelatedClaims } from "./claim-link-service.js";
import { listFindings } from "./finding-service.js";
import { developerDisclosure } from "../llm/model-developers.js";

/** The optional sections of the view, in the order the description gives them. */
export const CLAIM_VIEW_INCLUDES = [
  "arguments",
  "subclaims",
  "provenance",
  "dependents",
  "related",
  "findings",
  "proofs",
] as const;
export type ClaimViewInclude = (typeof CLAIM_VIEW_INCLUDES)[number];

/** A hub claim has hundreds of dependents; one page by importance is the default. */
export const DEFAULT_DEPENDENTS_PAGE = 25;
export const MAX_DEPENDENTS_PAGE = 100;
/** Findings are a courtesy list for the node's Steward, not an archive. */
const FINDINGS_LIMIT = 10;
/**
 * Requests bearing on one node, newest first, as GET /claims/:id serves them.
 * A tool result is context the reader carries for the rest of its session,
 * so the view shows one page; `requests_total` says when there are more
 * (list_requests with claim_id pages through all, where the reader has it).
 */
const REQUESTS_LIMIT = 20;

/** The tool description every surface shares (agents and MCP alike). */
export const CLAIM_VIEW_DESCRIPTION =
  "Open one node (a claim, a quantity or a question) as the graph records " +
  "it. Every read returns: `claim` (its `kind`, canonical form, type, " +
  "state, importance, contestation, tags, page_url, and Steward state: " +
  "`stewarded_at` null means no Steward has worked it yet, whatever " +
  "decomposition_status says); `assessment`, the current verdict with its " +
  "reasoning (a status, a confidence that the status is the right reading " +
  "of the evidence, and a credence that the claim is true where one number " +
  "is honest, else null, and `marginal_yield`, how much another pass " +
  "would add); the kind's record, since a quantity or a " +
  "question has no `assessment` (`quantity`: definition, the graph's " +
  "estimate with its work and marginal_yield, the figures sources state, " +
  "readings and cuts; `question`: standing with its confidence and " +
  "marginal_yield, answers, presuppositions, subquestions; " +
  "`threshold_of` on a claim that cuts a quantity); `preliminary_seed`, the " +
  "parent Steward's prior, only while the node is unassessed; the " +
  "formalization record (`formalization`, `formalization_pending`, " +
  "`formalization_history`, `verification`, `lean_checks`), null or empty " +
  "when there is none; `waiting_messages`, what has arrived for the node's " +
  "Steward since its last pass and has not yet been weighed (each with its " +
  "trigger, sender, date and the start of its text); `requests` bearing on the node (the newest " +
  `${REQUESTS_LIMIT}, with \`requests_total\` beside them); \`subclaim_count\`, ` +
  "`instance_count`, and `source_map` (the account of what the support " +
  "rests on). Contestation (how actively the claim is disputed, 0..1) is " +
  "not a status. Add sections with `include`: `arguments` (each with its " +
  "written form and current evaluation; as `retired_arguments` any " +
  "its Steward retired, with the reason; and as " +
  "`unplaced_argument_passages` passages where sources reason about the " +
  "claim that matched none of its arguments at ingestion), `subclaims` (the direct " +
  "subclaims, one row per argument each serves, with the edge's reasoning " +
  "and their standing and credence), " +
  "`provenance` (the instances with their readings, and the edges among " +
  "their sources), `dependents` (one page ranked by importance, with " +
  "`dependents_total`), `related` (lateral see-also links, never " +
  "dependencies, with their standing and credence), `findings` (the " +
  "newest findings already noted on the node, with `findings_note` when " +
  "there are more), " +
  "`proofs` (every Lean check record). Free.";

export const CLAIM_VIEW_INCLUDE_DESCRIPTION =
  "Sections to add to the base view; none by default. Ask for the ones " +
  "your work needs: each costs context.";

export interface ClaimViewOptions {
  include?: readonly string[];
  dependentsLimit?: number;
  dependentsOffset?: number;
}

function claimPageUrl(claimId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

export function formatClaimViewAssessment(
  a: {
    status: string;
    confidence: number;
    claimCredence: number | null;
    summary: string | null;
    reasoningTrace: string;
    assessedAt: Date;
    marginalYield?: number | null;
    model?: string | null;
  } | null
) {
  if (!a) return null;
  return {
    status: a.status,
    // Verdict confidence: how sure the Steward is of the status, not P(true).
    confidence: a.confidence,
    // Credence that the claim is true; null where one number would be false
    // precision (constitution §10).
    claim_credence: a.claimCredence ?? null,
    // Reader-facing body first; fall back to the trace for pre-split rows.
    summary: a.summary ?? a.reasoningTrace,
    reasoning_trace: a.reasoningTrace,
    // The Steward's exit judgment: how much another, stronger pass would
    // improve this assessment (0..1), so a re-pass sees the whole prior
    // judgment (#760). null when not stated.
    marginal_yield: a.marginalYield ?? null,
    assessed_at: a.assessedAt.toISOString(),
    // The assessor behind the verdict (#294); null for legacy rows.
    model: a.model ?? null,
  };
}

/**
 * Add the developer disclosure (#534) to a formatted assessment when the
 * claim names the developer of the model that assessed it. Absent otherwise,
 * as GET /claims/:id serves it.
 */
function withDeveloperDisclosure(
  formatted: ReturnType<typeof formatClaimViewAssessment>,
  model: string | null | undefined,
  claimText: string,
  tagNames: readonly string[]
) {
  if (!formatted) return formatted;
  const disclosure = developerDisclosure(model, claimText, tagNames);
  return disclosure ? { ...formatted, developer_disclosure: disclosure } : formatted;
}

function iso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : d;
}

/**
 * The view of one node, or null when no node has that id. A malformed id
 * throws the database's own error (22P02), which callers translate.
 */
export async function getClaimView(
  claimId: string,
  opts: ClaimViewOptions = {}
): Promise<Record<string, unknown> | null> {
  const claim = await getClaimById(claimId);
  if (!claim) return null;
  const include = new Set(opts.include ?? []);
  const kind = claim.kind ?? "claim";

  const [
    assessment,
    tags,
    formalizationRecord,
    quantity,
    thresholdOf,
    question,
    requests,
    subclaimCount,
    instanceCount,
    sourceMap,
    kindJudgment,
    waiting,
  ] = await Promise.all([
    getCurrentAssessment(claimId),
    // Navigation, never the payload: a tag read failure is an empty list.
    getTagsForSubject("claim", claimId).catch(() => []),
    // The formalization record (#435): the published statement, any draft or
    // reviewed version awaiting publication, every version's status, and the
    // newest checks. One cheap query for a claim with no statement.
    getClaimFormalizationRecord(claimId),
    // The kinds' records (constitution §2, §7a), as GET /claims/:id serves them.
    kind === "quantity" ? getQuantityDetail(claimId) : null,
    kind === "claim" ? getThresholdOf(claimId) : null,
    kind === "question" ? getQuestionDetail(claimId) : null,
    // Requests degrade to none rather than failing the read, as tags do.
    listRequests({ claimId, limit: REQUESTS_LIMIT }).catch(() => ({ items: [], total: 0 })),
    getSubclaimCount(claimId),
    // Detached instances never count.
    countClaimInstances(claimId),
    // The Steward's source map (#286): a claim-level summary, null until
    // written. A failure loses the map, never the read.
    getSourceMapSummary(claimId).catch(() => null),
    // A quantity's or question's own judgment fields beside its record: the
    // estimate's yield, and a question's confidence and yield (#755, #760).
    kindJudgmentFields(claimId, kind),
    // What is waiting for the node's Steward (inbox-service.ts). Shown so
    // readers and funders can see what the assessment has not yet weighed;
    // a read failure loses the list, never the read.
    waitingMessages(claimId).catch(() => []),
  ]);

  // Steward-seeded prior (#285): the hint the parent claim's Steward left
  // when it minted this node. Served only while the node has no current
  // assessment: once its own Steward has judged, the seed is history and
  // must not sit beside the verdict as a second opinion.
  const preliminarySeed =
    !assessment && (claim.seedCredence != null || claim.seedNote != null)
      ? {
          credence: claim.seedCredence,
          note: claim.seedNote,
          seeded_by_claim_id: claim.seedSourceClaimId,
        }
      : null;

  const payload: Record<string, unknown> = {
    claim: {
      id: claim.id,
      kind,
      canonical_form: claim.text,
      claim_type: claim.claimType,
      state: claim.state,
      decomposition_status: claim.decompositionStatus,
      importance: claim.importance,
      // How actively the claim is disputed or consulted (0..1), kept apart
      // from the status (#524). null = not yet judged.
      contestation: claim.contestation ?? null,
      domains: claim.domains ?? [],
      tags: tags.map((t) => ({ slug: t.slug, name: t.name })),
      // Whether a Steward has actually worked this node (#415).
      // decomposition_status flips to "complete" at onboarding, when the
      // node is handed to its Steward, so on its own it cannot tell "never
      // structured" from "structured and judged to need no children".
      // stewarded_at is null, and steward_state 'pending' or 'deferred',
      // until a Steward run has started; 'done' once one has finished.
      steward_state: claim.stewardState ?? null,
      stewarded_at: iso(claim.stewardedAt),
      // Why the canonical form runs in the direction it does (#360), so a
      // Steward improving the wording keeps the polarity every stance is
      // read against. Null for claims minted before the note existed.
      canonical_direction_note: claim.canonicalDirectionNote ?? null,
      created_at: iso(claim.createdAt),
      updated_at: iso(claim.updatedAt),
      page_url: claimPageUrl(claim.id),
    },
    assessment: withDeveloperDisclosure(
      formatClaimViewAssessment(assessment),
      assessment?.model,
      claim.text,
      tags.map((t) => t.name)
    ),
    ...(preliminarySeed ? { preliminary_seed: preliminarySeed } : {}),
    quantity: quantity ? { ...quantity, ...kindJudgment } : quantity,
    threshold_of: thresholdOf,
    question: question ? { ...question, ...kindJudgment } : question,
    ...formalizationRecord,
    waiting_messages: waiting,
    requests: requests.items.map((r) => ({
      ...r,
      // The Steward of the one node a request bears on keeps it.
      kept_by_this_node:
        r.keeper?.kind === "steward" &&
        r.bears_on?.length === 1 &&
        r.bears_on[0]!.id === claimId,
    })),
    requests_total: requests.total,
    subclaim_count: subclaimCount,
    // The instances themselves come with include: ["provenance"].
    instance_count: instanceCount,
    source_map: sourceMap,
  };

  const sections: Promise<void>[] = [];

  if (include.has("arguments")) {
    sections.push(
      (async () => {
        const [args, retired, evaluations, checks] = await Promise.all([
          getArgumentsForClaim(claimId),
          getRetiredArgumentsForClaim(claimId),
          getEvaluationStateForClaim(claimId),
          // The checker record behind a machine-checked argument (§2.3).
          leanChecksByArgument(claimId).catch(() => new Map()),
        ]);
        const evaluationByArgument = new Map(evaluations.map((e) => [e.argument_id, e]));
        payload.arguments = args.map((a) => {
          const e = evaluationByArgument.get(a.id);
          return {
            id: a.id,
            name: a.name,
            stance: a.stance,
            ...(a.shows ? { shows: a.shows } : {}),
            content: a.content,
            // False while content is still the creation-time label: the
            // Steward owes this argument a write_argument call (#129, #747).
            has_written_form: hasWrittenForm(a),
            evidence_urls: a.evidenceUrls,
            // The Steward's current judgment of the inference (#173); null
            // when never evaluated. `stale` means it was derived under an
            // assessment that is no longer current.
            evaluation:
              e && e.verdict != null
                ? { verdict: e.verdict, decisive: e.decisive, content: e.content, stale: e.stale }
                : null,
            lean_check: checks.get(a.id) ?? null,
          };
        });
        // Passages where sources reason about the claim that matched none
        // of its arguments at ingestion (#541), waiting for the Steward to
        // place or dismiss them.
        const unplaced = await listUnplacedPassages(claimId);
        if (unplaced.total > 0) {
          payload.unplaced_argument_passages = unplaced.items.map((p) => ({
            instance_id: p.id,
            source: { id: p.source_id, url: p.source_url, title: p.source_title },
            verbatim_text: p.verbatim_text,
            context: p.context,
            stance: p.stance,
            direction: p.direction,
          }));
          payload.unplaced_argument_passages_total = unplaced.total;
        }
        // Retired arguments (#741) are history: listed apart, by name and
        // reason, so a Steward does not rebuild one it or a predecessor
        // retired.
        if (retired.length > 0) {
          payload.retired_arguments = retired.map((a) => ({
            id: a.id,
            name: a.name,
            stance: a.stance,
            retired_at: iso(a.retiredAt),
            reason: a.retiredReason,
          }));
        }
      })()
    );
  }

  if (include.has("subclaims")) {
    sections.push(
      (async () => {
        const subclaims = await listDirectSubclaims(claimId);
        payload.subclaims = subclaims;
        // Derived from the rows, never a stored counter (#417): an edge
        // shared by two arguments is two rows but one child (#437).
        payload.subclaims_assessed = new Set(
          subclaims.filter((sc) => sc.assessment_status != null).map((sc) => sc.edge_id)
        ).size;
      })()
    );
  }

  if (include.has("provenance")) {
    sections.push(
      (async () => {
        // The instances, each with the reading recorded from opening its
        // source against the claim (#286), the edges from instances to the
        // documents they draw on, and the relations among those documents.
        const [instances, full] = await Promise.all([
          getClaimInstances(claimId),
          getClaimSourceMap(claimId).catch(() => null),
        ]);
        payload.instances = instances.map((inst) => ({
          ...inst,
          reading: full?.readings[inst.id] ?? null,
        }));
        payload.provenance_edges = full?.edges ?? [];
        payload.source_relationships = full?.source_relationships ?? [];
      })()
    );
  }

  if (include.has("dependents")) {
    sections.push(
      (async () => {
        // Paginated: a hub claim has hundreds. `dependents` stays an array;
        // `dependents_total` says how many there are in all.
        const limit = Math.min(
          MAX_DEPENDENTS_PAGE,
          Math.max(1, Math.floor(opts.dependentsLimit ?? DEFAULT_DEPENDENTS_PAGE))
        );
        const offset = Math.max(0, Math.floor(opts.dependentsOffset ?? 0));
        const { dependents, total } = await listClaimDependents(claimId, { limit, offset });
        payload.dependents = dependents;
        payload.dependents_total = total;
      })()
    );
  }

  if (include.has("related")) {
    sections.push(
      (async () => {
        // Lateral links (#436): claims a reader of this one would want beside
        // it, with the reason. Not dependencies; they never enter the assessment.
        payload.related = (await listRelatedClaims(claimId)).map((r) => ({
          id: r.id,
          text: r.text,
          link_kind: r.kind,
          reasoning: r.reasoning,
          assessment_status: r.assessment_status,
          assessment_confidence: r.assessment_confidence,
          // §21: rival explanations' credences must be jointly tenable.
          assessment_credence: r.assessment_credence,
        }));
      })()
    );
  }

  if (include.has("findings")) {
    sections.push(
      (async () => {
        // Findings already noted on this node (#394), one line each. The check
        // that prevents a repeat lives in note_finding itself; this list is
        // passive. `stale` marks a note whose cited assessment is no longer
        // current, so a reader knows the graph has moved since.
        const [findings, [findingTotal]] = await Promise.all([
          listFindings({ claimId, limit: FINDINGS_LIMIT }).catch(() => []),
          rawQuery<{ n: number }>(
            `SELECT count(*)::int AS n FROM agent_findings WHERE claim_id = $1 AND status = 'published'`,
            [claimId]
          ).catch(() => [undefined]),
        ]);
        // Say when the list is cut, and which tool reads the rest (#762).
        if ((findingTotal?.n ?? 0) > findings.length) {
          payload.findings_total = findingTotal!.n;
          payload.findings_note =
            `The ${findings.length} most recent of ${findingTotal!.n} findings on this node; ` +
            `search_findings with this claim_id reads the rest.`;
        }
        payload.findings = findings.map((f) => ({
          id: f.id,
          noted_at: iso(f.first_noted_at as Date | string | null),
          agent: f.agent,
          importance: Number(f.importance),
          sighting_count: Number(f.sighting_count),
          headline: f.headline,
          cites: (Array.isArray(f.refs) ? f.refs : []).map((r) => `${r.kind} ${r.id}`),
          ...(f.stale ? { stale: "cites an assessment that is no longer current" } : {}),
        }));
      })()
    );
  }

  if (include.has("proofs")) {
    sections.push(
      (async () => {
        // Every check the platform ran on any version of the statement:
        // verdict, mode, kind, gate, pin and hash, never the source.
        payload.proofs = await listLeanChecksForClaim(claimId);
      })()
    );
  }

  await Promise.all(sections);
  return payload;
}

/**
 * The judgment fields a quantity's estimate or a question's standing carries
 * beside the kind's record (#755): the Steward's marginal_yield on both, and
 * on a question its confidence in the standing. Empty for a claim, whose
 * assessment carries them, and on a failed read.
 */
async function kindJudgmentFields(
  claimId: string,
  kind: string
): Promise<Record<string, number | null>> {
  if (kind === "quantity") {
    const [row] = await rawQuery<{ marginal_yield: number | null }>(
      `SELECT marginal_yield FROM quantity_estimates WHERE claim_id = $1 AND is_current = true`,
      [claimId]
    ).catch(() => []);
    return { marginal_yield: row?.marginal_yield ?? null };
  }
  if (kind === "question") {
    const [row] = await rawQuery<{ confidence: number | null; marginal_yield: number | null }>(
      `SELECT confidence, marginal_yield FROM question_assessments WHERE claim_id = $1 AND is_current = true`,
      [claimId]
    ).catch(() => []);
    return { confidence: row?.confidence ?? null, marginal_yield: row?.marginal_yield ?? null };
  }
  return {};
}

/**
 * The node's direct subclaims, one row per argument an edge is grouped
 * under (#437), so a Steward sees which line of reasoning each serves; an
 * ungrouped edge appears once with a null argument. Each child carries its
 * own standing by kind.
 */
async function listDirectSubclaims(claimId: string) {
  const rows = await rawQuery<{
    edge_id: string;
    child_id: string;
    child_text: string;
    child_type: string;
    relation_type: string;
    reasoning: string | null;
    confidence: number;
    child_status: string | null;
    child_confidence: number | null;
    child_credence: number | null;
    argument_id: string | null;
    argument_name: string | null;
    child_kind: string;
    child_estimate: unknown | null;
    child_standing: string | null;
  }>(
    `SELECT cr.id AS edge_id, cr.child_claim_id AS child_id, c.text AS child_text,
            c.claim_type AS child_type, cr.relation_type, cr.reasoning, cr.confidence,
            a.status AS child_status, a.confidence AS child_confidence,
            a.claim_credence AS child_credence,
            am.argument_id, arg.name AS argument_name,
            c.kind AS child_kind, qe.estimate AS child_estimate, qa.standing AS child_standing
     FROM claim_relationships cr
     JOIN claims c ON c.id = cr.child_claim_id
     LEFT JOIN assessments a ON a.claim_id = cr.child_claim_id AND a.is_current = true
     LEFT JOIN quantity_estimates qe ON qe.claim_id = c.id AND qe.is_current = true
     LEFT JOIN question_assessments qa ON qa.claim_id = c.id AND qa.is_current = true
     LEFT JOIN argument_subclaims am ON am.relationship_id = cr.id
     LEFT JOIN arguments arg ON arg.id = am.argument_id
     WHERE cr.parent_claim_id = $1
     ORDER BY cr.created_at, cr.id, am.created_at`,
    [claimId]
  );
  return rows.map((sc) => ({
    id: sc.child_id,
    edge_id: sc.edge_id,
    text: sc.child_text,
    type: sc.child_type,
    relation: sc.relation_type,
    // Why the edge holds, as its author wrote it.
    reasoning: sc.reasoning,
    confidence: sc.confidence,
    assessment_status: sc.child_status,
    assessment_confidence: sc.child_confidence,
    assessment_credence: sc.child_credence,
    argument_id: sc.argument_id,
    argument_name: sc.argument_name,
    ...(sc.child_kind !== "claim" ? { kind: sc.child_kind } : {}),
    ...(sc.child_kind === "quantity" ? { estimate: sc.child_estimate } : {}),
    ...(sc.child_kind === "question" ? { standing: sc.child_standing } : {}),
  }));
}
