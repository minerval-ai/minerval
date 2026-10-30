import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import {
  CITATION_AUTHOR,
  assembleEvidenceRecord,
  citationUrl,
  type EvidenceRecord,
} from "./citation-service.js";
import {
  CONTENT_LICENSE_IRI,
  MINERVAL_VOCAB,
  resolveClaimLinks,
} from "./nanopub-service.js";
import { getQuestionDetail, type QuestionDetailView } from "./question-service.js";
import { listRequests, type RequestView } from "./request-service.js";

// MIRA export (#515): a claim, or a question, and the structure around it, as
// a MIRA graph in JSON-LD (Modular Interoperable Research Attribution,
// https://github.com/MIRA-science/schema): Question, Claim, Evidence,
// SourceDocument and Request nodes, linked by MIRA's own relations
// (supports, opposes, addresses, observationStatement, sourceDocument,
// request_target), each with its dct:creator. Shares the evidence-record
// assembly with "Cite this claim" (#290) and the nanopublication export
// (#292), and renders existing state only.
//
// MIRA's SHACL shapes are closed: a Claim may carry only MIRA's properties.
// So what MIRA has no word for (the six-status assessment, credence, a
// question's standing, arguments, the kind of each decomposition edge, a
// request's terms and state) is said on separate mv: nodes that point at the
// MIRA nodes they describe (docs/mira.md, docs/vocab.md). A MIRA consumer
// reads a valid MIRA graph and can ignore them; one that reads mv: loses
// nothing. The export rules are the nanopub's: credence is omitted where the
// graph omits it (§10), [[claim:...]] machinery resolves to canonical text
// (§12), and the CC0 dedication is stated.

/** MIRA's published JSON-LD context (the schema README's transport format). */
export const MIRA_CONTEXT_URL = "https://purl.org/mira-science/mira.jsonld";
/** The schema version targeted: mira.ttl's owl:versionInfo at the pinned
 *  commit, whose shapes the tests validate against (docs/mira/). */
export const MIRA_SCHEMA_VERSION = "0.1 (tentative)";
export const MIRA_SCHEMA_COMMIT = "365d40403498da5c3c6698f21680696b25f1c2c8";

export type JsonLdNode = Record<string, unknown>;

