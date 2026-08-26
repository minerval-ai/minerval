import { loadConfig } from "../config.js";
import {
  CITATION_AUTHOR,
  assembleEvidenceRecord,
  citationUrl,
  type EvidenceRecord,
} from "./citation-service.js";

// Nanopublication export (#292): the evidence record serialized as RDF in the
// nanopub shape (assertion / provenance / publication-info; Groth et al.
// 2010), so claims, assessments, and instances can be consumed by scholarly-
// web and linked-data tooling without adopting our schema. Shares the
// evidence-record assembly with "Cite this claim" (#290); renders existing
// state only.
//
// Vocabulary: established ontologies where they fit — PROV-O for provenance,
// CiTO for a source's stance toward the claim, Dublin Core for publication
// info — and a minimal Minerval vocabulary (documented in docs/vocab.md) for
// what is ours: claim types, assessment status/confidence/credence, and the
// decomposition relations. Credence is omitted exactly where the graph omits
// it — an absent triple is the constitution's §10 discipline, not a gap.

/** Minted under the prepared w3id namespace (infra/w3id/) so vocabulary IRIs
 *  survive any future domain move; docs/vocab.md documents the terms. */
export const MINERVAL_VOCAB = "https://w3id.org/minerval/vocab#";

/** Graph content (claims, assessments, arguments — not the codebase, which is
 *  MIT) is dedicated to the public domain under CC0 1.0. Each nanopub carries
 *  the dedication as a dct:license triple so every publication permanently
 *  records the terms it went out under, even if the content license ever
 *  changes for later publications. */
export const CONTENT_LICENSE_IRI =
  "https://creativecommons.org/publicdomain/zero/1.0/";

