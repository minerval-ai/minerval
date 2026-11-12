import Link from "next/link";
import { parseProse, recordHref } from "@/lib/claim-links";

/**
 * The graph's inline prose conventions, rendered: [[claim:<id>]] references
 * become links to the claims they name, and bare source URLs become external
 * links (issue #203). For a claim link, authored inline phrasing wins;
 * otherwise the claim's canonical text (via `texts`, usually built from the
 * decomposition tree with buildClaimTextMap); otherwise a generic label. Each
 * claim link carries the ↗ open-claim affordance used in the tree and on the
 * map, marking the linked phrase as itself a claim with a page (issue #200).
 * Serves argument written forms and evaluations (#129/#173) and assessment
 * prose (#203) alike.
 */
export function ArgumentText({
  content,
  texts,
}: {
  content: string;
  texts?: Map<string, string>;
}) {
  return (
    <>
      {parseProse(content).map((seg, i) => {
        if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
        if (seg.kind === "url") {
          return (
            <a key={i} href={seg.href} className="prose-url" rel="nofollow noopener">
              {seg.href.replace(/^https?:\/\//, "")}
            </a>
          );
        }
        if (seg.kind === "record") {
          // An argument or a source named in prose: a plain link to its page.
          return (
            <Link key={i} href={recordHref(seg.record, seg.id)} className="argform-link">
              {seg.display || (seg.record === "argument" ? "linked argument" : "linked source")}
            </Link>
          );
        }
        const canonical = texts?.get(seg.claimId);
        return (
          <Link
            key={i}
            href={`/claims/${seg.claimId}`}
            className="argform-link"
            title={canonical && seg.display ? canonical : "open this claim"}
          >
            {seg.display ?? canonical ?? "linked claim"}
            <span className="open-claim" aria-hidden="true">↗&#xFE0E;</span>
          </Link>
        );
      })}
    </>
  );
}
