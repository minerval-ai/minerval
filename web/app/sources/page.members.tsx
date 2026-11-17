import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import {
  ButtonLink,
  Drawer,
  Empty,
  Lbl,
  Party,
  Pill,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  owls,
  plural,
  shortDay,
} from "@/components/work/ui";
import { fetchAccount } from "@/lib/account-api";
import { fetchMyLabels } from "@/lib/admin-api";
import { SOURCE_STATUS, domainOf, fetchSources } from "@/lib/sources-api";
import { AddSourceForm } from "./new/AddSourceForm";

export const metadata: Metadata = { title: "Sources · Minerval" };
export const dynamic = "force-dynamic";

// The sources the deployment holds at labels the reader reads (GET /sources),
// newest first: where each stands, whose material it is, and who added it.
// A source is added from the drawer (`?drawer=add`, POST /sources); the old
// address /sources/new sends here with it open.

const PAGE = 50;

type Search = { drawer?: string; label?: string; party?: string; page?: string };

export default async function SourcesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct") && !can(who, "administer")) return <NeedsPermission title="Sources" permission="direct" />;
  const q = await searchParams;
  const page = Math.max(0, Math.trunc(Number(q.page ?? 0)) || 0);
  const label = q.label || undefined;
  const party = q.party === "none" ? "none" : undefined;
  const adding = q.drawer === "add" && can(who, "direct");
  const administers = can(who, "administer");

  const [list, labels, account] = await Promise.all([
    fetchSources(who.externalId, { limit: PAGE, offset: page * PAGE, label, party }),
    fetchMyLabels(who.externalId).catch(() => null),
    adding ? fetchAccount(who.externalId).catch(() => null) : null,
  ]);
  const { counts } = list;

  const here = (over: Partial<Search>) => {
    const p = new URLSearchParams();
    const next = { label: q.label, party: q.party, page: q.page, ...over };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/sources?${s}` : "/sources";
  };
  const close = here({ drawer: undefined });

  const sub = [
    plural(counts.sources, "source"),
    counts.pending_review > 0 && `${counts.pending_review} waiting for review`,
    counts.with_no_party > 0 && `${counts.with_no_party} with no party`,
  ]
    .filter(Boolean)
    .join(" · ");

  const cap = account?.entitlement.caps_owls?.source_ingest;
  const balance = account?.entitlement.owl_balance;
  const createdHere = account?.entitlement.owls_created_here === true;

  return (
    <WorkPage>
      <WorkHead
        title="Sources"
        sub={sub}
        actions={
          <>
            {administers && <ButtonLink href="/admin/connections">Connections</ButtonLink>}
            {can(who, "direct") && (
              <ButtonLink href={here({ drawer: "add" })} primary icon="plus">
                Add source
              </ButtonLink>
            )}
          </>
        }
      />

      <form className="w-toolbar" method="get" action="/sources">
        <nav className="w-seg" aria-label="Filter by party">
          <Link href={here({ party: undefined, page: undefined })} aria-current={party ? undefined : "page"}>
            All {counts.sources.toLocaleString("en-GB")}
          </Link>
          <Link href={here({ party: "none", page: undefined })} aria-current={party ? "page" : undefined}>
            No party {counts.with_no_party.toLocaleString("en-GB")}
          </Link>
        </nav>
        {labels?.must_choose && (
          <>
            {party && <input type="hidden" name="party" value={party} />}
            <select className="w-select" name="label" defaultValue={label ?? ""} aria-label="Label" style={{ width: 150, height: 30 }}>
              <option value="">All labels</option>
              {labels.labels.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
            <button className="w-btn w-sm" type="submit">
              Filter
            </button>
          </>
        )}
      </form>

      {list.sources.length === 0 ? (
        <div className="w-card">
          <Empty>
            {label || party
              ? "No source here matches."
              : "No source at a label you read yet. A source at another label is not listed here."}
          </Empty>
        </div>
      ) : (
        <Table label="Sources">
          <thead>
            <tr>
              <th>Source</th>
              <th>Label</th>
              <th>Party</th>
              <th>Status</th>
              <th>Added by</th>
              <th className="w-num">Added</th>
            </tr>
          </thead>
          <tbody>
            {list.sources.map((s) => {
              const status = SOURCE_STATUS[s.status];
              return (
                <tr key={s.id}>
                  <td style={{ maxWidth: 460 }}>
                    <Link href={`/sources/${s.id}`} style={{ color: "var(--w-ink)", fontWeight: 500 }}>
                      {s.title}
                    </Link>
                    {s.url && s.url !== s.title && (
                      <div className="w-faint w-small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.url}>
                        {domainOf(s.url)}
                      </div>
                    )}
                  </td>
                  <td>
                    <Lbl name={s.label} />
                  </td>
                  <td>
                    {s.party ? (
                      <Party name={s.party.name} />
                    ) : (
                      <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                        <span className="w-muted">No party</span>
                        {administers && (
                          <Link className="w-small" href="/admin/parties">
                            Assign
                          </Link>
                        )}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.contribution_id ? (
                      <Link href={`/contributions/${s.contribution_id}`} title="The submission and its review">
                        <Pill tone={status.tone} title={status.title}>
                          {status.text}
                        </Pill>
                      </Link>
                    ) : (
                      <Pill tone={status.tone} title={status.title}>
                        {status.text}
                      </Pill>
                    )}
                  </td>
                  <td>{s.added_by ?? <span className="w-faint">An agent</span>}</td>
                  <td className="w-num" title={s.added_at}>
                    {addedWhen(s.added_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {list.total > 0 && (
        <div className="w-row w-muted w-small">
          <span>
            {list.total > PAGE
              ? `Showing ${(page * PAGE + 1).toLocaleString("en-GB")}–${Math.min(list.total, (page + 1) * PAGE).toLocaleString("en-GB")} of ${list.total.toLocaleString("en-GB")}`
              : `Only sources at labels you read are listed`}
          </span>
          <span className="w-spacer w-row">
            {page > 0 && <Link href={here({ page: page - 1 > 0 ? String(page - 1) : undefined })}>Newer</Link>}
            {(page + 1) * PAGE < list.total && <Link href={here({ page: String(page + 1) })}>Older</Link>}
          </span>
        </div>
      )}

      {adding && (
        <Drawer title="Add source" close={close}>
          <AddSourceForm
            close={close}
            labels={labels}
            cost={
              <span>
                Holds up to <b style={{ fontWeight: 600 }}>{typeof cap === "number" ? `${owls(cap)} ${cap === 1 ? "owl" : "owls"}` : "a ceiling of owls"}</b>
                {typeof balance === "number" && (
                  <>
                    {" "}
                    <span className="w-faint">·</span> you have {owls(balance)}
                  </>
                )}{" "}
                <span className="w-faint">·</span> unused owls return{" "}
                <Tip>
                  {`Reading a source is paid work: the ceiling is held from your balance when you submit, the cost is metered as the work runs and the unused part returns. If the source is not admitted, what was held is returned in full.${createdHere && typeof balance === "number" && typeof cap === "number" && balance < cap ? " Owls here are created by this deployment's administrators: ask one to add to your balance." : ""}`}
                </Tip>
              </span>
            }
            party={
              <>
                <span>Recorded as no party&rsquo;s material until an admin assigns it</span>
                <Tip>
                  A system where the organisation&rsquo;s data lives is not added here: an administrator connects it on Connections, and agents read it where it is.
                </Tip>
                {administers && (
                  <Link className="w-spacer" href="/admin/parties">
                    Parties
                  </Link>
                )}
              </>
            }
          />
        </Drawer>
      )}
    </WorkPage>
  );
}

/** "14:05" today, "16 Nov" before. UTC. */
function addedWhen(iso: string): string {
  const now = new Date();
  return iso.slice(0, 10) === now.toISOString().slice(0, 10) ? iso.slice(11, 16) : shortDay(iso, now);
}