const PREFIXES: Record<string, string> = {
  np: "http://www.nanopub.org/nschema#",
  mv: MINERVAL_VOCAB,
  prov: "http://www.w3.org/ns/prov#",
  cito: "http://purl.org/spar/cito/",
  dct: "http://purl.org/dc/terms/",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

// The decomposition relations, as predicates. Anything the enum grows to
// that isn't mapped yet degrades to the generic mv:relatedTo rather than
// minting an undocumented predicate.
const RELATION_PREDICATES: Record<string, string> = {
  requires: "mv:requires",
  assumes: "mv:assumes",
  supports: "mv:supports",
  contradicts: "mv:contradicts",
  specifies: "mv:specifies",
  defines: "mv:defines",
};

// ---------------------------------------------------------------------------
// A tiny triple model, serialized twice (TriG and JSON-LD) so the two
// representations can never drift apart.
// ---------------------------------------------------------------------------

type RdfObject =
  | { iri: string }
  | { lit: string; dt?: string };

interface Triple {
  s: string; // full IRI, or prefixed name
  p: string; // prefixed name, or "a" for rdf:type
  o: RdfObject;
}

interface NanopubGraphs {
  head: Triple[];
  assertion: Triple[];
  provenance: Triple[];
  pubinfo: Triple[];
}

/** [[claim:<uuid>]] / [[claim:<uuid>|text]] is internal machinery (§12): in
 *  exported prose, resolve each reference to its display text or the claim's
 *  canonical form, so ids never appear inside reader-facing literals. */
export function resolveClaimLinks(
  text: string,
  textById: Map<string, string>
): string {
  return text.replace(
    /\[\[claim:([0-9a-fA-F-]{36})(?:\|([^\]]*))?\]\]/g,
    (_m, id: string, display?: string) =>
      display ?? textById.get(id.toLowerCase()) ?? `claim ${id.slice(0, 8)}`
  );
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Percent-encode the characters RFC 3987 forbids raw inside <...>. */
function sanitizeIri(iri: string): string {
  return iri.replace(/[<>"{}|^`\\ ]/g, (c) => encodeURIComponent(c));
}

function iri(value: string): RdfObject {
  return { iri: sanitizeIri(value) };
}

function lit(value: string): RdfObject {
  return { lit: value };
}

function typed(value: string, dt: string): RdfObject {
  return { lit: value, dt };
}

function buildGraphs(
  record: EvidenceRecord,
  opts: { claimUri: string; pageUrl: string; generatedAt: Date }
): NanopubGraphs {
  const { claimUri, pageUrl, generatedAt } = opts;
  const npUri = `${claimUri}#nanopub`;
  const assertionUri = `${claimUri}#assertion`;

  // Canonical texts for resolving [[claim:...]] references in prose (§12):
  // the claim itself plus every basis subclaim the record carries.
  const textById = new Map<string, string>([[record.claim.id, record.claim.text]]);
  for (const a of record.arguments) {
    for (const s of a.subclaims) textById.set(s.id, s.text);
  }
  const prose = (text: string) => resolveClaimLinks(text, textById);

  const head: Triple[] = [
    { s: npUri, p: "a", o: { iri: "np:Nanopublication" } },
    { s: npUri, p: "np:hasAssertion", o: iri(assertionUri) },
    { s: npUri, p: "np:hasProvenance", o: iri(`${claimUri}#provenance`) },
    { s: npUri, p: "np:hasPublicationInfo", o: iri(`${claimUri}#pubinfo`) },
  ];

  // --- assertion: the claim, and the current verdict on it ---
  const assertion: Triple[] = [
    { s: claimUri, p: "a", o: { iri: "mv:Claim" } },
    { s: claimUri, p: "rdfs:label", o: lit(record.claim.text) },
    { s: claimUri, p: "mv:claimType", o: lit(record.claim.claim_type) },
  ];
  if (record.assessment) {
    assertion.push(
      { s: claimUri, p: "mv:status", o: lit(record.assessment.status) },
      {
        s: claimUri,
        p: "mv:confidence",
        o: typed(String(record.assessment.confidence), "xsd:decimal"),
      }
    );
    // Credence: absent exactly where the graph declines to state one (§10) —
    // the omission is itself information, so no placeholder triple.
    if (record.assessment.claim_credence != null) {
      assertion.push({
        s: claimUri,
        p: "mv:credence",
        o: typed(String(record.assessment.claim_credence), "xsd:decimal"),
      });
    }
    assertion.push({
      s: claimUri,
      p: "rdfs:comment",
      o: lit(prose(record.assessment.summary)),
    });
  }
  // Decomposition edges, one predicate per relation type.
  for (const a of record.arguments) {
    for (const s of a.subclaims) {
      const subUri = citationUrl(s.id);
      assertion.push({
        s: claimUri,
        p: RELATION_PREDICATES[s.relation] ?? "mv:relatedTo",
        o: iri(subUri),
      });
      assertion.push({ s: subUri, p: "rdfs:label", o: lit(s.text) });
      if (s.status) {
        assertion.push({ s: subUri, p: "mv:status", o: lit(s.status) });
      }
    }
  }

  // --- provenance: where the assertion comes from and why it is held ---
  const provenance: Triple[] = [];
  if (record.assessment) {
    provenance.push({
      s: assertionUri,
      p: "mv:reasoningTrace",
      o: lit(prose(record.assessment.reasoning_trace)),
    });
  }
  record.instances.forEach((inst, i) => {
    const instUri = `${claimUri}#instance-${i + 1}`;
    provenance.push(
      { s: instUri, p: "a", o: { iri: "mv:Instance" } },
      { s: instUri, p: "mv:quote", o: lit(inst.quote) },
      { s: instUri, p: "mv:stance", o: lit(inst.stance) }
    );
    if (inst.source.url) {
      const srcUri = inst.source.url;
      provenance.push(
        { s: instUri, p: "prov:wasQuotedFrom", o: iri(srcUri) },
        { s: assertionUri, p: "prov:wasDerivedFrom", o: iri(srcUri) },
        { s: srcUri, p: "dct:title", o: lit(inst.source.title) },
        {
          s: srcUri,
          p: inst.stance === "denies" ? "cito:disputes" : "cito:supports",
          o: iri(claimUri),
        }
      );
    } else {
      provenance.push({ s: instUri, p: "dct:title", o: lit(inst.source.title) });
    }
  });
  record.arguments.forEach((arg, i) => {
    const argUri = `${claimUri}#argument-${i + 1}`;
    provenance.push(
      { s: argUri, p: "a", o: { iri: "mv:Argument" } },
      { s: argUri, p: "mv:stance", o: lit(arg.stance) },
      { s: argUri, p: "rdfs:comment", o: lit(prose(arg.content)) }
    );
    if (arg.name) provenance.push({ s: argUri, p: "rdfs:label", o: lit(arg.name) });
    if (arg.verdict) provenance.push({ s: argUri, p: "mv:verdict", o: lit(arg.verdict) });
    if (arg.evaluation) {
      provenance.push({ s: argUri, p: "mv:evaluation", o: lit(prose(arg.evaluation)) });
    }
    for (const s of arg.subclaims) {
      provenance.push({ s: argUri, p: "mv:hasPremise", o: iri(citationUrl(s.id)) });
    }
    provenance.push({ s: assertionUri, p: "mv:hasArgument", o: iri(argUri) });
  });

  // --- publication info: attribution and the pinned version ---
  const pubinfo: Triple[] = [
    { s: npUri, p: "dct:creator", o: lit(CITATION_AUTHOR) },
    { s: npUri, p: "dct:license", o: iri(CONTENT_LICENSE_IRI) },
    { s: npUri, p: "dct:source", o: iri(pageUrl) },
    {
      s: npUri,
      p: "prov:generatedAtTime",
      o: typed(generatedAt.toISOString(), "xsd:dateTime"),
    },
    { s: npUri, p: "mv:claimId", o: lit(record.claim.id) },
  ];
  if (record.assessment) {
    pubinfo.push(
      { s: npUri, p: "mv:assessmentId", o: lit(record.assessment.id) },
      {
        s: npUri,
        p: "mv:assessmentVersion",
        o: typed(String(record.assessment.version), "xsd:integer"),
      },
      {
        s: npUri,
        p: "mv:assessedAt",
        o: typed(record.assessment.assessed_at, "xsd:dateTime"),
      }
    );
    if (record.assessment.model) {
      pubinfo.push({
        s: npUri,
        p: "mv:assessmentModel",
        o: lit(record.assessment.model),
      });
    }
  }

  return { head, assertion, provenance, pubinfo };
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function term(name: string): string {
  if (name === "a") return "a";
  return /^https?:/.test(name) ? `<${sanitizeIri(name)}>` : name;
}

function objectTerm(o: RdfObject): string {
  if ("iri" in o) return term(o.iri);
  const quoted = `"${escapeLiteral(o.lit)}"`;
  return o.dt ? `${quoted}^^${o.dt}` : quoted;
}

function trigGraph(name: string, triples: Triple[]): string {
  const lines = triples.map(
    (t) => `  ${term(t.s)} ${term(t.p)} ${objectTerm(t.o)} .`
  );
  return `<${sanitizeIri(name)}> {\n${lines.join("\n")}\n}`;
}

export function evidenceRecordToTrig(
  record: EvidenceRecord,
  opts: { claimUri: string; pageUrl: string; generatedAt: Date }
): string {
  const graphs = buildGraphs(record, opts);
  const prefixes = Object.entries(PREFIXES)
    .map(([p, ns]) => `@prefix ${p}: <${ns}> .`)
    .join("\n");
  return [
    prefixes,
    "",
    trigGraph(`${opts.claimUri}#Head`, graphs.head),
    "",
    trigGraph(`${opts.claimUri}#assertion`, graphs.assertion),
    "",
    trigGraph(`${opts.claimUri}#provenance`, graphs.provenance),
    "",
    trigGraph(`${opts.claimUri}#pubinfo`, graphs.pubinfo),
    "",
  ].join("\n");
}

function jsonLdObject(o: RdfObject): unknown {
  if ("iri" in o) return { "@id": o.iri };
  return o.dt ? { "@value": o.lit, "@type": o.dt } : o.lit;
}

function jsonLdGraph(name: string, triples: Triple[]): Record<string, unknown> {
  // Group triples by subject; repeated predicates accumulate into arrays.
  const bySubject = new Map<string, Record<string, unknown>>();
  for (const t of triples) {
    const node = bySubject.get(t.s) ?? { "@id": t.s };
    if (t.p === "a") {
      node["@type"] = "iri" in t.o ? t.o.iri : String(t.o);
    } else {
      const value = jsonLdObject(t.o);
      const existing = node[t.p];
      if (existing === undefined) node[t.p] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else node[t.p] = [existing, value];
    }
    bySubject.set(t.s, node);
  }
  return { "@id": name, "@graph": [...bySubject.values()] };
}

export function evidenceRecordToJsonLd(
  record: EvidenceRecord,
  opts: { claimUri: string; pageUrl: string; generatedAt: Date }
): Record<string, unknown> {
  const graphs = buildGraphs(record, opts);
  return {
    "@context": { ...PREFIXES },
    "@graph": [
      jsonLdGraph(`${opts.claimUri}#Head`, graphs.head),
      jsonLdGraph(`${opts.claimUri}#assertion`, graphs.assertion),
      jsonLdGraph(`${opts.claimUri}#provenance`, graphs.provenance),
      jsonLdGraph(`${opts.claimUri}#pubinfo`, graphs.pubinfo),
    ],
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type NanopubFormat = "trig" | "jsonld";

export async function assembleClaimNanopub(
  claimId: string,
  format: NanopubFormat,
  generatedAt: Date = new Date()
): Promise<{ contentType: string; body: string } | null> {
  const record = await assembleEvidenceRecord(claimId);
  if (!record) return null;

  const config = loadConfig();
  const opts = {
    claimUri: citationUrl(record.claim.id),
    pageUrl: `${config.publicWebBaseUrl.replace(/\/$/, "")}/claims/${record.claim.id}`,
    generatedAt,
  };

  if (format === "jsonld") {
    return {
      contentType: "application/ld+json; charset=utf-8",
      body: JSON.stringify(evidenceRecordToJsonLd(record, opts), null, 2),
    };
  }
  return {
    contentType: "application/trig; charset=utf-8",
    body: evidenceRecordToTrig(record, opts),
  };
}
