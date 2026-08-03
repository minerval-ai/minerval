import { and, count, eq, lte } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { assessments } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { getClaimById } from "./claim-service.js";
import { getCurrentAssessment } from "./assessment-service.js";
import {
  getArgumentsForClaim,
  getEvaluationStateForClaim,
} from "./argument-service.js";

// "Cite this claim" (#290): a conventional scholarly citation plus the
// grounded evidence record — why the graph currently holds the claim, in a
// form a reader can carry out of the graph intact. Everything here renders
// existing state; nothing is assessed or written.
//
// The load-bearing identifier is the claim id + assessment version, NOT the
// URL: the claim id is stable across re-canonicalization and the assessment
// history can resolve a pinned version later, so the citation stays
// reproducible even if the domain or wording moves underneath it.

/** The citable publisher/author name. Frozen into readers' bibliographies —
 *  change only with a deliberate rebrand decision. */
export const CITATION_AUTHOR = "Minerval";

export interface CitationInput {
  title: string;
  claimId: string;
  assessmentId: string | null;
  /** 1-based ordinal of the pinned assessment in the claim's history. */
  assessmentVersion: number | null;
  status: string | null;
  assessedAt: Date | null;
  retrievedAt: Date;
  url: string;
}

export interface ClaimCitation {
  author: string;
  title: string;
  claim_id: string;
  assessment_id: string | null;
  assessment_version: number | null;
  status: string | null;
  assessed_at: string | null;
  retrieved_at: string;
  url: string;
  text: string;
  bibtex: string;
  csl: Record<string, unknown>;
}

