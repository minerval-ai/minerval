import type { Metadata } from "next";
import { actWords, storedList, storedWords } from "@/lib/stored-words";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { can, viewer, when } from "@/components/admin/access";
import { Pipeline } from "@/components/work/Pipeline";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Boundary,
  ButtonLink,
  Card,
  Drawer,
  Empty,
  Kv,
  Lock,
  Pill,
  Strip,
  Table,
  Tabs,
  Tip,
  WorkHead,
  WorkPage,
  plural,
  shortDay,
  shortWhen,
} from "@/components/work/ui";
import { fetchGrants } from "@/lib/admin-api";
import { fetchOutbound, fetchShowing, fetchShowings, type AskedPage, type ShowingAct, type ShownVersion } from "@/lib/inside-api";
import { NOT_YET_ASSESSED, type Pipeline as Status } from "@/lib/pipeline";
import { endShowingAction, holdPageAction, payForWorkAction } from "../actions";
import { destinationOf, gateFor, kindOf, kindTip, loadGates, statusOf, wholeOf } from "../showings";
import "../showings.css";

export const metadata: Metadata = { title: "Release · Minerval" };
export const dynamic = "force-dynamic";

// One release (GET /showings/:id, and its row in GET /showings for a reader
// of the label it was asked at), as one view whichever sides the viewer
// reads: each version of each node's page with one status (lib/pipeline.ts),
// what the other side is told, the nodes it covers, for a release outside
// where its packages stand, and every act with who did it and what they
// held. A reader of the label the page was written at may pay for its
// redaction, hold a page or end the release, each by the permission the API
// asks for.

const WORK_WAITING: Record<string, string> = {
  to_redact: "its redaction",
  to_check: "the check of its redaction",
};

type Tab = "versions" | "nodes" | "leaving" | "history";

interface Version {
  pageId: string;
  versionOf: string;
  page?: AskedPage;
  version?: ShownVersion;
  status: Status;
}

interface Group {
  nodeId: string;
  text: string | null;
  main: boolean;
  since: string | null;
  began?: string;
  left?: { at: string; because?: string };
  versions: Version[];
}

function auditPill(words: string | null | undefined) {
  if (!words) return <span className="w-faint">Not yet</span>;
  const [tone, text] = /supports the verdict in part/i.test(words)
    ? (["warn", "Supports in part"] as const)
    : /does not show why/i.test(words)
      ? (["bad", "Doesn't show why"] as const)
      : /supports the verdict/i.test(words)
        ? (["ok", "Supports"] as const)
        : (["neu", "Recorded"] as const);
  const after = words.includes("The check was made before");
  return (
    <Pill tone={tone} title={words}>
      {text}
      {after ? " *" : ""}
    </Pill>
  );
}

function removedCount(removals: Record<string, number> | undefined): number {
  return Object.values(removals ?? {}).reduce((a, b) => a + b, 0);
}

function actLine(a: ShowingAct): string {
  const words = actWords(a.what);
  const what = words.charAt(0).toUpperCase() + words.slice(1);
  return `${what}${a.on ? ` ${a.on}` : ""}${a.for_party ? ` for ${a.for_party}` : ""}${a.reason ? `: ${storedWords(a.reason)}` : ""}`;
}

