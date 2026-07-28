import Link from "next/link";
import { getDoc } from "@/lib/content";
import { Markdown } from "@/components/Markdown";
import { DocLayout } from "@/components/DocLayout";
import { extractToc } from "@/lib/toc";

export const metadata = { title: "Architecture & policies · Minerval" };

export default function ArchitecturePage() {
  const architecture = getDoc("architecture");
  const policies = getDoc("policies");

  // One TOC spanning both docs. Architecture contributes H2/H3; policies is
  // re-leveled (its H1 becomes a section break, its H2 the entries beneath) and
  // namespaced with a "pol-" prefix that matches the Markdown idPrefix below.
  const archToc = extractToc(architecture, { minDepth: 2, maxDepth: 3 });
  const polToc = extractToc(policies, { minDepth: 1, maxDepth: 2, prefix: "pol-" }).map(
    (item) => ({ ...item, depth: item.depth + 1 })
  );
  const toc = [...archToc, ...polToc];

  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs">← docs</Link>
      </p>
      <DocLayout toc={toc}>
        <Markdown>{architecture}</Markdown>
        <hr className="thin" />
        <p className="sc" style={{ marginBottom: ".4rem" }}>Operational policies</p>
        <Markdown idPrefix="pol-">{policies}</Markdown>
      </DocLayout>
    </div>
  );
}
