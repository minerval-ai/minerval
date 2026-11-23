import { isOpenLabel, layersOf } from "@/lib/label-layers";
import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { Drawer, Empty } from "@/components/work/ui";
import { fetchMyLabels, type MyLabel } from "@/lib/admin-api";
import { fetchClaimDetail, fetchSearch } from "@/lib/api";
import type { SearchResultItem } from "@/lib/types";
import { ReleasesView } from "../ReleasesView";
import { loadGates } from "../releases";
import { NewReleaseForm } from "./NewReleaseForm";

export const metadata: Metadata = { title: "New release · Minerval" };
export const dynamic = "force-dynamic";

// Releasing a node's page to people who do not read the label
// it was written at (POST /releases; docs/releasing-a-page.md, "Asking"), in a
// drawer over the list of releases. A node's page links here with
// ?node=&at=; without a node, the drawer first finds one, by the same search
// /claims uses. Nothing about how the page is released is preselected: it is
// chosen each time it is asked for.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default async function NewReleasePage({ searchParams }: { searchParams: Promise<{ node?: string; at?: string; q?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct")) return <NeedsPermission title="New release" permission="direct" />;
  const layers = layersOf(who.mine);
  const { node, at, q } = await searchParams;
  // A node's address or id pasted into the search is taken as that node.
  const nodeId = node ?? q?.match(UUID)?.[0];
  const detail = nodeId ? await fetchClaimDetail(nodeId).catch(() => null) : null;

  let body;
  if (!detail) {
    const query = (q ?? "").trim();
    const results: SearchResultItem[] = query && !nodeId ? await fetchSearch(query).catch(() => []) : [];
    body = (
      <>
        <form method="get" action="/releases/new" className="w-field" role="search">
          <label htmlFor="ns-q">Node</label>
          <div className="w-row" style={{ flexWrap: "nowrap" }}>
            <input id="ns-q" className="w-input" type="search" name="q" defaultValue={query} placeholder="Search nodes, or paste a node's address" autoFocus />
            <button className="w-btn" type="submit">
              Find
            </button>
          </div>
          {nodeId && <span className="w-said w-error">No node you read has that id.</span>}
        </form>
        {query && !nodeId && (
          <div className="w-tbox">
            {results.length === 0 ? (
              <Empty>No node found for &ldquo;{query}&rdquo;.</Empty>
            ) : (
              <table className="w-t" aria-label="Nodes">
                <tbody>
                  {results.slice(0, 8).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link className="w-node w-sm" href={`/releases/new?node=${r.id}`} style={{ color: "var(--w-ink)" }}>
                          {r.text}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <p className="w-help" style={{ margin: 0 }}>
          Or open the node, choose the assessment made at the label you want released, and follow &ldquo;Release this page to them&rdquo;.
        </p>
      </>
    );
  } else {
    // One page per label, the one in force first; what anyone may read is in front of everyone already.
    const byLabel = new Map<string, { label: string; assessedAt: string }>();
    for (const v of [...(detail.versions ?? [])].sort((a, b) => Number(b.in_force) - Number(a.in_force))) {
      if (!isOpenLabel(v.label, layers) && !byLabel.has(v.label)) byLabel.set(v.label, { label: v.label, assessedAt: v.assessed_at });
    }
    const [mine, gates] = await Promise.all([fetchMyLabels(who.externalId).catch(() => null), loadGates(who.externalId)]);
    body = (
      <>
        <div className="w-field">
          <span className="w-label">Node</span>
          <div className="w-row" style={{ flexWrap: "nowrap", alignItems: "baseline" }}>
            <Link className="w-node" href={`/claims/${detail.claim.id}`} style={{ color: "var(--w-ink)", flex: 1, minWidth: 0 }}>
              {detail.claim.text}
            </Link>
            <Link className="w-small" href="/releases/new">
              Change
            </Link>
          </div>
        </div>
        {byLabel.size === 0 ? (
          <Empty>
            This node has no assessment that some members cannot read, among the labels you read, so there is nothing to release: everyone who can open
            the node already reads all of it that you do.
          </Empty>
        ) : (
          <NewReleaseForm
            nodeId={detail.claim.id}
            pages={[...byLabel.values()]}
            at={at ?? null}
            labels={(mine?.labels ?? []).map((l: MyLabel & { reads?: string[] }) => ({ name: l.name, whoReads: l.who_reads, reads: l.reads ?? [], everyMember: l.read_by_everyone ?? l.name === layers.base }))}
            gates={(gates ?? []).map((g) => ({ id: g.gate_id, from: g.from, to: g.to_outside ? "outside" : g.to }))}
          />
        )}
      </>
    );
  }

  return (
    <ReleasesView
      who={who}
      query={{}}
      drawer={
        <Drawer title="New release" close="/releases" wide>
          {body}
        </Drawer>
      }
    />
  );
}