export interface EvidenceRecord {
  claim: {
    id: string;
    text: string;
    claim_type: string;
    state: string;
    importance: number;
    created_at: string;
    updated_at: string;
  };
  assessment: {
    id: string;
    version: number;
    status: string;
    confidence: number;
    claim_credence: number | null;
    summary: string;
    reasoning_trace: string;
    model: string | null;
    assessed_at: string;
  } | null;
  arguments: {
    id: string;
    name: string | null;
    stance: string;
    content: string;
    evidence_urls: string[];
    verdict: string | null;
    evaluation: string | null;
    subclaims: { id: string; text: string; status: string | null }[];
  }[];
  instances: {
    id: string;
    quote: string;
    context: string | null;
    stance: string;
    source: {
      id: string;
      title: string;
      url: string | null;
      source_type: string;
    };
  }[];
  disagreement: {
    contested: boolean;
    affirming_instances: number;
    denying_instances: number;
    contested_arguments: { id: string; name: string | null }[];
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateParts(d: Date): [number, number, number] {
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** Escape the BibTeX/LaTeX special characters that occur in ordinary prose. */
function bibtexEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}])/g, "\\$1")
    .replace(/([&%$#_])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/** One line describing the pinned assessment, shared across formats. */
function assessmentClause(input: CitationInput): string {
  if (!input.assessmentId || !input.assessedAt) return "unassessed";
  const status = input.status ? ` (${input.status})` : "";
  return `assessment v${input.assessmentVersion}${status}, assessed ${isoDate(input.assessedAt)}`;
}

export function formatTextCitation(input: CitationInput): string {
  return (
    `${CITATION_AUTHOR}. “${input.title}” ` +
    `Claim ${input.claimId}, ${assessmentClause(input)}. ` +
    `Retrieved ${isoDate(input.retrievedAt)}, from ${input.url}.`
  );
}

export function formatBibtex(input: CitationInput): string {
  const key = `minerval_claim_${input.claimId.slice(0, 8)}`;
  const year = (input.assessedAt ?? input.retrievedAt).getUTCFullYear();
  const lines = [
    `@misc{${key},`,
    `  author       = {{${CITATION_AUTHOR}}},`,
    `  title        = {${bibtexEscape(input.title)}},`,
    `  year         = {${year}},`,
    `  howpublished = {${CITATION_AUTHOR}},`,
    `  url          = {${input.url}},`,
    `  urldate      = {${isoDate(input.retrievedAt)}},`,
    `  note         = {Claim ${input.claimId}; ${bibtexEscape(assessmentClause(input))}}`,
    `}`,
  ];
  return lines.join("\n");
}

export function formatCslJson(input: CitationInput): Record<string, unknown> {
  return {
    id: `minerval-claim-${input.claimId.slice(0, 8)}`,
    type: "webpage",
    title: input.title,
    author: [{ literal: CITATION_AUTHOR }],
    "container-title": CITATION_AUTHOR,
    URL: input.url,
    ...(input.assessedAt
      ? {
          issued: { "date-parts": [dateParts(input.assessedAt)] },
          version: String(input.assessmentVersion),
        }
      : {}),
    accessed: { "date-parts": [dateParts(input.retrievedAt)] },
    note: `Claim ${input.claimId}; ${assessmentClause(input)}`,
  };
}

/** The URL a citation carries. `citationUrlBase` (once the w3id namespace is
 *  registered) makes the persistent-identifier cutover a config change. */
export function citationUrl(claimId: string): string {
  const config = loadConfig();
  const base = config.citationUrlBase.replace(/\/$/, "");
  if (base) return `${base}/${claimId}`;
  return `${config.publicWebBaseUrl.replace(/\/$/, "")}/claims/${claimId}`;
}

/**
 * Assemble the full citable unit for a claim: the conventional citation in
 * every format, plus the evidence record. Returns null for an unknown claim.
 */
export async function assembleClaimCitation(
  claimId: string,
  retrievedAt: Date = new Date()
): Promise<{ citation: ClaimCitation; evidence_record: EvidenceRecord } | null> {
  const claim = await getClaimById(claimId);
  if (!claim) return null;

  const db = getDb();
  const assessment = await getCurrentAssessment(claimId);

  // Version = 1-based position in the claim's assessment history, so the
  // citation names "assessment vN" and GET /claims/:id/assessments can
  // resolve it later even after further reassessment.
  let version: number | null = null;
  if (assessment) {
    const [row] = await db
      .select({ count: count() })
      .from(assessments)
      .where(
        and(
          eq(assessments.claimId, claimId),
          lte(assessments.assessedAt, assessment.assessedAt)
        )
      );
    version = row?.count ?? 1;
  }

  const args = await getArgumentsForClaim(claimId);
  const evalStates = await getEvaluationStateForClaim(claimId);
  const evalByArgument = new Map(evalStates.map((s) => [s.argument_id, s]));

  // Basis subclaims per argument, with each subclaim's current status — the
  // load-bearing premises the record names alongside the argument.
  const subclaimRows = await rawQuery<{
    argument_id: string;
    id: string;
    text: string;
    status: string | null;
  }>(
    `SELECT cr.argument_id, c.id, c.text, a.status
       FROM claim_relationships cr
       JOIN claims c ON c.id = cr.child_claim_id
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
      WHERE cr.parent_claim_id = $1
        AND cr.argument_id IS NOT NULL
      ORDER BY cr.created_at`,
    [claimId]
  );
  const subclaimsByArgument = new Map<string, { id: string; text: string; status: string | null }[]>();
  for (const row of subclaimRows) {
    const list = subclaimsByArgument.get(row.argument_id) ?? [];
    list.push({ id: row.id, text: row.text, status: row.status });
    subclaimsByArgument.set(row.argument_id, list);
  }

  const instanceRows = await rawQuery<{
    id: string;
    original_text: string;
    context: string | null;
    stance: string;
    source_id: string;
    title: string;
    url: string | null;
    source_type: string;
  }>(
    `SELECT ci.id, ci.original_text, ci.context, ci.stance,
            s.id AS source_id, s.title, s.url, s.source_type
       FROM claim_instances ci
       JOIN sources s ON s.id = ci.source_id
      WHERE ci.claim_id = $1
      ORDER BY ci.created_at`,
    [claimId]
  );

  const contestedArguments = args
    .filter((a) => evalByArgument.get(a.id)?.verdict === "contested")
    .map((a) => ({ id: a.id, name: a.name }));

  const evidenceRecord: EvidenceRecord = {
    claim: {
      id: claim.id,
      text: claim.text,
      claim_type: claim.claimType,
      state: claim.state,
      importance: claim.importance,
      created_at: claim.createdAt.toISOString(),
      updated_at: claim.updatedAt.toISOString(),
    },
    assessment: assessment
      ? {
          id: assessment.id,
          version: version!,
          status: assessment.status,
          confidence: assessment.confidence,
          claim_credence: assessment.claimCredence ?? null,
          summary: assessment.summary ?? assessment.reasoningTrace,
          reasoning_trace: assessment.reasoningTrace,
          model: assessment.model ?? null,
          assessed_at: assessment.assessedAt.toISOString(),
        }
      : null,
    arguments: args.map((a) => ({
      id: a.id,
      name: a.name,
      stance: a.stance,
      content: a.content,
      evidence_urls: a.evidenceUrls,
      verdict: evalByArgument.get(a.id)?.verdict ?? null,
      evaluation: evalByArgument.get(a.id)?.content ?? null,
      subclaims: subclaimsByArgument.get(a.id) ?? [],
    })),
    instances: instanceRows.map((i) => ({
      id: i.id,
      quote: i.original_text,
      context: i.context,
      stance: i.stance,
      source: {
        id: i.source_id,
        title: i.title,
        url: i.url,
        source_type: i.source_type,
      },
    })),
    disagreement: {
      contested: assessment?.status === "contested",
      affirming_instances: instanceRows.filter((i) => i.stance === "affirms").length,
      denying_instances: instanceRows.filter((i) => i.stance === "denies").length,
      contested_arguments: contestedArguments,
    },
  };

  const input: CitationInput = {
    title: claim.text,
    claimId: claim.id,
    assessmentId: assessment?.id ?? null,
    assessmentVersion: version,
    status: assessment?.status ?? null,
    assessedAt: assessment?.assessedAt ?? null,
    retrievedAt,
    url: citationUrl(claim.id),
  };

  const citation: ClaimCitation = {
    author: CITATION_AUTHOR,
    title: input.title,
    claim_id: input.claimId,
    assessment_id: input.assessmentId,
    assessment_version: input.assessmentVersion,
    status: input.status,
    assessed_at: input.assessedAt?.toISOString() ?? null,
    retrieved_at: retrievedAt.toISOString(),
    url: input.url,
    text: formatTextCitation(input),
    bibtex: formatBibtex(input),
    csl: formatCslJson(input),
  };

  return { citation, evidence_record: evidenceRecord };
}
