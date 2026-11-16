import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { DocLayout } from "@/components/DocLayout";
import { PageHead } from "@/components/PageHead";
import { loadFeatures } from "@/lib/data";
import { docsNeighbours } from "@/lib/docs-nav";
import type { FeatureName } from "@/lib/features";
import type { TocItem } from "@/lib/toc";

// One page of the guides and reference under /docs: the head, the text at the
// reading measure with its contents in the right rail, and the previous and
// next pages in sidebar order at the foot.
export async function DocPage({
  href,
  title,
  lede,
  toc,
  wide = false,
  feature,
  children,
}: {
  /** The page's own path, as lib/docs-nav.ts lists it. */
  href: string;
  title: string;
  lede: ReactNode;
  toc: TocItem[];
  /** For a page whose body is a table or catalog that needs the full width. */
  wide?: boolean;
  /** The optional part of the product the page is about: where it is off, the page is not there. */
  feature?: FeatureName;
  children: ReactNode;
}) {
  const features = await loadFeatures();
  if (feature && !features[feature]) notFound();
  const { prev, next } = docsNeighbours(href, features);
  const pager = (
    <nav className="dc-pager" aria-label="Previous and next pages">
      {prev ? (
        <Link href={prev.href}>
          <small>Previous</small>← {prev.title}
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link href={next.href} className="dc-next">
          <small>Next</small>
          {next.title} →
        </Link>
      )}
    </nav>
  );
  if (wide) {
    return (
      <div className="dc-wide">
        <PageHead title={title} lede={lede} />
        <div className="doc dc-doc">{children}</div>
        {pager}
      </div>
    );
  }
  return (
    <DocLayout toc={toc}>
      <PageHead title={title} lede={lede} />
      <div className="doc dc-doc">{children}</div>
      {pager}
    </DocLayout>
  );
}
