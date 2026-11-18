import Link from "next/link";
import type { ReactNode } from "react";
import { can, type Viewer } from "@/components/admin/access";
import { Pipeline } from "@/components/work/Pipeline";
import { Boundary, ButtonLink, Empty, Table, Tabs, Tip, WorkHead, WorkPage, plural, shortDay } from "@/components/work/ui";
import { fetchShowings, type AskedShowingRow, type ShownShowing, type ShownShowingRow } from "@/lib/inside-api";
import { NOT_YET_ASSESSED, type Pipeline as Status, type PipelineKey } from "@/lib/pipeline";
import { ShowingsFilter } from "./ShowingsFilter";
import { destinationOf, fetchDetails, gateFor, kindOf, latestPage, loadGates, statusOf, versionsById, wholeOf } from "./showings";

// The list of releases (GET /showings), in two tabs: those asked for from a
// label the viewer reads, with where each one's latest page stands on its way
// across, and those released to a label the viewer reads, or outside. One row
// per release, one status per row (lib/pipeline.ts), and the act that is
// due, where one is. /releases/new draws this list behind its drawer.

export interface ShowingsQuery {
  tab?: string;
  q?: string;
  boundary?: string;
  status?: string;
  ended?: string;
}

interface Row {
  id: string;
  node: string | null;
  whole: string | null;
  more: number;
  from: string | null;
  to: string;
  form: string;
  scope: string;
  latest: string | null;
  status: Status;
  ended: string | null;
}

const STATUSES: Array<{ key: PipelineKey | "needs"; label: string }> = [
  { key: "needs", label: "Needs something" },
  { key: "funds", label: "Waiting for funds" },
  { key: "redacting", label: "Redacting" },
  { key: "audit", label: "Audit check" },
  { key: "gate", label: "At the gate" },
  { key: "held", label: "Held" },
  { key: "shown_whole", label: "Released whole" },
  { key: "shown_in_part", label: "Released in part" },
  { key: "cannot_cross", label: "Can't cross" },
  { key: "overtaken", label: "Overtaken" },
  { key: "not_yet_assessed", label: "Not yet assessed" },
];

function askedRow(a: AskedShowingRow, detail: ShownShowing | undefined): Row {
  const page = latestPage(a.pages);
  const version = page ? versionsById(detail).get(page.page_id) : undefined;
  const nodes = detail ? detail.nodes.length : new Set([a.node_id, ...a.pages.map((p) => p.node_id)].filter(Boolean)).size;
  return {
    id: a.showing_id,
    node: a.node,
    whole: a.node_id ? null : wholeOf(a.scope, a.page_label),
    more: a.node_id ? Math.max(0, nodes - 1) : nodes,
    from: a.page_label,
    to: destinationOf(a.shown_to),
    form: a.form,
    scope: a.scope,
    latest: page?.version_of ?? null,
    status: page ? statusOf(page, version) : NOT_YET_ASSESSED,
    ended: a.ended_at,
  };
}

function shownRow(s: ShownShowingRow, detail: ShownShowing | undefined, asked: AskedShowingRow | undefined): Row {
  const node = detail?.nodes.find((n) => n.node_id === s.node_id) ?? detail?.nodes[0];
  const pages = new Map((asked?.pages ?? []).map((p) => [p.page_id, p]));
  // The newest version that was not overtaken, as the latest page is chosen on the other side.
  const statuses = (node?.versions ?? []).map((v) => ({ v, status: statusOf(pages.get(v.page_id), v) }));
  const latest = statuses.find((x) => x.status.key !== "overtaken") ?? statuses[0];
  const nodes = detail?.nodes.length ?? 0;
  return {
    id: s.showing_id,
    node: node?.text ?? asked?.node ?? null,
    whole: s.node_id ? null : wholeOf(s.scope, asked?.page_label ?? null),
    more: s.node_id ? Math.max(0, nodes - 1) : nodes,
    from: asked?.page_label ?? null,
    to: destinationOf(s.shown_to),
    form: s.form,
    scope: s.scope,
    latest: latest?.v.version_of ?? null,
    status: latest?.status ?? NOT_YET_ASSESSED,
    ended: s.ended_at,
  };
}

