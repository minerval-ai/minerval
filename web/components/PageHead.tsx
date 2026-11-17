import Link from "next/link";
import type { ReactNode } from "react";

// The head of every page: one component so the line above the heading, the
// heading and the paragraph under it look the same wherever you land. A page
// does not write its own <h1>; tests/unit/web/page-head.test.ts holds that.
//
// The slots, in the order they render:
//   back     where you came from: "← parent", always first.
//   kicker   what kind of thing this is ("Claim", "Request", "Agent 03"),
//            with its chips in `tags`. Never a repeat of the title and never
//            a tagline; an index page whose title already says what it is
//            has none.
//   title    the <h1>. `variant="page"` for a name (Claims, a grant, an
//            agent); `variant="statement"` where the title is a sentence the
//            page is about (a claim, a request's ask, a source's title).
//   meta     one muted line of facts about the thing (dates, owner, version).
//   lede     the paragraph that says what the page is.
//
// A page of the members' workspace (components/work) passes `tool`: the same
// slots drawn as a tool's head, compact and in sans-serif, with `crumbs`
// above the title, `meta` as the line under it, `tags` as chips beside it,
// and `actions` at the far end. Such a page has no lede; one line of `meta`
// says what needs saying.

export type PageBackTarget = { href: string; label: string };

export function PageBack({ href, label }: PageBackTarget) {
  return (
    <p className="page-back sc">
      <Link href={href}>← {label}</Link>
    </p>
  );
}

export function PageHead({
  back,
  kicker,
  tags,
  beforeTitle,
  title,
  variant = "page",
  actions,
  meta,
  lede,
  tool = false,
  crumbs,
}: {
  back?: PageBackTarget;
  kicker?: ReactNode;
  tags?: ReactNode;
  /** A second row between the kicker and the title (the claim page's topics). */
  beforeTitle?: ReactNode;
  title: ReactNode;
  variant?: "page" | "statement";
  /** Controls that sit on the title's line, at its far end (sign out). */
  actions?: ReactNode;
  meta?: ReactNode;
  lede?: ReactNode;
  /** Draw the head of a workspace page (components/work). */
  tool?: boolean;
  /** Where the page sits, above its title, on a workspace page. */
  crumbs?: ReactNode;
}) {
  if (tool) {
    return (
      <header className="page-head w-head">
        {crumbs && <nav className="w-crumbs" aria-label="Where this page is">{crumbs}</nav>}
        <div className="w-ph">
          <div>
            {kicker && <p className="page-kicker w-kicker">{kicker}</p>}
            <h1 className={variant === "statement" ? "page-title w-title statement" : "page-title w-title"}>{title}</h1>
            {meta && <p className="page-meta w-sub">{meta}</p>}
            {tags && <div className="w-ph-tags">{tags}</div>}
          </div>
          {actions && <div className="w-ph-actions">{actions}</div>}
        </div>
        {lede && <p className="page-lede w-sub">{lede}</p>}
      </header>
    );
  }
  const h1 = (
    <h1 className={variant === "statement" ? "page-title statement" : "page-title"}>{title}</h1>
  );
  return (
    <header className="page-head">
      {back && <PageBack {...back} />}
      {(kicker || tags) && (
        <div className="page-kicker">
          {kicker && <span className="sc">{kicker}</span>}
          {tags}
        </div>
      )}
      {beforeTitle}
      {actions ? (
        <div className="page-title-row">
          {h1}
          <div className="page-actions">{actions}</div>
        </div>
      ) : (
        h1
      )}
      {meta && <p className="page-meta">{meta}</p>}
      {lede && <p className="page-lede">{lede}</p>}
    </header>
  );
}
