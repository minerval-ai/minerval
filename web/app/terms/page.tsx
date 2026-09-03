import Link from "next/link";
import { getDoc } from "@/lib/content";
import { Markdown } from "@/components/Markdown";
import { DocLayout } from "@/components/DocLayout";
import { extractToc } from "@/lib/toc";

// The Terms of Service: the agreement covering the whole product, from the
// website and API to the extension, the MCP server, owls, paid work, and
// contributions, incorporating the Contributor Terms, the Contributor
// Rewards Policy, and the Privacy Policy by reference. Vendored verbatim
// from docs/terms-of-service.md by scripts/sync-frontend-content.ts.
// Reachable by URL but not linked from the footer until the terms have an
// effective date (same treatment as /rewards, /contributor-terms, and
// /contributors, #191).

export const metadata = {
  title: "Terms of Service · Minerval",
  description:
    "The agreement between you and Minerval, Inc. for the website, the API, the browser extension, the MCP server, owls, paid work, and contributions.",
};

export default function TermsOfServicePage() {
  const text = getDoc("terms-of-service");
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
            These terms have no effective date yet and nothing on the site
            asks you to accept them. They are published so the agreement is
            on the record before it is required, alongside the Contributor
            Terms and the Contributor Rewards Policy they incorporate.
          </aside>
        }
      >
        <Markdown>{text}</Markdown>
      </DocLayout>
    </div>
  );
}