export interface MiraDocument {
  "@context": unknown[];
  "@graph": JsonLdNode[];
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

// An instance's stance as MIRA's argument relation from its Evidence to the
// claim it states. Posing, and stating a quantity's value, take no side.
const STANCE_RELATION: Record<string, "supports" | "opposes" | null> = {
  affirms: "supports",
  denies: "opposes",
  answers: "supports",
  poses: null,
  states: null,
};

const ref = (iri: string) => ({ "@id": iri });
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const decimal = (n: number) => ({ "@value": String(n), "@type": "xsd:decimal" });
const dateTime = (d: Date | string) => ({ "@value": iso(d), "@type": "xsd:dateTime" });

export function buildMiraDocument(input: MiraInput, opts: MiraOpts): MiraDocument {
  const { record, question } = input;
  const web = opts.webBaseUrl.replace(/\/$/, "");
  const nodeUri = opts.claimUri;
  const rootUri = nodeUri(record.claim.id);

  // Canonical texts for resolving [[claim:...]] references in prose (§12):
  // every node the export names.
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

  // Nodes by id, so a node reached twice (a premise of two arguments, an
  // answer that is also a request's target) is one node whose relations
  // accumulate.
  const graph = new Map<string, JsonLdNode>();
  const node = (id: string, init: JsonLdNode): JsonLdNode => {
    const existing = graph.get(id);
    if (existing) return existing;
    const n = { "@id": id, ...init };
    graph.set(id, n);
    return n;
  };
  const add = (n: JsonLdNode, prop: string, value: unknown) => {
    const same = (x: unknown) => JSON.stringify(x) === JSON.stringify(value);
    const cur = n[prop];
    if (cur === undefined) n[prop] = value;
    else if (Array.isArray(cur)) {
      if (!cur.some(same)) cur.push(value);
    } else if (!same(cur)) n[prop] = [cur, value];
  };

  // Who made what (dct:creator ranges over sioc:UserAccount in MIRA). Every
  // node is Minerval's publication; a request also names its filer.
  const minervalAccount = `${web}/#minerval`;
  node(minervalAccount, { "@type": "UserAccount", accountName: CITATION_AUTHOR });

  // The graph's nodes: a question, or a claim (a quantity is a claim to
  // MIRA; its kind is on its mv:NodeRecord). The text is the dct:title, as in
  // MIRA's own sample data.
  const graphNode = (id: string, text: string, kind: string) =>
    node(nodeUri(id), {
      "@type": kind === "question" ? "Question" : "Claim",
      title: text,
      creator: minervalAccount,
    });
  // What Minerval holds about a node, beside it.
  const nodeRecord = (id: string, kind: string): JsonLdNode =>
    node(`${nodeUri(id)}#record`, {
      "@type": "mv:NodeRecord",
      "mv:describes": ref(nodeUri(id)),
      "mv:kind": kind,
    });
  // A Minerval edge, with the relation MIRA has no property for.
  const edge = (from: string, to: string, relation: string, extra: JsonLdNode = {}) =>
    node(`${nodeUri(from)}#edge-${relation}-${to}`, {
      "@type": "mv:Edge",
      "mv:from": ref(nodeUri(from)),
      "mv:to": ref(nodeUri(to)),
      "mv:relation": relation,
      ...extra,
    });
  const neighbour = (
    id: string,
    text: string,
    kind: string,
    standing: { status?: string | null; standing?: string | null }
  ): JsonLdNode => {
    const n = graphNode(id, text, kind);
    const rec = nodeRecord(id, kind);
    if (standing.status) rec["mv:status"] = standing.status;
    if (standing.standing) rec["mv:standing"] = standing.standing;
    return n;
  };

  // --- the export itself: what, when, under which terms ---
  node(`${rootUri}#mira`, {
    "@type": "mv:MiraExport",
    "mv:root": ref(rootUri),
    "mv:miraSchemaVersion": MIRA_SCHEMA_VERSION,
    "mv:miraSchemaCommit": MIRA_SCHEMA_COMMIT,
    "dct:license": ref(CONTENT_LICENSE_IRI),
    "dct:source": ref(opts.pageUrl),
    "dct:publisher": ref(minervalAccount),
    "prov:generatedAtTime": dateTime(opts.generatedAt),
  });

  // --- the root node ---
  const root = graphNode(record.claim.id, record.claim.text, record.claim.kind);
  root.created = record.claim.created_at;
  root.modified = record.claim.updated_at;
  const rootRecord = nodeRecord(record.claim.id, record.claim.kind);
  rootRecord["mv:claimId"] = record.claim.id;
  rootRecord["mv:claimType"] = record.claim.claim_type;
  rootRecord["dct:source"] = ref(opts.pageUrl);

  if (record.assessment) {
    const a = record.assessment;
    rootRecord["mv:status"] = a.status;
    rootRecord["mv:confidence"] = decimal(a.confidence);
    // Credence: absent exactly where the graph declines to state one (§10).
    if (a.claim_credence != null) rootRecord["mv:credence"] = decimal(a.claim_credence);
    rootRecord["rdfs:comment"] = prose(a.summary);
    rootRecord["mv:reasoningTrace"] = prose(a.reasoning_trace);
    rootRecord["mv:assessmentId"] = a.id;
    rootRecord["mv:assessmentVersion"] = { "@value": String(a.version), "@type": "xsd:integer" };
    rootRecord["mv:assessedAt"] = dateTime(a.assessed_at);
    if (a.model) rootRecord["mv:assessmentModel"] = a.model;
  }

  if (question) {
    const qa = question.assessment;
    if (qa) {
      rootRecord["mv:standing"] = qa.standing;
      for (const id of qa.favored_ids) add(rootRecord, "mv:favors", ref(nodeUri(id)));
      if (qa.summary) rootRecord["rdfs:comment"] = prose(qa.summary);
      rootRecord["mv:reasoningTrace"] = prose(qa.reasoning_trace);
      rootRecord["mv:assessedAt"] = dateTime(qa.assessed_at);
      if (qa.model) rootRecord["mv:assessmentModel"] = qa.model;
      if (question.incomplete) rootRecord["mv:incomplete"] = prose(question.incomplete);
    }
    // An answer addresses its question, in MIRA's own relation; why it is in
    // the set rides on the edge.
    for (const a of question.answers) {
      add(neighbour(a.id, a.text, a.kind, { status: a.status }), "addresses", rootUri);
      if (a.credence != null) nodeRecord(a.id, a.kind)["mv:credence"] = decimal(a.credence);
      edge(record.claim.id, a.id, "answers", a.basis ? { "mv:answerBasis": a.basis } : {});
    }
    for (const rel of question.relations) {
      node(`${rootUri}#answers-${rel.a}-${rel.b}`, {
        "@type": "mv:AnswerRelation",
        "mv:question": ref(rootUri),
        "mv:answer": [ref(nodeUri(rel.a)), ref(nodeUri(rel.b))],
        "mv:relation": rel.relation,
      });
    }
    for (const q of question.subquestions) {
      neighbour(q.id, q.text, q.kind, q);
      edge(record.claim.id, q.id, "part_of");
    }
    for (const p of question.presuppositions) {
      neighbour(p.id, p.text, p.kind, p);
      edge(record.claim.id, p.id, "presupposes");
    }
  }

  // Decomposition: a premise of an argument for the claim supports it, one
  // of an argument against opposes it (MIRA's Argument relations); the
  // argument itself, and the kind of each edge, are Minerval's.
  record.arguments.forEach((arg, i) => {
    const argNode = node(`${rootUri}#argument-${i + 1}`, {
      "@type": "mv:Argument",
      "mv:argues": ref(rootUri),
      "mv:stance": arg.stance,
      "rdfs:comment": prose(arg.content),
    });
    if (arg.name) argNode["rdfs:label"] = arg.name;
    if (arg.verdict) argNode["mv:verdict"] = arg.verdict;
    // Only a recorded mark: an unevaluated argument says nothing about
    // decisiveness.
    if (arg.verdict && arg.decisive !== null) {
      argNode["mv:decisive"] = { "@value": String(arg.decisive), "@type": "xsd:boolean" };
    }
    if (arg.evaluation) argNode["mv:evaluation"] = prose(arg.evaluation);
    const relation = arg.stance === "against" ? "opposes" : "supports";
    for (const s of arg.subclaims) {
      add(argNode, "mv:hasPremise", ref(nodeUri(s.id)));
      add(neighbour(s.id, s.text, "claim", { status: s.status }), relation, rootUri);
      edge(record.claim.id, s.id, s.relation);
    }
  });

  for (const q of input.answers_questions) {
    neighbour(q.id, q.text, "question", { standing: q.standing });
    add(root, "addresses", nodeUri(q.id));
  }

  // --- instances ---
  // An instance is a source's statement of a claim: MIRA Evidence whose
  // observationStatement is the claim stated and whose sourceDocument is the
  // source. A source that asks a question, or answers it without matching an
  // answer, states no claim, and is recorded on its mv:Instance alone.
  const answerByInstance = new Map(
    (question?.instances ?? [])
      .filter((i) => i.answer_id)
      .map((i) => [i.id, i.answer_id!] as const)
  );
  const sourceNode = (id: string, title: string, url: string | null): string => {
    // Named by its document URL where it has one, as MIRA's sample data
    // names sources; otherwise by its page here.
    const iri = url ?? `${web}/sources/${id}`;
    node(iri, { "@type": "SourceDocument", title, creator: minervalAccount });
    return iri;
  };
  for (const inst of record.instances) {
    const sourceIri = sourceNode(inst.source.id, inst.source.title, inst.source.url);
    const instNode = node(`${rootUri}#instance-${inst.id}`, {
      "@type": "mv:Instance",
      "mv:stance": inst.stance,
      "prov:wasQuotedFrom": ref(sourceIri),
    });
    // A figure read from a table has no sentence (schema.ts).
    if (inst.quote) instNode["mv:quote"] = inst.quote;

    const answer = answerByInstance.get(inst.id);
    const statement = question ? (answer ? nodeUri(answer) : null) : rootUri;
    if (!statement) continue;
    const evidenceIri = `${rootUri}#evidence-${inst.id}`;
    const evidence = node(evidenceIri, {
      "@type": "Evidence",
      observationStatement: statement,
      sourceDocument: sourceIri,
      creator: minervalAccount,
    });
    if (inst.quote) evidence.content = inst.quote;
    if (inst.context) evidence.description = { "@type": "Item", content: inst.context };
    const relation = STANCE_RELATION[inst.stance];
    if (relation) evidence[relation] = statement;
    instNode["mv:evidence"] = ref(evidenceIri);
  }

  // --- requests that bear on the node ---
  // MIRA's request_target ranges over claims; a question or a source a
  // request bears on is named on its mv:RequestRecord, with the terms MIRA
  // has no property for.
  for (const r of input.requests) {
    const reqIri = `${web}/requests/${r.id}`;
    const req = node(reqIri, {
      "@type": "Request",
      title: prose(r.ask),
      description: { "@type": "Item", content: prose(r.why) },
      created: iso(r.filed_at),
      // §12/§19: a mandate's request names no party; its filer label is the
      // arrangement ("a funded mandate").
      creator: [{ "@type": "UserAccount", accountName: r.filed_by.label }, minervalAccount],
    });
    const rec = node(`${reqIri}#record`, {
      "@type": "mv:RequestRecord",
      "mv:request": ref(reqIri),
      "mv:satisfiedBy": prose(r.satisfied_by),
      "mv:state": r.state,
      "mv:filerKind": r.filed_by.kind,
      "mv:keeper": r.keeper.label,
    });
    if (r.addressed_to) rec["mv:addressedTo"] = r.addressed_to;
    if (r.who_could) rec["mv:whoCould"] = prose(r.who_could);
    if (r.bears_on_text) rec["mv:bearsOnText"] = prose(r.bears_on_text);
    if (r.state_note) rec["mv:stateNote"] = prose(r.state_note);
    for (const n of r.bears_on) {
      if (n.id !== record.claim.id) neighbour(n.id, n.text, n.kind, {});
      if (n.kind !== "question") add(req, "request_target", nodeUri(n.id));
      add(rec, "mv:bearsOn", ref(nodeUri(n.id)));
    }
    for (const s of r.bears_on_sources) {
      add(rec, "mv:bearsOn", ref(sourceNode(s.id, s.title, s.url)));
    }
    r.work.forEach((w, i) => {
      node(`${reqIri}#work-${i + 1}`, {
        "@type": "mv:RequestWork",
        "mv:request": ref(reqIri),
        "mv:by": w.by,
        ...(w.outcome ? { "mv:outcome": w.outcome } : {}),
        "rdfs:comment": prose(w.summary),
        "prov:generatedAtTime": dateTime(w.at),
      });
    });
  }

  return {
    "@context": [MIRA_CONTEXT_URL, { mv: MINERVAL_VOCAB, xsd: "http://www.w3.org/2001/XMLSchema#" }],
    "@graph": [...graph.values()],
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export async function assembleClaimMira(
  claimId: string,
  generatedAt: Date = new Date()
): Promise<MiraDocument | null> {
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
  return buildMiraDocument(
    { record, question, answers_questions: answersQuestions, requests: requests.items },
    {
      webBaseUrl: web,
      pageUrl: `${web}/claims/${record.claim.id}`,
      generatedAt,
      claimUri: citationUrl,
    }
  );
}
