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
/**
 * A stretch of plain text from a published page (docs/published-pages.md),
 * with each removal's mark set apart: "[redacted: <category>]" where the
 * publisher's policy took a passage out. Only the categories the page's own
 * record counts are taken for marks, so an author's square brackets stay
 * prose.
 */
function WithMarks({ text, categories }: { text: string; categories: string[] }) {
  const marks = categories.map((c) => `[redacted: ${c}]`);
  const out: React.ReactNode[] = [];
  let rest = text;
  for (let n = 0; rest.length > 0; n++) {
    let at = -1;
    let mark = "";
    for (const m of marks) {
      const i = rest.indexOf(m);
      if (i !== -1 && (at === -1 || i < at)) {
        at = i;
        mark = m;
      }
    }
    if (at === -1) {
      out.push(rest);
      break;
    }
    if (at > 0) out.push(rest.slice(0, at));
    out.push(
      <span
        key={n}
        className="redaction"
        title={`A passage was removed here under the publisher's redaction policy, in the category "${mark.slice(11, -1)}". The mark says nothing else about it.`}
      >
        {mark}
      </span>,
    );
    rest = rest.slice(at + mark.length);
  }
  return <>{out}</>;
}

export function ArgumentText({
  content,
  texts,
  categories,
}: {
  content: string;
  texts?: Map<string, string>;
  /** On a published page: the categories its removals are marked with. */
  categories?: string[];
}) {
  return (
    <>
      {parseProse(content).map((seg, i) => {
        if (seg.kind === "text") {
          return <span key={i}>{categories?.length ? <WithMarks text={seg.text} categories={categories} /> : seg.text}</span>;
        }
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
