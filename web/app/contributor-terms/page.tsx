import Link from "next/link";
import { getDoc } from "@/lib/content";
import { Markdown } from "@/components/Markdown";
import { DocLayout } from "@/components/DocLayout";
import { extractToc } from "@/lib/toc";

// The Contributor Terms: the contributor's side of the graph's CC0
// dedication, plus the promises a contribution carries and what the agents
// do with it. Vendored verbatim from docs/contributor-terms.md by
// scripts/sync-frontend-content.ts. Reachable by URL but not linked from the
// footer until the terms have an effective date (same treatment as
// /rewards and /contributors, #191).

export const metadata = {
  title: "Contributor Terms · Minerval",
  description:
    "What you dedicate, what you promise, and what Minerval's agents do with a contribution to the claim graph.",
};

export default function ContributorTermsPage() {
  const text = getDoc("contributor-terms");
  const toc = extractToc(text, { minDepth: 2, maxDepth: 2 });
  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs">← docs</Link>
      </p>
      <DocLayout
        toc={toc}
        aside={
          <aside className="rail-note">
            <span className="sc">Not yet in force</span>
            The graph&rsquo;s content is already dedicated to the public domain
            under CC0. These terms put the contributor&rsquo;s side of that
            dedication on the record before they are required at submission.
          </aside>
        }
      >
        <Markdown>{text}</Markdown>
      </DocLayout>
    </div>
  );
}
