import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import {
  CITATION_AUTHOR,
  assembleEvidenceRecord,
  citationUrl,
  type EvidenceRecord,
} from "./citation-service.js";
import { CONTENT_LICENSE_IRI, resolveClaimLinks } from "./nanopub-service.js";
import { getQuestionDetail, type QuestionDetailView } from "./question-service.js";
import { listRequests, type RequestView } from "./request-service.js";

// MIRA export (#515): a claim, or a question, and the structure around it,
// serialized as MIRA records (Modular Interoperable Research Attribution,
// https://www.mira.science/): questions, claims, evidence, sources, and
// requests, each with its attribution. Shares the evidence-record assembly
// with "Cite this claim" (#290) and the nanopublication export (#292), and
// renders existing state only.
//
// MIRA has not published a formal schema we could pin, so the records follow
// the provisional profile in docs/mira.md, whose JSON Schema
// (docs/mira/minerval-mira-0.1.schema.json) the tests hold every bundle to.
// What MIRA has no word for (the six-status assessment, named arguments, a
// question's standing) travels under `extensions.mv`, in the same terms as
// the mv: vocabulary (docs/vocab.md). The export rules are the nanopub's:
// credence is omitted where the graph omits it (§10), [[claim:...]]
// machinery resolves to canonical text (§12), and the CC0 dedication is
// stated. Records are attributed but not signed; see docs/mira.md.

export const MIRA_PROFILE_VERSION = "0.1";
/** The profile document; the schema sits beside it (infra/w3id/.htaccess). */
export const MIRA_PROFILE_IRI = `https://w3id.org/minerval/mira/${MIRA_PROFILE_VERSION}`;

// The decomposition relations as MIRA claim → claim link types. Anything the
// enum grows to that isn't mapped yet degrades to related_to, as the nanopub
// export degrades to mv:relatedTo.
const RELATION_LINKS: Record<string, MiraLinkRel> = {
  requires: "requires",
  assumes: "assumes",
  supports: "supported_by",
  contradicts: "contradicted_by",
  specifies: "specified_by",
  defines: "defined_by",
};

// A source's stance toward the node, as an evidence relation; the same
// reading as the nanopub's CiTO mapping, plus the kinds' stances: a source
// asks or answers a question, or states a quantity's value.
const STANCE_RELATIONS: Record<string, MiraEvidenceRelation> = {
  affirms: "supports",
  denies: "disputes",
  poses: "discusses",
  asks: "asks",
  answers: "answers",
  states: "states",
};

export type MiraLinkRel =
  | "requires"
  | "assumes"
  | "supported_by"
  | "contradicted_by"
  | "specified_by"
  | "defined_by"
  | "related_to"
  | "answers"
  | "answered_by"
  | "has_part"
  | "presupposes"
  | "excludes"
  | "compatible_with";

export type MiraEvidenceRelation =
  | "supports"
  | "disputes"
  | "discusses"
  | "asks"
  | "answers"
  | "states";

export interface MiraAttribution {
  name: string;
  /** organization: Minerval itself; agent: one of its administrator roles or
   *  a model; contributor: a person, by display name; mandate: a funded
   *  arrangement, which names no party (§12/§19). */
  kind: "organization" | "agent" | "contributor" | "mandate";
  role: "publisher" | "assessor" | "filer";
  at?: string;
}

export interface MiraLink {
  rel: MiraLinkRel;
  target: string;
}

interface MiraRecordBase {
  id: string;
  attribution: MiraAttribution[];
  extensions?: { mv: Record<string, unknown> };
}

export interface MiraQuestion extends MiraRecordBase {
  type: "question";
  text: string;
  links: MiraLink[];
}

export interface MiraClaim extends MiraRecordBase {
  type: "claim";
  text: string;
  links: MiraLink[];
}

export interface MiraEvidence extends MiraRecordBase {
  type: "evidence";
  quote: string | null;
  relation: MiraEvidenceRelation;
  target: string;
  source: string;
  context?: string;
  /** On an answering instance: the answer its answer matches. */
  answer?: string;
}

