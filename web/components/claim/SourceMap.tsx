import type {
  Instance,
  InstanceReading,
  ProvenanceEdge,
  SourceMapSummary,
  SourceRelationship,
} from "@/lib/types";

// Source provenance (#286): what the claim's support rests on, as the
// Steward recorded it. Three pieces, each rendering nothing until the API
// serves it. The summary is the Steward's prose and appears only when the
// Steward judged the structure material; the per-instance line says what
// the Steward found on opening that source; the record behind a disclosure
// is for the audit-minded and is never the default presentation. No scores
// anywhere: the constitution forbids a mechanism that weighs evidence, and
// the page shows judgments, in words.

const SUPPORT_LINE: Record<InstanceReading["support"], string | null> = {
  supports: "The source's own evidence bears what it asserts.",
  overstates: "The assertion outruns the source's own evidence.",
  understates: "The source's evidence would bear a stronger statement than it makes.",
  asserts_without_evidence: "Asserted without evidence of the source's own.",
  contradicts_own_evidence: "The source's own material cuts against its assertion.",
  unclear: null,
};

const RELATION_VERB: Record<ProvenanceEdge["relation_type"], string> = {
  repeats: "restates",
  derives_from: "draws its statement from",
  reanalyzes: "reanalyzes the data behind",
  republishes: "republishes",
  cites_as_evidence: "cites in support",
  responds_to: "responds to",
};

const FIDELITY_CLAUSE: Record<ProvenanceEdge["fidelity"], string> = {
  faithful: ", faithfully",
  strengthened: ", stating it more strongly than that document supports",
  weakened: ", stating it more cautiously than that document warrants",
  distorted: ", in a way that document does not support",
  misattributed: ", crediting it with something it does not say",
  unclear: "",
};

function sourceName(s: { title: string; url: string | null }) {
  return s.url ? <a href={s.url}>{s.title}</a> : <span>{s.title}</span>;
}

/** The Steward's account of what the support rests on, when it judged it worth showing. */
export function SourceMapNote({ map }: { map: SourceMapSummary | null | undefined }) {
  if (!map || !map.material) return null;
  return (
    <div className="source-map">
      <span className="sc" style={{ display: "block", marginBottom: ".25rem" }}>
        What the support rests on
      </span>
      <p style={{ margin: 0 }}>{map.summary}</p>
    </div>
  );
}

/** What the Steward found on opening this instance's source against the claim. */
export function InstanceReadingLine({ reading }: { reading: InstanceReading | null | undefined }) {
  if (!reading) return null;
  const support = SUPPORT_LINE[reading.support] ?? null;
  const misquoted = reading.quote_check === "not_found";
  if (!support && !reading.note && !misquoted && !reading.worth_reading) return null;
  return (
    <p className="instance-reading">
      {support && <span>{support} </span>}
      {reading.note && <span>{reading.note} </span>}
      {reading.worth_reading && reading.worth_reading_reason && (
        <span>Worth reading closely: {reading.worth_reading_reason} </span>
      )}
      {misquoted && (
        <span className="caution">
          The quoted passage was not found in the stored copy of this source.
        </span>
      )}
    </p>
  );
}

/**
 * The record behind the summary: which assertions draw on which documents,
 * and which documents are one voice. Behind a disclosure, in words.
 */
export function ProvenanceRecord({
  instances,
  edges,
  relationships,
}: {
  instances: Instance[];
  edges: ProvenanceEdge[] | null | undefined;
  relationships: SourceRelationship[] | null | undefined;
}) {
  const edgeList = edges ?? [];
  const relList = relationships ?? [];
  if (edgeList.length === 0 && relList.length === 0) return null;
  const byInstance = new Map(instances.map((i) => [i.id, i] as const));
  return (
    <details className="reasoning-detail provenance-record">
      <summary>How these sources relate</summary>
      <ul>
        {edgeList.map((e) => {
          const from = byInstance.get(e.from_instance_id);
          if (!from) return null;
          return (
            <li key={e.id}>
              {sourceName({ title: from.source_title, url: from.source_url })}{" "}
              {RELATION_VERB[e.relation_type] ?? "draws on"}{" "}
              {sourceName(e.to_source)}
              {FIDELITY_CLAUSE[e.fidelity] ?? ""}.
              {e.reasoning && <span className="provenance-why"> {e.reasoning}</span>}
              {!e.target_read && (
                <span className="caution"> Judged from the citing document alone.</span>
              )}
            </li>
          );
        })}
        {relList.map((r) => (
          <li key={r.id}>
            {r.relation_type === "shares_authorship" ? (
              <>
                {sourceName(r.parent_source)} and {sourceName(r.child_source)} share an author.
              </>
            ) : r.relation_type === "republishes" ? (
              <>
                {sourceName(r.child_source)} republishes {sourceName(r.parent_source)}.
              </>
            ) : (
              <>
                {sourceName(r.parent_source)} is a later version of {sourceName(r.child_source)}.
              </>
            )}
            {r.reasoning && <span className="provenance-why"> {r.reasoning}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
