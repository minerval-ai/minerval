"use client";

import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { OwlMark } from "../../components/OwlMark";
import { StandingBadge, StatusBadge } from "../../components/Assessment";
import { statusMeta } from "../../lib/ontology";
import type { AssistantCitationView } from "../../lib/account-api";

// What a reply and a page share: markdown in which [claim:<uuid>] is a
// numbered citation of the graph, carrying the node's current status.

const CITE_RE = /(\s*)\[claim:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/** Micro-USD of metered cost as owls (one owl covers $1.00). */
export function owls(microUsd: number): string {
  const n = Math.max(0, microUsd) / 1_000_000;
  if (n > 0 && n < 0.01) return "under 0.01";
  return Number(n.toFixed(2)).toString();
}

export function Owls({ microUsd }: { microUsd: number }) {
  return (
    <span className="ask-owls">
      <OwlMark size={13} className="owl-mark" />
      {owls(microUsd)}
    </span>
  );
}

/**
 * The reply's markdown with each [claim:<uuid>] turned into a numbered link.
 * A marker whose node the graph does not hold is dropped.
 */
function withCitations(content: string, citations: AssistantCitationView[]): string {
  const number = new Map(citations.map((c, i) => [c.id, i + 1]));
  return content.replace(CITE_RE, (_m, space: string, id: string) => {
    const n = number.get(id.toLowerCase());
    return n ? `${space}[${n}](/claims/${id.toLowerCase()} "cite")` : "";
  });
}

export function Prose({
  content,
  citations = [],
}: {
  content: string;
  citations?: AssistantCitationView[];
}) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const components: Components = {
    a: ({ href, title, children }) => {
      const cited = title === "cite" && href ? byId.get(href.replace("/claims/", "")) : undefined;
      if (cited) {
        const meta = cited.kind === "claim" ? statusMeta(cited.status) : null;
        return (
          <Link
            href={href!}
            className={`ask-cite${meta ? ` ${meta.cls}` : ""}`}
            title={`${cited.text}${meta ? ` (${meta.label})` : ""}`}
          >
            {children}
            {meta && <span aria-hidden>{meta.glyph}</span>}
          </Link>
        );
      }
      const external = !!href && /^https?:\/\//.test(href);
      return (
        <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
          {children}
        </a>
      );
    },
  };
  return (
    <div className="ask-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {withCitations(content, citations)}
      </ReactMarkdown>
    </div>
  );
}

export function Cited({ citations }: { citations: AssistantCitationView[] }) {
  if (citations.length === 0) return null;
  return (
    <ol className="ask-cited">
      {citations.map((c) => (
        <li key={c.id}>
          <Link href={`/claims/${c.id}`}>{c.text}</Link>{" "}
          {c.kind === "claim" ? (
            <StatusBadge status={c.status} />
          ) : c.kind === "question" ? (
            <StandingBadge standing={c.standing} />
          ) : (
            <span className="tag kind">{c.kind}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
