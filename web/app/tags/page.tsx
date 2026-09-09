import type { Metadata } from "next";
import Link from "next/link";
import { loadTags } from "@/lib/data";
import { topicHref } from "@/components/Topics";

// The topic vocabulary (#272): every tag claims carry, most-used first, each
// opening the claim list filtered to it. A tag names what claims are ABOUT
// (a field, a subject, an entity) and says nothing about whether they hold;
// the vocabulary is grown by the tagger as claims land and tidied by hand.

export const metadata: Metadata = {
  title: "Topics · Minerval",
  description: "The topics the claim graph's claims are about, most-used first.",
};
export const dynamic = "force-dynamic";

export default async function TagsPage() {
  const { tags, source } = await loadTags(500);

  return (
    <div className="col-wide">
      <p className="sc" style={{ marginBottom: ".5rem" }}>Browse</p>
      <h1>Topics</h1>
      <p className="lede" style={{ fontSize: "1.05rem" }}>
        What the graph&rsquo;s claims are about. Each topic is a tag a small labelling agent
        attaches as claims land, reusing the vocabulary before adding to it; a topic says
        nothing about whether the claims under it hold. Open one to see its claims, each with
        its current verdict.
      </p>

      {tags.length === 0 ? (
        <p style={{ color: "var(--muted)", fontFamily: "var(--sans)" }}>
          {source === "fixture"
            ? "This preview is not connected to the live graph, so there are no topics to show."
            : "No topics yet: the tagger has not run over the graph. Claims are still searchable by meaning."}{" "}
          <Link href="/claims">→ browse and search all claims</Link>
        </p>
      ) : (
        <>
          <p className="sc" style={{ marginTop: "-0.4rem" }}>
            {tags.length} {tags.length === 1 ? "topic" : "topics"}
          </p>
          <ul className="topics-list">
            {tags.map((t) => (
              <li key={t.id}>
                <Link href={topicHref(t.slug)} className="topic-name">{t.name}</Link>
                <span className="topic-count">
                  {t.claim_count} {t.claim_count === 1 ? "claim" : "claims"}
                </span>
                {t.description && <span className="topic-desc">{t.description}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