export default async function ShowingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; drawer?: string; page?: string }>;
}) {
  const who = await viewer();
  if (!who) return null;
  const { id } = await params;
  const query = await searchParams;
  const [showing, listed, gates] = await Promise.all([
    fetchShowing(who.externalId, id).catch(() => null),
    fetchShowings(who.externalId).catch(() => ({ shown: [], asked: [], hold_reasons: {} as Record<string, string>, end_reasons: {} as Record<string, string> })),
    loadGates(who.externalId),
  ]);
  const asked = listed.asked.find((a) => a.showing_id === id) ?? null;
  const shownRow = listed.shown.find((s) => s.showing_id === id) ?? null;
  if (!showing && !asked) notFound();

  const outside = (showing?.shown_to ?? asked?.shown_to) === "outside this deployment";
  const outbound = outside ? await fetchOutbound(who.externalId, id).catch(() => null) : null;
  const from = asked?.page_label ?? null;
  const to = destinationOf(showing?.shown_to ?? asked!.shown_to);
  const form = showing?.form ?? asked!.form;
  const scope: string = asked?.scope ?? shownRow?.scope ?? "node";
  const ended = showing?.ended_at ?? asked?.ended_at ?? null;
  const mainNodeId = shownRow?.node_id ?? asked?.node_id ?? null;
  const gate = gateFor(gates, from, to);
  const policyHref = gate ? `/gates/${gate.gate_id}?tab=policy` : "/gates";
  const kind = kindOf(form, scope);

  // ---- every version, grouped by node, from whichever sides the viewer reads ----
  const askedPages = new Map((asked?.pages ?? []).map((p) => [p.page_id, p]));
  const groups: Group[] = [];
  if (showing) {
    for (const n of showing.nodes) {
      groups.push({
        nodeId: n.node_id,
        text: n.text,
        main: n.node_id === mainNodeId,
        since: n.covered_from,
        began: n.showing_began,
        left: n.left_at ? { at: n.left_at, because: n.left_because } : undefined,
        versions: n.versions.map((v) => ({ pageId: v.page_id, versionOf: v.version_of, version: v, page: askedPages.get(v.page_id), status: statusOf(askedPages.get(v.page_id), v) })),
      });
    }
  }
  // Pages recorded on the page's side that the other side's rows do not have (or that this viewer cannot read there).
  const placed = new Set(groups.flatMap((g) => g.versions.map((v) => v.pageId)));
  for (const p of asked?.pages ?? []) {
    if (placed.has(p.page_id)) continue;
    let g = groups.find((x) => x.nodeId === p.node_id);
    if (!g) {
      g = { nodeId: p.node_id, text: p.node_id === asked!.node_id ? asked!.node : null, main: p.node_id === mainNodeId, since: null, versions: [] };
      groups.push(g);
    }
    g.versions.push({ pageId: p.page_id, versionOf: p.version_of, page: p, status: statusOf(p, undefined) });
  }
  for (const g of groups) g.versions.sort((a, b) => b.versionOf.localeCompare(a.versionOf));
  groups.sort((a, b) => Number(b.main) - Number(a.main));

  const mainGroup = groups.find((g) => g.main) ?? groups[0];
  const latest = mainGroup?.versions.find((v) => v.status.key !== "overtaken") ?? mainGroup?.versions[0];
  const status = latest?.status ?? NOT_YET_ASSESSED;
  const allVersions = groups.flatMap((g) => g.versions);
  const atGate = allVersions.filter((v) => v.status.key === "gate").length;
  const unpaid = allVersions.filter((v) => v.status.key === "funds").length;
  const notAssessed = groups.filter((g) => g.versions.length === 0).length;
  const title = mainGroup?.text ?? asked?.node ?? wholeOf(scope, from) ?? "A node you do not read";
  const statement = !!(mainGroup?.text ?? asked?.node);

  // ---- what the viewer may do ----
  // Who consents for each party (the permission stored as `release`), where the
  // viewer may see grants (an administrator): a part waiting on a party nobody
  // can consent for says so.
  const releasers = can(who, "administer")
    ? await fetchGrants(who.externalId)
        .then((gs) => new Set(gs.filter((g) => g.permission === "release" && !g.removed_at && g.party).map((g) => g.party!.name)))
        .catch(() => null)
    : null;
  const holdable = (v: Version) => !!v.page && v.version?.state === "held" && can(who, "direct") && !ended && v.page.stage !== "overtaken";
  const heldByDirector = (v: Version) => (v.version?.held_because ?? "").startsWith("held by a person who directs");
  const mayEnd = !!asked && form === "standing" && !ended && can(who, "direct");
  const headHold = latest && holdable(latest) ? latest : undefined;

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: "versions", label: "Versions", count: allVersions.length },
    { key: "nodes", label: "Nodes covered", count: groups.length },
    ...(outside ? [{ key: "leaving" as Tab, label: "Leaving", count: outbound?.nodes.reduce((n, x) => n + x.packages.length, 0) }] : []),
    ...(showing ? [{ key: "history" as Tab, label: "History", count: showing.acts.length }] : []),
  ];
  const tab: Tab = tabs.some((t) => t.key === query.tab) ? (query.tab as Tab) : "versions";
  const base = `/releases/${id}${tab === "versions" ? "" : `?tab=${tab}`}`;
  const withDrawer = (drawer: string, page?: string) => `${base}${base.includes("?") ? "&" : "?"}drawer=${drawer}${page ? `&page=${page}` : ""}`;
  const sees = to === "outside" ? "Outside sees" : `${to} sees`;

  const drawerPage = query.drawer === "hold" ? allVersions.find((v) => v.pageId === query.page) : undefined;

  return (
    <WorkPage>
      <WorkHead
        crumbs={[{ href: "/releases", label: "Releases" }]}
        title={title}
        statement={statement}
        tags={
          <>
            <span className="w-chip">
              <Boundary from={from} to={to} />
            </span>
            <span className="w-chip">
              {kind.form} · {kind.covers.toLowerCase()} <Tip>{kindTip(form, scope)}</Tip>
            </span>
            {ended ? <Pill tone="neu">Ended {shortDay(ended)}</Pill> : <Pipeline status={status} />}
          </>
        }
        actions={
          <>
            {headHold &&
              (heldByDirector(headHold) ? (
                <WorkForm action={holdPageAction} submit="Lift hold" inline>
                  <input type="hidden" name="showing_id" value={id} />
                  <input type="hidden" name="page_id" value={headHold.pageId} />
                  <input type="hidden" name="lift" value="true" />
                </WorkForm>
              ) : (
                <ButtonLink href={withDrawer("hold", headHold.pageId)}>Hold latest page</ButtonLink>
              ))}
            {mayEnd && (
              <ButtonLink href={withDrawer("end")} danger>
                End release
              </ButtonLink>
            )}
          </>
        }
      />

      <Strip
        rows={[
          [
            "Asked",
            <span key="a">
              {showing?.asked_by ? `${showing.asked_by} · ` : ""}
              {shortDay(showing?.asked_at ?? asked!.asked_at)}
              {showing && showing.asked_holding.length > 0 && (
                <div className="w-faint w-small" title={`Holding ${showing.asked_holding.join(", ")}`}>
                  holding {showing.asked_holding.slice(0, 2).join(", ")}
                  {showing.asked_holding.length > 2 && ` +${showing.asked_holding.length - 2}`}
                </div>
              )}
            </span>,
          ],
          showing?.policy
            ? [
                <span key="pk">
                  Policy <Tip>Everyone the page is released to can read this policy in full.</Tip>
                </span>,
                <Link key="p" href={policyHref}>
                  Version {showing.policy.version}
                </Link>,
              ]
            : gate
              ? ["Policy", <Link key="p" href={policyHref}>The boundary&rsquo;s policy</Link>]
              : null,
          [
            "Covers",
            <span key="c">
              {plural(groups.length, "node")}
              {notAssessed > 0 && <span className="w-faint"> · {notAssessed} not yet assessed</span>}
            </span>,
          ],
          [
            "Versions",
            <span key="v">
              {allVersions.length}
              {(atGate > 0 || unpaid > 0) && (
                <span className="w-faint">
                  {atGate > 0 && ` · ${atGate} at the gate`}
                  {unpaid > 0 && ` · ${unpaid} unpaid`}
                </span>
              )}
            </span>,
          ],
          !!ended && ["Ended", `${shortDay(ended)}${showing?.ended_because ? `: ${storedWords(showing.ended_because)}` : ""}`],
        ]}
      />

      <Tabs current={tab} tabs={tabs.map((t) => ({ ...t, href: t.key === "versions" ? `/releases/${id}` : `/releases/${id}?tab=${t.key}` }))} />

      {tab === "versions" && (
        <div className="w-showings-grid">
          {groups.length === 0 ? (
            <div className="w-tbox">
              <Empty>
                No page yet. One is recorded from a finished assessment at the label the page is written at.
              </Empty>
            </div>
          ) : (
            <Table label="Versions">
              <thead>
                <tr>
                  <th>Assessment</th>
                  <th>Status</th>
                  <th>
                    {sees.charAt(0).toUpperCase() + sees.slice(1)}{" "}
                    {!showing && <Tip>That is on their side, which you do not read.</Tip>}
                  </th>
                  <th>
                    Audit <Tip>Audit&apos;s check: whether what remains after redaction still supports the verdict. Recorded in fixed words only.</Tip>
                  </th>
                  <th className="w-act" aria-label="Acts" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows
                    key={g.nodeId}
                    g={g}
                    id={id}
                    showingVisible={!!showing}
                    mayFund={can(who, "fund")}
                    mayRelease={can(who, "release")}
                    holdable={holdable}
                    heldByDirector={heldByDirector}
                    holdHref={(pageId) => withDrawer("hold", pageId)}
                    releasers={releasers}
                  />
                ))}
              </tbody>
            </Table>
          )}
          <aside className="w-col">
            {showing && showing.acts.length > 0 && (
              <Card title="Recent" link={{ href: `/releases/${id}?tab=history`, label: "History" }}>
                <div>
                  {showing.acts
                    .slice(-4)
                    .reverse()
                    .map((a, i) => (
                      <div className="w-line" key={i}>
                        <time dateTime={a.at}>{shortDay(a.at)}</time>
                        <span>
                          {actLine(a)}
                          <div className="w-faint">{a.by}</div>
                        </span>
                      </div>
                    ))}
                </div>
              </Card>
            )}
            <Card
              title={
                <>
                  Always shown <Tip>Shown with every page, nothing removed. Holding any of it holds the whole page.</Tip>
                </>
              }
            >
              <dl className="w-kv" style={{ gridTemplateColumns: "76px minmax(0, 1fr)", fontSize: 12.5 }}>
                {[
                  ["Verdict", "with any credence"],
                  ["Evidence", "the kinds it rests on"],
                  ["Sources", "that each exists, and whose"],
                  ["Method", "how the page was made"],
                  ["Removals", "how many, per category"],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </aside>
        </div>
      )}

      {tab === "nodes" &&
        (groups.length === 0 ? (
          <div className="w-tbox">
            <Empty>No node is covered yet.</Empty>
          </div>
        ) : (
          <Table label="Nodes covered">
            <thead>
              <tr>
                <th>Node</th>
                <th>Place</th>
                <th>Covered since</th>
                <th>Status</th>
                <th>Left</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const v = g.versions.find((x) => x.status.key !== "overtaken") ?? g.versions[0];
                return (
                  <tr key={g.nodeId}>
                    <td style={{ maxWidth: 420 }}>
                      {g.text ? (
                        <Link className="w-node w-sm" href={`/claims/${g.nodeId}`} style={{ color: "var(--w-ink)" }}>
                          {g.text}
                        </Link>
                      ) : (
                        <span className="w-faint">A node you do not read</span>
                      )}
                    </td>
                    <td>{g.main ? "Released node" : "Under it"}</td>
                    <td>
                      {g.since ? shortDay(g.since) : <span className="w-faint">—</span>}
                      {g.began && <div className="w-faint w-small">{g.began}</div>}
                    </td>
                    <td>
                      <Pipeline status={v?.status ?? NOT_YET_ASSESSED} />
                    </td>
                    <td>{g.left ? `${shortDay(g.left.at)}${g.left.because ? `: ${storedWords(g.left.because)}` : ""}` : <span className="w-faint">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ))}

      {tab === "leaving" &&
        (!outbound || outbound.nodes.length === 0 ? (
          <div className="w-tbox">
            <Empty>Nothing under this release has a package yet. One is built when what the outside would read changes.</Empty>
          </div>
        ) : (
          <div className="w-col">
            <div className="w-row w-muted w-small">
              <span>
                {outbound.nodes[0]!.sent === "as_released" ? "Each package is sent as soon as it is built." : "A person who directs the graph sends each package."}{" "}
                <Tip>What is released is carried out in signed packages, one each time what the outside would read has changed.</Tip>
              </span>
              <Link className="w-spacer" href={`/outbound#showing-${id}`}>
                Open in Outbox
              </Link>
            </div>
            <Table label="Leaving the deployment">
              <thead>
                <tr>
                  <th>Node</th>
                  <th className="w-num">Packages</th>
                  <th className="w-num">Sent and taken</th>
                  <th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {outbound.nodes.map((n) => {
                  const sent = n.packages.filter((p) => p.sends.some((s) => s.result === "admitted")).length;
                  return (
                    <tr key={n.node_id}>
                      <td style={{ maxWidth: 420 }}>{n.node ? <span className="w-node w-sm">{n.node}</span> : <span className="w-faint">A node you do not read</span>}</td>
                      <td className="w-num">{n.packages.length}</td>
                      <td className="w-num">{sent}</td>
                      <td className="w-small">{n.waiting ?? <span className="w-faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        ))}

      {tab === "history" && showing && (
        <Table label="What was done, and by whom">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>
                Holding <Tip>The permissions the person held when they acted. Where one person both directs and consents, the people the page is released to can see that here.</Tip>
              </th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {showing.acts.map((a, i) => (
              <tr key={i}>
                <td title={when(a.at)} style={{ whiteSpace: "nowrap" }}>
                  {shortWhen(a.at)}
                </td>
                <td>{a.by}</td>
                <td className="w-small">{a.holding.join(", ") || <span className="w-faint">nothing recorded</span>}</td>
                <td>{actLine(a)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {drawerPage && holdable(drawerPage) && !heldByDirector(drawerPage) && (
        <Drawer title="Hold this page" close={base}>
          <Kv rows={[["Assessment of", shortDay(drawerPage.versionOf)], ["Status", <Pipeline key="s" status={drawerPage.status} />]]} />
          <WorkForm action={holdPageAction} submit="Hold page" primary>
            <input type="hidden" name="showing_id" value={id} />
            <input type="hidden" name="page_id" value={drawerPage.pageId} />
            <div className="w-field">
              <label htmlFor="hold-reason">
                Reason <Tip>All the other side is told, with the date. Nobody checks it. A hold can be lifted and is never deleted; a page already released cannot be held.</Tip>
              </label>
              <select id="hold-reason" className="w-select" name="reason" required defaultValue="">
                <option value="" disabled>
                  Choose a reason
                </option>
                {Object.entries(storedList(listed.hold_reasons)).map(([key, words]) => (
                  <option key={key} value={key}>
                    {words}
                  </option>
                ))}
              </select>
            </div>
          </WorkForm>
        </Drawer>
      )}

      {query.drawer === "end" && mayEnd && (
        <Drawer title="End this release" close={base}>
          <p className="w-muted" style={{ margin: 0 }}>
            Later assessments stop following. What was released stays released.
          </p>
          <WorkForm action={endShowingAction} submit="End release" danger lock="Can't be undone">
            <input type="hidden" name="showing_id" value={id} />
            <div className="w-field">
              <label htmlFor="end-reason">
                Reason <Tip>Recorded with the date, where the people the page is released to can read it.</Tip>
              </label>
              <select id="end-reason" className="w-select" name="reason" required defaultValue="">
                <option value="" disabled>
                  Choose a reason
                </option>
                {Object.entries(storedList(listed.end_reasons)).map(([key, words]) => (
                  <option key={key} value={key}>
                    {words}
                  </option>
                ))}
              </select>
            </div>
          </WorkForm>
          <Lock>Ending takes nothing back, and nothing more is released from it.</Lock>
        </Drawer>
      )}
    </WorkPage>
  );
}

function GroupRows({
  g,
  id,
  showingVisible,
  mayFund,
  mayRelease,
  holdable,
  heldByDirector,
  holdHref,
  releasers,
}: {
  g: Group;
  id: string;
  showingVisible: boolean;
  mayFund: boolean;
  mayRelease: boolean;
  holdable: (v: Version) => boolean;
  heldByDirector: (v: Version) => boolean;
  holdHref: (pageId: string) => string;
  /** The parties somebody consents for, by name; null where the viewer cannot see grants. */
  releasers: Set<string> | null;
}) {
  return (
    <>
      <tr className="w-group">
        <td colSpan={5}>
          {g.text ? (
            <Link className="w-node w-sm" href={`/claims/${g.nodeId}`} style={{ color: "var(--w-ink)" }}>
              {g.text}
            </Link>
          ) : (
            <span className="w-faint">A node you do not read</span>
          )}{" "}
          <span className="w-faint w-small" style={{ fontWeight: 400 }}>
            · {g.main ? "released node" : "under it"}
            {g.since && ` · since ${shortDay(g.since)}`}
            {g.left && ` · left ${shortDay(g.left.at)}${g.left.because ? `: ${storedWords(g.left.because)}` : ""}`}
          </span>
        </td>
      </tr>
      {g.versions.length === 0 && (
        <tr>
          <td className="w-faint">—</td>
          <td>
            <Pipeline status={NOT_YET_ASSESSED} />
          </td>
          <td className="w-muted">Not yet assessed</td>
          <td>
            <span className="w-faint">—</span>
          </td>
          <td className="w-act" />
        </tr>
      )}
      {g.versions.map((v) => {
        const work = v.page ? WORK_WAITING[v.page.stage] : undefined;
        const detail = detailOf(v, releasers);
        return (
          <VersionRows key={v.pageId} v={v} detail={detail}>
            <td>
              {shortDay(v.versionOf)}
              <div className="w-faint w-mono" title={v.version?.fingerprint ?? undefined}>
                {v.version?.fingerprint ? `${v.version.fingerprint.slice(0, 4)}…${v.version.fingerprint.slice(-4)}` : "—"}
              </div>
            </td>
            <td>
              <Pipeline status={v.status} />
            </td>
            <td className="w-small" style={{ minWidth: 120 }}>
              <Sees v={v} showingVisible={showingVisible} />
            </td>
            <td>{auditPill(v.version?.audit)}</td>
            <td className="w-act">
              <div className="w-row" style={{ justifyContent: "flex-end", flexWrap: "nowrap", gap: 6 }}>
                {work && mayFund && (
                  <WorkForm action={payForWorkAction} submit="Pay" inline primary={v.status.key === "funds"}>
                    <input type="hidden" name="showing_id" value={id} />
                    <input type="hidden" name="page_id" value={v.pageId} />
                    <input
                      className="w-input w-narrow"
                      style={{ width: 64, height: 26, padding: "0 6px" }}
                      name="owls"
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      placeholder="owls"
                      aria-label={`Budget for ${work}, in owls`}
                      title={`A budget for ${work}, paid whole; what the run does not spend comes back.`}
                    />
                  </WorkForm>
                )}
                {v.status.needs === "review" && mayRelease && (
                  <ButtonLink href="/gate" small primary>
                    Review
                  </ButtonLink>
                )}
                {v.version && v.version.state !== "held" && (
                  <ButtonLink href={`/releases/${id}/pages/${v.pageId}`} small title="View as released: the page as the other side reads it, part by part">
                    View
                  </ButtonLink>
                )}
                {holdable(v) &&
                  (heldByDirector(v) ? (
                    <WorkForm action={holdPageAction} submit="Lift hold" inline>
                      <input type="hidden" name="showing_id" value={id} />
                      <input type="hidden" name="page_id" value={v.pageId} />
                      <input type="hidden" name="lift" value="true" />
                    </WorkForm>
                  ) : (
                    <Link className="w-btn w-ghost w-sm" href={holdHref(v.pageId)} scroll={false} title="Hold this version: the other side sees it as held, with the reason">
                      Hold
                    </Link>
                  ))}
              </div>
            </td>
          </VersionRows>
        );
      })}
    </>
  );
}

/** What the people it is released to see of one version, compactly. */
function Sees({ v, showingVisible }: { v: Version; showingVisible: boolean }) {
  const ver = v.version;
  if (!ver) return <span className="w-faint">{showingVisible ? "Never sent" : "—"}</span>;
  if (v.status.key === "overtaken") return <span className="w-faint">Never sent</span>;
  if (ver.state === "held")
    return (
      <span className="w-muted" title={storedWords(ver.held_because) ?? undefined}>
        Nothing yet{ver.held_for ? <div className="w-faint">held {ver.held_for === "0 hours" ? "under an hour" : ver.held_for}</div> : null}
      </span>
    );
  const removed = removedCount(ver.removals_under_the_policy);
  const bits = [
    removed === 0 ? "Nothing removed" : `${removed} removed`,
    ver.state === "released_in_part" ? `${ver.parts_held} ${ver.parts_held === 1 ? "part" : "parts"} held` : null,
  ].filter(Boolean);
  const title = Object.entries(ver.removals_under_the_policy ?? {})
    .map(([c, n]) => `${c}: ${n}`)
    .join(", ");
  return (
    <span title={[title, ver.held_kinds].filter(Boolean).join(" · ") || undefined}>
      {bits.join(" · ")}
      {ver.shown_at && <div className="w-faint">released {shortDay(ver.shown_at)}</div>}
    </span>
  );
}

/** The lines under a version that say why it waits, where there is something to say. */
function detailOf(v: Version, releasers: Set<string> | null): ReactNode {
  const p = v.page;
  const lines: ReactNode[] = [];
  if (p?.waiting_on && p.waiting_on.length > 0) {
    lines.push(
      <div key="w" className="w-row w-small" style={{ gap: 8 }}>
        <span className="w-muted">Waiting on</span>
        {p.waiting_on.map((w, i) => (
          <span key={i} className="w-row" style={{ gap: 6 }}>
            {i > 0 && <span className="w-faint">·</span>}
            <span>{w.part === null ? "The page itself" : `Part ${w.part} · ${w.kind}`}</span>
            <span>{w.party}</span>
            {releasers && !releasers.has(w.party) ? (
              <>
                <Pill tone="bad" title={`Nobody can consent for ${w.party}, so this waits until someone is granted consent for it.`}>
                  nobody can consent for it
                </Pill>
                <Link href="/admin/people?drawer=grant">Grant</Link>
              </>
            ) : (
              <Pill tone={w.standing === "held" ? "warn" : "neu"}>{w.standing === "held" ? "holding" : "waiting"}</Pill>
            )}
          </span>
        ))}
      </div>
    );
  }
  if (p?.cannot_cross) {
    lines.push(
      <div key="c" className="w-small">
        <span className="w-muted">Can&apos;t cross under &ldquo;{p.cannot_cross.category}&rdquo;</span>{" "}
        <Tip>Something always shown with a page could not be released here without giving away what this category protects. The note stays at the label the page was written at.</Tip>
        {p.cannot_cross.note && <div>{p.cannot_cross.note}</div>}
      </div>
    );
  }
  if (p?.audit_reasons && p.stage === "to_redact") {
    lines.push(
      <div key="a" className="w-small">
        <span className="w-muted">Returned by Audit:</span> {p.audit_reasons}
      </div>
    );
  }
  if (v.version && v.version.redaction_round > 1) {
    lines.push(
      <div key="r" className="w-small w-faint">
        Redacted {v.version.redaction_round} times; the check returned an earlier round.
      </div>
    );
  }
  return lines.length > 0 ? <div className="w-col" style={{ gap: 6 }}>{lines}</div> : null;
}

function VersionRows({ v, detail, children }: { v: Version; detail: ReactNode; children: ReactNode }) {
  return (
    <>
      <tr className={v.status.dashed ? "w-muted-row" : undefined} style={detail ? { borderBottom: 0 } : undefined}>
        {children}
      </tr>
      {detail && (
        <tr className="w-detail">
          <td colSpan={5} style={{ paddingTop: 6 }}>
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}
