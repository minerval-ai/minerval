import Link from "next/link";
import { getDoc } from "@/lib/content";
import { Markdown } from "@/components/Markdown";
import { DocLayout } from "@/components/DocLayout";
import { extractToc } from "@/lib/toc";

export const metadata = { title: "The Administrator Constitution · Minerval" };

export default function ConstitutionPage() {
  const text = getDoc("constitution");
  const toc = extractToc(text, { minDepth: 2, maxDepth: 3 });
  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs">← docs</Link>
      </p>
      <DocLayout
        toc={toc}
        aside={
          <aside className="rail-note">
            <span className="sc">Verbatim</span>
            This is the canonical text given, in full, to every administrator agent as the
            first layer of its system prompt. Shown here exactly as the agents receive it.
          </aside>
        }
      >
        <Markdown>{text}</Markdown>
      </DocLayout>
    </div>
  );
}
