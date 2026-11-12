import Link from "next/link";
import type { ArgumentPage, ClaimCard, SourceFacts } from "@/lib/types";
import type { LinkTarget, NumberedParagraph } from "@/lib/findings";
import { Standing } from "./FindingParts";

// A finding's account, as written, with what it links to in the margin: each
// linked passage is tinted and numbered, and a small card beside the
// paragraph says what the record is and where it stands now (the look of the
// About page's annotated sidenotes). The cards are the page's addition and
// are mechanical: the record's own wording and its current judgment, nothing
// about the finding. An account with no links has an empty margin and reads
// as it always did.

/** What the page could read about each linked record, keyed "kind:id". */
export interface LinkedRecords {
  claims: Map<string, ClaimCard>;
  sources: Map<string, SourceFacts>;
  arguments: Map<string, ArgumentPage>;
}

const KIND_LABEL: Record<string, string> = {
  claim: "Claim",
  question: "Question",
  quantity: "Quantity",
};

function year(date: string | null): string | null {
  return date ? date.slice(0, 4) : null;
}

/** The words a link shows when its author gave none: the record's own name. */
function nameOf(target: LinkTarget, records: LinkedRecords): string {
  if (target.kind === "claim") return records.claims.get(target.id)?.text ?? "linked claim";
  if (target.kind === "source") return records.sources.get(target.id)?.source.title ?? "linked source";
  const a = records.arguments.get(target.id)?.argument;
  return a?.name ?? a?.conclusion.text ?? "linked argument";
}

function MarginCard({
  n,
  target,
  href,
  records,
}: {
  n: number;
  target: LinkTarget;
  href: string;
  records: LinkedRecords;
}) {
  if (target.kind === "claim") {
    const card = records.claims.get(target.id);
    return (
      <Link href={href} className="fnd-card" id={`fnd-note-${n}`}>
        <span className="fnd-card-kind">
          <span>
            {n} · {KIND_LABEL[card?.kind ?? "claim"] ?? "Claim"}
          </span>
          <Standing card={card} plain />
        </span>
        {card?.text ?? "A claim on the graph."}
      </Link>
    );
  }
  if (target.kind === "source") {
    const source = records.sources.get(target.id)?.source;
    const meta = source
      ? [source.source_type.replace(/_/g, " "), source.publisher, year(source.published_date)]
          .filter(Boolean)
          .join(" · ")
      : null;
    return (
      <Link href={href} className="fnd-card" id={`fnd-note-${n}`}>
        <span className="fnd-card-kind">
          <span>{n} · Source</span>
        </span>
        {source?.title ?? "A source on the graph."}
        {meta && <span className="fnd-card-meta">{meta}</span>}
      </Link>
    );
  }
  const argument = records.arguments.get(target.id)?.argument;
  return (
    <Link href={href} className="fnd-card" id={`fnd-note-${n}`}>
      <span className="fnd-card-kind">
        <span>{n} · Argument</span>
      </span>
      {argument?.name ?? "An argument on the graph."}
      {argument?.conclusion.text && (
        <span className="fnd-card-meta">
          {argument.stance.replace(/_/g, " ")}: {argument.conclusion.text}
        </span>
      )}
    </Link>
  );
}

export function FindingAccount({
  paragraphs,
  targets,
  records,
}: {
  paragraphs: NumberedParagraph[];
  targets: LinkTarget[];
  records: LinkedRecords;
}) {
  const hrefOf = new Map<number, string>();
  for (const p of paragraphs) {
    for (const seg of p.segments) if (seg.kind === "ref") hrefOf.set(seg.n, seg.href);
  }
  return (
    <div className={targets.length > 0 ? "fnd-account" : "fnd-account plain"}>
      {paragraphs.map((p, i) => (
        <div className="fnd-row" key={i}>
          <p>
            {p.segments.map((seg, j) => {
              if (seg.kind === "text") return <span key={j}>{seg.text}</span>;
              if (seg.kind === "url") {
                return (
                  <a key={j} href={seg.href} className="prose-url" rel="nofollow noopener">
                    {seg.href.replace(/^https?:\/\//, "")}
                  </a>
                );
              }
              return (
                <Link key={j} href={seg.href} className="annot" aria-describedby={`fnd-note-${seg.n}`}>
                  {seg.display || nameOf(seg.target, records)}
                  <sup className="annot-num">{seg.n}</sup>
                </Link>
              );
            })}
          </p>
          {targets.length > 0 && (
            <div className="fnd-notes">
              {p.notes.map((n) => (
                <MarginCard
                  key={n}
                  n={n}
                  target={targets[n - 1]!}
                  href={hrefOf.get(n) ?? "#"}
                  records={records}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