export interface MiraSource extends MiraRecordBase {
  type: "source";
  title: string;
  url: string | null;
  source_type: string | null;
}

export interface MiraRequest extends MiraRecordBase {
  type: "request";
  ask: string;
  why: string;
  satisfied_by: string;
  addressed_to: string | null;
  state: string;
  bears_on: string[];
  filed_at: string;
}

export type MiraRecord = MiraQuestion | MiraClaim | MiraEvidence | MiraSource | MiraRequest;

export interface MiraBundle {
  mira_profile: string;
  profile_version: string;
  generated_at: string;
  license: string;
  publisher: { name: string; url: string };
  root: string;
  records: MiraRecord[];
}

/** A question this node is an answer to, one hop up. */
export interface AnsweredQuestion {
  id: string;
  text: string;
  standing: string | null;
}

export interface MiraInput {
  record: EvidenceRecord;
  /** Present exactly when the node is a question. */
  question: QuestionDetailView | null;
  answers_questions: AnsweredQuestion[];
  requests: RequestView[];
}

export interface MiraOpts {
  webBaseUrl: string;
  pageUrl: string;
  generatedAt: Date;
  /** The node IRI for a claim id; citationUrl in production. */
  claimUri: (id: string) => string;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function buildMiraBundle(input: MiraInput, opts: MiraOpts): MiraBundle {
  const { record, question } = input;
  const web = opts.webBaseUrl.replace(/\/$/, "");
  const nodeUri = opts.claimUri;
  const rootUri = nodeUri(record.claim.id);
  const publisher: MiraAttribution = {
    name: CITATION_AUTHOR,
    kind: "organization",
    role: "publisher",
  };

  // Canonical texts for resolving [[claim:...]] references in prose (§12):
  // every node the bundle names.
  const textById = new Map<string, string>([[record.claim.id, record.claim.text]]);
  for (const a of record.arguments) for (const s of a.subclaims) textById.set(s.id, s.text);
  if (question) {
    for (const n of [...question.answers, ...question.subquestions, ...question.presuppositions]) {
      textById.set(n.id, n.text);
    }
  }
  for (const q of input.answers_questions) textById.set(q.id, q.text);
  for (const r of input.requests) for (const n of r.bears_on) textById.set(n.id, n.text);
  const prose = (text: string) => resolveClaimLinks(text, textById);

  // Records keyed by id, so a node reached twice (a premise of two
  // arguments, an answer that is also a request's target) appears once.
  const records = new Map<string, MiraRecord>();
  const put = (r: MiraRecord) => {
    if (!records.has(r.id)) records.set(r.id, r);
  };
  // A neighbouring node: its text and standing only. It is a record of its
  // own in its own export; here it is what the root's links point at.
  const stub = (
    id: string,
    text: string,
    kind: string,
    standing: { status?: string | null; standing?: string | null }
  ): MiraRecord => {
    const mv: Record<string, unknown> = { kind, stub: true };
    if (standing.status) mv.status = standing.status;
    if (standing.standing) mv.standing = standing.standing;
    return kind === "question"
      ? { id: nodeUri(id), type: "question", text, links: [], attribution: [publisher], extensions: { mv } }
      : { id: nodeUri(id), type: "claim", text, links: [], attribution: [publisher], extensions: { mv } };
  };

  // --- the root node, first in the bundle; its links fill in below ---
  const rootLinks: MiraLink[] = [];
  const rootMv: Record<string, unknown> = {
    kind: record.claim.kind,
    claim_id: record.claim.id,
    claim_type: record.claim.claim_type,
    page: opts.pageUrl,
  };
  const rootAttribution: MiraAttribution[] = [publisher];
  put({
    id: rootUri,
    type: question ? "question" : "claim",
    text: record.claim.text,
    links: rootLinks,
    attribution: rootAttribution,
    extensions: { mv: rootMv },
  });

  if (question) {
    const qa = question.assessment;
    if (qa) {
      rootMv.standing = qa.standing;
      rootMv.favored_answers = qa.favored_ids.map(nodeUri);
      if (qa.summary) rootMv.summary = prose(qa.summary);
      rootMv.reasoning_trace = prose(qa.reasoning_trace);
      rootMv.assessed_at = iso(qa.assessed_at);
      if (question.incomplete) rootMv.incomplete = prose(question.incomplete);
      rootAttribution.push({
        name: qa.model ?? "Question Steward",
        kind: "agent",
        role: "assessor",
        at: iso(qa.assessed_at),
      });
    }
    // Answers: the answer stubs carry how they bear on each other.
    const answerLinks = new Map<string, MiraLink[]>();
    for (const rel of question.relations) {
      const kind: MiraLinkRel = rel.relation === "excludes" ? "excludes" : "compatible_with";
      answerLinks.set(rel.a, [...(answerLinks.get(rel.a) ?? []), { rel: kind, target: nodeUri(rel.b) }]);
      answerLinks.set(rel.b, [...(answerLinks.get(rel.b) ?? []), { rel: kind, target: nodeUri(rel.a) }]);
    }
    for (const a of question.answers) {
      rootLinks.push({ rel: "answered_by", target: nodeUri(a.id) });
      const s = stub(a.id, a.text, a.kind, { status: a.status }) as MiraClaim;
      s.links.push({ rel: "answers", target: rootUri }, ...(answerLinks.get(a.id) ?? []));
      const mv = s.extensions!.mv;
      // Credence only where the graph states one (§10).
      if (a.credence != null) mv.credence = a.credence;
      if (a.basis) mv.answer_basis = a.basis;
      put(s);
    }
    for (const q of question.subquestions) {
      rootLinks.push({ rel: "has_part", target: nodeUri(q.id) });
      put(stub(q.id, q.text, q.kind, q));
    }
    for (const p of question.presuppositions) {
      rootLinks.push({ rel: "presupposes", target: nodeUri(p.id) });
      put(stub(p.id, p.text, p.kind, p));
    }
  }

  if (record.assessment) {
    const a = record.assessment;
    rootMv.status = a.status;
    rootMv.confidence = a.confidence;
    // Credence: absent exactly where the graph declines to state one (§10).
    if (a.claim_credence != null) rootMv.credence = a.claim_credence;
    rootMv.summary = prose(a.summary);
    rootMv.reasoning_trace = prose(a.reasoning_trace);
    rootMv.assessment_id = a.id;
    rootMv.assessment_version = a.version;
    rootMv.assessed_at = a.assessed_at;
    rootAttribution.push({
      name: a.model ?? "Claim Steward",
      kind: "agent",
      role: "assessor",
      at: a.assessed_at,
    });
  }

  // Decomposition: one link per premise edge, and the arguments that group
  // them, which MIRA has no record for, under the extension.
  if (record.arguments.length > 0) {
    rootMv.arguments = record.arguments.map((arg) => {
      const out: Record<string, unknown> = {
        stance: arg.stance,
        content: prose(arg.content),
        premises: arg.subclaims.map((s) => nodeUri(s.id)),
      };
      if (arg.name) out.name = arg.name;
      if (arg.verdict) out.verdict = arg.verdict;
      // Only a recorded mark: an unevaluated argument says nothing about
      // decisiveness.
      if (arg.verdict && arg.decisive !== null) out.decisive = arg.decisive;
      if (arg.evaluation) out.evaluation = prose(arg.evaluation);
      return out;
    });
  }
  const seenEdges = new Set<string>();
  for (const arg of record.arguments) {
    for (const s of arg.subclaims) {
      const rel = RELATION_LINKS[s.relation] ?? "related_to";
      const key = `${rel} ${s.id}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        rootLinks.push({ rel, target: nodeUri(s.id) });
      }
      put(stub(s.id, s.text, "claim", { status: s.status }));
    }
  }

  for (const q of input.answers_questions) {
    rootLinks.push({ rel: "answers", target: nodeUri(q.id) });
    put(stub(q.id, q.text, "question", { standing: q.standing }));
  }

  // --- evidence and sources ---
  const sourceUri = (id: string) => `${web}/sources/${id}`;
  const putSource = (id: string, title: string, url: string | null, sourceType: string | null) =>
    put({
      id: sourceUri(id),
      type: "source",
      title,
      url,
      source_type: sourceType,
      attribution: [publisher],
    });

  // A question's answering instances name the answer their answer matches.
  const answerByInstance = new Map(
    (question?.instances ?? [])
      .filter((i) => i.answer_id)
      .map((i) => [i.id, i.answer_id!] as const)
  );
  for (const inst of record.instances) {
    const ev: MiraEvidence = {
      id: `${rootUri}#evidence-${inst.id}`,
      type: "evidence",
      // A figure read from a table has no sentence (schema.ts).
      quote: inst.quote === "" ? null : inst.quote,
      relation: STANCE_RELATIONS[inst.stance] ?? "discusses",
      target: rootUri,
      source: sourceUri(inst.source.id),
      attribution: [publisher],
    };
    if (inst.context) ev.context = inst.context;
    const answer = answerByInstance.get(inst.id);
    if (answer) ev.answer = nodeUri(answer);
    putSource(inst.source.id, inst.source.title, inst.source.url, inst.source.source_type);
    put(ev);
  }

  // --- requests that bear on the node ---
  for (const r of input.requests) {
    const filer: MiraAttribution = {
      name: r.filed_by.label,
      kind:
        r.filed_by.kind === "admin"
          ? "agent"
          : r.filed_by.kind === "contributor"
            ? "contributor"
            : "mandate",
      role: "filer",
      at: iso(r.filed_at),
    };
    const mv: Record<string, unknown> = {
      keeper: r.keeper.label,
      work: r.work.map((w) => ({
        by: w.by,
        outcome: w.outcome,
        summary: prose(w.summary),
        at: iso(w.at),
      })),
    };
    if (r.who_could) mv.who_could = prose(r.who_could);
    if (r.bears_on_text) mv.bears_on_text = prose(r.bears_on_text);
    if (r.state_note) mv.state_note = prose(r.state_note);
    for (const s of r.bears_on_sources) putSource(s.id, s.title, s.url, null);
    put({
      id: `${web}/requests/${r.id}`,
      type: "request",
      ask: prose(r.ask),
      why: prose(r.why),
      satisfied_by: prose(r.satisfied_by),
      addressed_to: r.addressed_to,
      state: r.state,
      bears_on: [
        ...r.bears_on.map((n) => nodeUri(n.id)),
        ...r.bears_on_sources.map((s) => sourceUri(s.id)),
      ],
      filed_at: iso(r.filed_at),
      attribution: [filer, publisher],
      extensions: { mv },
    });
  }

  return {
    mira_profile: MIRA_PROFILE_IRI,
    profile_version: MIRA_PROFILE_VERSION,
    generated_at: opts.generatedAt.toISOString(),
    license: CONTENT_LICENSE_IRI,
    publisher: { name: CITATION_AUTHOR, url: web },
    root: rootUri,
    records: [...records.values()],
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export async function assembleClaimMira(
  claimId: string,
  generatedAt: Date = new Date()
): Promise<MiraBundle | null> {
  const record = await assembleEvidenceRecord(claimId);
  if (!record) return null;

  const [question, answersQuestions, requests] = await Promise.all([
    record.claim.kind === "question" ? getQuestionDetail(claimId) : Promise.resolve(null),
    rawQuery<AnsweredQuestion>(
      `SELECT c.id, c.text, qa.standing
         FROM claim_relationships r
         JOIN claims c ON c.id = r.parent_claim_id AND c.state = 'active'
         LEFT JOIN question_assessments qa ON qa.claim_id = c.id AND qa.is_current = true
        WHERE r.child_claim_id = $1 AND r.relation_type = 'answers'
        ORDER BY r.created_at, r.id`,
      [claimId]
    ),
    listRequests({ claimId, limit: 100 }),
  ]);

  const config = loadConfig();
  const web = config.publicWebBaseUrl.replace(/\/$/, "");
  return buildMiraBundle(
    { record, question, answers_questions: answersQuestions, requests: requests.items },
    {
      webBaseUrl: web,
      pageUrl: `${web}/claims/${record.claim.id}`,
      generatedAt,
      claimUri: citationUrl,
    }
  );
}
