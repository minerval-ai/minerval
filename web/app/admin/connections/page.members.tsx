import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  ButtonLink,
  Drawer,
  Empty,
  Lbl,
  Party,
  Pill,
  Seg,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  age,
  plural,
} from "@/components/work/ui";
import { fetchConnections, fetchMyLabels, fetchParties, type ConnectionView } from "@/lib/admin-api";
import { addConnectionAction } from "../actions";
import { ConnectionFields } from "./ConnectionFields";
import { ConnectionHealth } from "./health";

export const metadata: Metadata = { title: "Connections · Minerval" };
export const dynamic = "force-dynamic";

// The organisation's own systems the deployment is connected to, so that
// agents read its data where it lives (docs/connections.md). The API's
// notice on what a connection is sits behind the one-line notice's Tip,
// and a connection is added from the drawer (`?drawer=add`).

type Show = "all" | "needs" | "off";

/** A connection needs its administrator: not answering, never asked, or a tool withdrawn. */
const needsYou = (c: ConnectionView) =>
  c.enabled && (c.state.status === "failing" || c.state.status === "never_checked" || c.tools.some((t) => t.withdrawn !== null));

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ drawer?: string; show?: string; q?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Connections" permission="administer" />;
  const sp = await searchParams;

  const [{ notice, connections, not_shown_note: notShown }, labels, parties] = await Promise.all([
    fetchConnections(who.externalId),
    fetchMyLabels(who.externalId),
    fetchParties(who.externalId),
  ]);
  const show: Show = sp.show === "needs" || sp.show === "off" ? sp.show : "all";
  const name = (sp.q ?? "").trim().toLowerCase();
  const shown = connections
    .filter((c) => (show === "needs" ? needsYou(c) : show === "off" ? !c.enabled : true))
    .filter((c) => !name || c.name.toLowerCase().includes(name));
  const failing = connections.filter((c) => c.enabled && c.state.status === "failing").length;
  const withdrawn = connections.reduce((n, c) => n + c.tools.filter((t) => t.withdrawn !== null).length, 0);
  const needing = connections.filter(needsYou).length;
  const off = connections.filter((c) => !c.enabled).length;
  const close = show === "all" ? "/admin/connections" : `/admin/connections?show=${show}`;

  return (
    <WorkPage>
      <WorkHead
        title="Connections"
        sub={[
          plural(connections.length, "connection"),
          failing > 0 && `${failing} not answering`,
          withdrawn > 0 && `${plural(withdrawn, "tool")} withdrawn`,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <ButtonLink href={`${close}${show === "all" ? "?" : "&"}drawer=add`} primary icon="plus">
            Add connection
          </ButtonLink>
        }
      />

      <div className="w-row w-small" style={{ color: "var(--w-soft)", flexWrap: "nowrap" }}>
        <Tip>{notice}</Tip>
        <span>Connections are for reading. Use a read-only credential; agents get only the tools you pick.</span>
      </div>

      {connections.length > 0 && (
        <form className="w-toolbar" method="get" action="/admin/connections">
          <Seg
            current={show}
            options={[
              { key: "all", href: "/admin/connections", label: `All ${connections.length}` },
              ...(needing > 0 ? [{ key: "needs", href: "/admin/connections?show=needs", label: `Needs you ${needing}` }] : []),
              ...(off > 0 ? [{ key: "off", href: "/admin/connections?show=off", label: `Off ${off}` }] : []),
            ]}
          />
          {show !== "all" && <input type="hidden" name="show" value={show} />}
          <label className="w-search w-spacer" style={{ margin: "0 0 0 auto", width: 240 }}>
            <input name="q" defaultValue={sp.q ?? ""} placeholder="Filter by name" aria-label="Filter by name" />
          </label>
        </form>
      )}

      {shown.length === 0 ? (
        <div className="w-card">
          <Empty>
            {connections.length > 0
              ? "No connection here matches."
              : notShown
                ? "No system is connected at a label you read."
                : "No system is connected. Nothing is offered to an agent until its tools have been looked at and picked."}
          </Empty>
        </div>
      ) : (
        <Table label="Connections">
          <thead>
            <tr>
              <th>Connection</th>
              <th>Party</th>
              <th>Label</th>
              <th>Health</th>
              <th>Tools offered</th>
              <th className="w-num">Calls</th>
              <th className="w-num">
                <span className="w-row" style={{ gap: 6, justifyContent: "flex-end" }}>
                  Kept <Tip>Readings agents kept as sources</Tip>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const listed = c.tools.filter((t) => t.listed).length;
              const offered = c.tools.filter((t) => t.offered).length;
              const out = c.tools.filter((t) => t.withdrawn !== null).length;
              return (
                <tr key={c.id}>
                  <td>
                    <Link href={`/admin/connections/${c.id}`} style={{ fontWeight: 500 }}>
                      {c.name}
                    </Link>
                    <div className="w-faint w-mono" style={{ fontSize: 11.5 }}>
                      {hostOf(c.url)}
                    </div>
                  </td>
                  <td>
                    <Party name={c.party.name} own={c.party.is_own_organization} />
                  </td>
                  <td>
                    <Lbl name={c.label} />
                  </td>
                  <td>
                    <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <ConnectionHealth connection={c} />
                      {c.enabled && c.state.status === "failing" && c.state.last_error && (
                        <span className="w-faint w-small">since {age(c.state.last_error.at)}</span>
                      )}
                    </span>
                  </td>
                  <td>
                    <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <span className="w-num">
                        {offered} of {listed}
                      </span>
                      {out > 0 && (
                        <Link href={`/admin/connections/${c.id}`} style={{ textDecoration: "none" }}>
                          <Pill tone="warn">{out} withdrawn</Pill>
                        </Link>
                      )}
                    </span>
                  </td>
                  <td className="w-num">{c.tools.reduce((n, t) => n + t.calls, 0).toLocaleString("en-GB")}</td>
                  <td className="w-num">{c.tools.reduce((n, t) => n + t.readings_kept, 0).toLocaleString("en-GB")}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <div className="w-faint w-small">
        {notShown ? notShown : "Only connections at labels you read are listed"} · only administrators see this page
      </div>

      {sp.drawer === "add" && (
        <Drawer title="Add connection" close={close} wide>
          {parties.length === 0 ? (
            <Empty>
              A connection belongs to a party, and none is recorded yet. <Link href="/admin/parties">Add one on Parties</Link>
            </Empty>
          ) : (
            <WorkForm
              action={addConnectionAction}
              submit="Add and look at its tools"
              primary
              extra={
                <>
                  <Link className="w-btn w-ghost" href={close} scroll={false}>
                    Cancel
                  </Link>
                  <Tip>
                    The connection is saved with no tool offered, and its server is then asked for its tools so that you can pick among them. A server that does not answer yet is still added, and its page says why it did not.
                  </Tip>
                </>
              }
            >
              <ConnectionFields labels={labels} parties={parties} />
            </WorkForm>
          )}
        </Drawer>
      )}
    </WorkPage>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
