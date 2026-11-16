import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs/DocsNav";
import { loadFeatures } from "@/lib/data";
import { docsNav } from "@/lib/docs-nav";

// Every page under /docs sits beside one sidebar (lib/docs-nav.ts), so a
// reader can move between the guides, the reference and the governance
// documents without going back to an index first.
export default async function DocsLayout({ children }: { children: ReactNode }) {
  const features = await loadFeatures();
  return (
    <div className="docs-shell">
      <DocsNav groups={docsNav(features)} />
      <div className="docs-page">{children}</div>
    </div>
  );
}