export async function ShowingsView({ who, query, drawer }: { who: Viewer; query: ShowingsQuery; drawer?: ReactNode }) {
  const [{ shown, asked }, gates] = await Promise.all([
    fetchShowings(who.externalId).catch(() => ({ shown: [] as ShownShowingRow[], asked: [] as AskedShowingRow[] })),
    loadGates(who.externalId),
  ]);
  const tab = query.tab === "shown" || query.tab === "asked" ? query.tab : asked.length === 0 && shown.length > 0 ? "shown" : "asked";
  const shownIds = new Set(shown.map((s) => s.showing_id));
  const askedById = new Map(asked.map((a) => [a.showing_id, a]));

  // Only what this tab draws is fetched one by one: on the asked tab, the other side's state for a page
  // that may be waiting for funds or at the gate, where the viewer reads that side too.
  const wanted =
    tab === "shown"
      ? shown.map((s) => s.showing_id)
      : asked
          .filter((a) => shownIds.has(a.showing_id) && ["to_redact", "to_check", "at_gate"].includes(latestPage(a.pages)?.stage ?? ""))
          .map((a) => a.showing_id);
  const details = await fetchDetails(who.externalId, wanted);

  const askedRows = asked.map((a) => askedRow(a, details.get(a.showing_id)));
  const rows = tab === "asked" ? askedRows : shown.map((s) => shownRow(s, details.get(s.showing_id), askedById.get(s.showing_id)));

  const total = new Set([...asked.map((a) => a.showing_id), ...shown.map((s) => s.showing_id)]).size;
  const needing = askedRows.filter((r) => !r.ended && r.status.needs).length;

  const showEnded = query.ended === "1";
  const q = (query.q ?? "").trim().toLowerCase();
  const boundaries = [...new Set(rows.map((r) => `${r.from ?? "?"}→${r.to}`))].sort();
  const endedCount = rows.filter((r) => r.ended).length;
  const visible = rows.filter(
    (r) =>
      (showEnded || !r.ended) &&
      (!q || (r.node ?? r.whole ?? "").toLowerCase().includes(q)) &&
      (!query.boundary || `${r.from ?? "?"}→${r.to}` === query.boundary) &&
      (!query.status || (query.status === "needs" ? !!r.status.needs : r.status.key === query.status))
  );
  const filtered = !!(q || query.boundary || query.status);
  const here = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, q: query.q, boundary: query.boundary, status: query.status, ended: query.ended, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return `/releases${s ? `?${s}` : ""}`;
  };

  return (
    <WorkPage>
      <WorkHead
        title="Releases"
        sub={total === 0 ? "None yet" : `${plural(total, "release")}${needing > 0 ? ` · ${needing} ${needing === 1 ? "needs" : "need"} something` : ""}`}
        actions={can(who, "direct") && <ButtonLink href="/releases/new" primary icon="plus">New release</ButtonLink>}
      />

      <div className="w-col">
        <div className="w-row" style={{ flexWrap: "nowrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Tabs
              current={tab}
              tabs={[
                { key: "asked", label: "From your labels", href: "/releases?tab=asked", count: asked.length },
                { key: "shown", label: "Released to you", href: "/releases?tab=shown", count: shown.length },
              ]}
            />
          </div>
          <Tip>From your labels: pages written at a label you read, asked to be released elsewhere. Released to you: pages released to a label you read, or outside.</Tip>
        </div>

        {rows.length > 0 && (
          <div className="w-toolbar">
            <ShowingsFilter
              tab={tab}
              q={query.q ?? ""}
              boundary={query.boundary ?? ""}
              status={query.status ?? ""}
              ended={showEnded}
              boundaries={boundaries}
              statuses={STATUSES.filter((s) => s.key !== "needs" || tab === "asked")}
            />
            {endedCount > 0 && (
              <span className="w-muted w-small w-spacer">
                {showEnded ? (
                  <>
                    Ended releases shown · <Link href={here({ ended: undefined })}>Hide {endedCount}</Link>
                  </>
                ) : (
                  <>
                    Ended releases hidden · <Link href={here({ ended: "1" })}>Show {endedCount}</Link>
                  </>
                )}
              </span>
            )}
          </div>
        )}

        {visible.length === 0 ? (
          <div className="w-tbox">
            <Empty>
              {filtered || (rows.length > 0 && !showEnded) ? (
                <>
                  No release here matches. <Link href={`/releases?tab=${tab}${rows.length > 0 && !filtered ? "&ended=1" : ""}`}>{filtered ? "Clear filters" : "Show ended"}</Link>
                </>
              ) : tab === "asked" ? (
                <>
                  No page at a label you read has been asked to be released.{" "}
                  {can(who, "direct") ? (
                    <>
                      Start with <Link href="/releases/new">New release</Link>, or from a node&rsquo;s page.
                    </>
                  ) : (
                    "A person who holds the permission to direct asks for one."
                  )}
                </>
              ) : (
                "Nothing is released to a label you read, or outside."
              )}
            </Empty>
          </div>
        ) : (
          <Table label={tab === "asked" ? "Releases from your labels" : "Releases to you"}>
            <thead>
              <tr>
                <th>Node</th>
                <th>Boundary</th>
                <th>Kind</th>
                <th>Latest version</th>
                <th>
                  Status <Tip>One status per page version: Redact, then Audit&apos;s check, then Consent at the gate, then Released on the other side.</Tip>
                </th>
                <th className="w-act" aria-label="Acts" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const kind = kindOf(r.form, r.scope);
                const gate = gateFor(gates, r.from, r.to);
                return (
                  <tr key={r.id} className={r.ended ? "w-muted-row" : undefined}>
                    <td style={{ maxWidth: 380 }}>
                      <Link href={`/releases/${r.id}`} className={r.node ? "w-node" : undefined} style={{ color: "var(--w-ink)" }}>
                        {r.node ?? r.whole ?? "A node you do not read"}
                      </Link>
                      {(r.more > 0 || r.ended) && (
                        <div className="w-faint w-small">
                          {r.more > 0 && (r.node ? `+ ${r.more} under it` : plural(r.more, "node"))}
                          {r.more > 0 && r.ended && " · "}
                          {r.ended && `ended ${shortDay(r.ended)}`}
                        </div>
                      )}
                    </td>
                    <td>
                      <Boundary from={r.from} to={r.to} />
                    </td>
                    <td>
                      {kind.form}
                      <div className="w-faint w-small">{kind.covers}</div>
                    </td>
                    <td>{r.latest ? shortDay(r.latest) : <span className="w-faint">—</span>}</td>
                    <td>
                      <Pipeline status={r.status} />
                    </td>
                    <td className="w-act">
                      {!r.ended && r.status.needs === "pay" && can(who, "fund") && (
                        <ButtonLink href={`/releases/${r.id}`} small>
                          Pay
                        </ButtonLink>
                      )}
                      {!r.ended && r.status.needs === "review" && can(who, "release") && (
                        <ButtonLink href="/gate" small primary>
                          Review
                        </ButtonLink>
                      )}
                      {!r.ended && r.status.needs === "policy" && (
                        <ButtonLink href={gate ? `/gates/${gate.gate_id}?tab=policy` : "/gates"} small>
                          Open policy
                        </ButtonLink>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
      {drawer}
    </WorkPage>
  );
}
