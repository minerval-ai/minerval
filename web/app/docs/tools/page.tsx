import Link from "next/link";
import { DocPage } from "@/components/docs/DocPage";
import { ToolList } from "@/components/docs/ToolList";
import { apiConfigured, fetchMcpTools } from "@/lib/api";
import { buildCatalog, type CatalogGroup } from "@/lib/tool-catalog";

export const metadata = {
  title: "MCP tools · Minerval docs",
  description: "Every tool the Minerval MCP server offers, grouped by task, with what each costs and the REST route it runs.",
};

// Read from the server's own tools/list when the page renders, so the
// catalog cannot fall behind the server (lib/tool-catalog.ts).
async function load(): Promise<CatalogGroup[] | null> {
  if (!apiConfigured()) return null;
  try {
    return buildCatalog(await fetchMcpTools());
  } catch {
    return null;
  }
}

export default async function Page() {
  const groups = await load();
  const tools = groups?.flatMap((g) => g.tools) ?? [];
  const n = (cost: string) => tools.filter((t) => t.cost === cost).length;
  return (
    <DocPage
      href="/docs/tools"
      title="MCP tools"
      wide
      toc={[]}
      lede={
        <>
          Every tool the server offers, grouped by task, with what each costs.
          {groups && (
            <>
              {" "}
              {tools.length} here: {n("read")} free reads, {n("write")} free writes, {n("charged")} charged,{" "}
              {n("escrow")} that escrow owls.
            </>
          )}{" "}
          A tool built on a REST route runs that route, with the same validation, charges and errors; the route is
          named under its description.
        </>
      }
    >
      <div className="dc-legend">
        <span className="dc-pill dc-read">Free read</span>
        <span className="dc-pill dc-write">
          Free write: costs nothing; anything that would change the graph is reviewed first, and the rest is recorded
          on your account
        </span>
        <span className="dc-pill dc-charged">Charged: holds its cap when the work starts, then settles to the metered cost</span>
        <span className="dc-pill dc-escrow">Escrow: moves owls into a budget; what is not spent comes back</span>
      </div>
      <p className="dc-small">
        A charged tool needs a balance of at least its cap to start, and never costs more than the cap.{" "}
        <code>query_sql</code> is the exception to the hold: it is free within a daily allowance of database time and
        billed by the second past it. <Link href="/docs/owls">Owls and pricing</Link> has every cap.
      </p>
      {groups ? (
        <ToolList groups={groups} />
      ) : (
        <p className="dc-small">
          The catalog is read from the API when this page renders, and the API did not answer. The{" "}
          <a href="https://api.claimgraph.io/docs">OpenAPI explorer</a> lists every route, and an MCP client lists the
          tools when it connects.
        </p>
      )}
      <p className="dc-small">
        A members-only deployment adds tools for permissions, labels, connections and file sets, and offers each only to
        callers who hold the permission it needs. <code>list_features</code> says which optional parts a deployment has
        switched on.
      </p>
    </DocPage>
  );
}
