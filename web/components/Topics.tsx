import Link from "next/link";
import type { ClaimTag, TagRef, TagSummary } from "@/lib/types";
import styles from "./Territories.module.css";

// Topic tags (#272) as they appear across the site: a chip is a link into
// the claim list filtered to that topic. Tags say what a claim is ABOUT and
// nothing about whether it is true, so they are styled as navigation, never
// as a badge.

export function topicHref(slug: string): string {
  return `/claims?tag=${encodeURIComponent(slug)}&assessed=all`;
}

// How a tagging came to be, for the hover title on a claim page.
function provenance(t: ClaimTag): string {
  const who =
    t.source === "tagger"
      ? "attached by the tagger"
      : t.source === "cluster_seed"
        ? "seeded from the claim clusters"
        : `attached by the ${t.source}`;
  const conf = t.confidence != null ? `, confidence ${Math.round(t.confidence * 100)}%` : "";
  return `${t.description ? `${t.description} — ` : ""}${who}${conf}`;
}

export function TopicChips({
  tags, limit, withProvenance = false,
}: {
  tags: Array<TagRef | ClaimTag>;
  // Show at most this many (cards); the claim page shows all.
  limit?: number;
  withProvenance?: boolean;
}) {
  const shown = typeof limit === "number" ? tags.slice(0, limit) : tags;
  if (shown.length === 0) return null;
  return (
    <span className="topic-chips">
      {shown.map((t) => (
        <Link
          key={t.id}
          href={topicHref(t.slug)}
          className="tag topic"
          title={withProvenance && "source" in t ? provenance(t) : `Claims about ${t.name}`}
        >
          {t.name}
        </Link>
      ))}
    </span>
  );
}

// The strip on the /claims overview: the most-used topics, with the whole
// vocabulary one click away. Absent entirely until the tagger has run.
export function Topics({ items }: { items: TagSummary[] }) {
  if (items.length === 0) return null;
  return (
    <section className={styles.recent}>
      <div className={styles.head}>
        <h2 className={styles.recentTitle}>Topics</h2>
        <span className={styles.aside}>
          what the graph&rsquo;s claims are about · most-used first ·{" "}
          <Link href="/tags">all topics →</Link>
        </span>
      </div>
      <div className="topics-cloud">
        {items.map((t) => (
          <Link key={t.id} href={topicHref(t.slug)} className="tag topic" title={t.description || undefined}>
            {t.name}
            <span className="count">{t.claim_count}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
