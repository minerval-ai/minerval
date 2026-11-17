import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Banner,
  Empty,
  Lbl,
  Party,
  Pill,
  Seg,
  Strip,
  Table,
  Tabs,
  Tip,
  WorkHead,
  WorkPage,
  shortDay,
  shortWhen,
} from "@/components/work/ui";
import { AccountApiError } from "@/lib/account-api";
import {
  fetchConnection,
  fetchConnectionCalls,
  fetchMyLabels,
  fetchParties,
  type ConnectionCall,
  type ConnectionView,
} from "@/lib/admin-api";
import { callOutcome, withdrawnWords } from "@/lib/admin-words";
import { changeConnectionAction, lookAction, offerToolsAction, switchConnectionAction } from "../../actions";
import { ConnectionFields } from "../ConnectionFields";
import { ConnectionHealth } from "../health";
import { ToolPicks } from "./ToolPicks";
import "../connections.css";

export const metadata: Metadata = { title: "Connection · Minerval" };
export const dynamic = "force-dynamic";

// One connection: how it stands, its tools to be picked one by one (Tools),
// the calls agents made through it with which were kept as sources (Calls),
// and its settings. What a system answered is never shown here: a kept
// reading is read as the source it became.

const CALLS_SHOWN = 100;

type Tab = "tools" | "calls" | "settings";

export default async function ConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; calls?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Connection" permission="administer" />;

  let notice: string;
  let connection: ConnectionView;
  try {
    ({ notice, connection } = await fetchConnection(who.externalId, id));
  } catch (err) {
    if (err instanceof AccountApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  const tab: Tab = sp.tab === "calls" || sp.tab === "settings" ? sp.tab : "tools";
  const keptOnly = sp.calls === "kept";
  const [labels, parties, called] = await Promise.all([
    tab === "settings" ? fetchMyLabels(who.externalId) : null,
    tab === "settings" ? fetchParties(who.externalId) : null,
    fetchConnectionCalls(who.externalId, id, { keptOnly: tab === "calls" && keptOnly, limit: CALLS_SHOWN }).catch(() => ({
      calls: [] as ConnectionCall[],
      not_shown: 0,
      not_shown_note: undefined as string | undefined,
    })),
  ]);

  const listed = connection.tools.filter((t) => t.listed);
  const unlisted = connection.tools.filter((t) => !t.listed);
  const withdrawn = connection.tools.filter((t) => t.withdrawn !== null);
  const offered = connection.tools.filter((t) => t.offered);
  const writing = listed.filter((t) => t.marked_as_writing).length;
  const totalCalls = connection.tools.reduce((n, t) => n + t.calls, 0);
  const { state, credential } = connection;
  const base = `/admin/connections/${connection.id}`;

  return (
    <WorkPage>
      <WorkHead
        crumbs={[{ href: "/admin/connections", label: "Connections" }]}
        title={connection.name}
        tags={
          <>
            <ConnectionHealth connection={connection} />
            <Lbl name={connection.label} />
            <Party name={connection.party.name} own={connection.party.is_own_organization} />
            <Tip>{notice}</Tip>
          </>
        }
        sub={[
          state.last_checked_at ? `Last asked ${shortWhen(state.last_checked_at)}` : "Never asked",
          state.last_answered_at && state.last_answered_at !== state.last_checked_at && `last answered ${shortWhen(state.last_answered_at)}`,
          `added ${shortDay(connection.created_at)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <WorkForm action={lookAction} submit="Look at tools now" inline>
              <input type="hidden" name="connection_id" value={connection.id} />
            </WorkForm>
            <WorkForm action={switchConnectionAction} submit={connection.enabled ? "Switch off" : "Switch on"} inline>
              <input type="hidden" name="connection_id" value={connection.id} />
              <input type="hidden" name="enabled" value={connection.enabled ? "false" : "true"} />
            </WorkForm>
          </>
        }
      />

      {connection.enabled && state.status === "failing" && (
        <Banner tone="bad">
          <span>
            Not answering{state.last_error ? ` since ${shortWhen(state.last_error.at)}: ${state.last_error.message}` : "."}
          </span>
        </Banner>
      )}
      {!connection.enabled && (
        <Banner>
          <span>Switched off: no run is offered its tools. A connection is never deleted, since calls and kept readings refer to it; readings already kept stand.</span>
        </Banner>
      )}

      <Strip
        rows={[
          [
            "Server",
            <span key="s" style={{ minWidth: 0 }}>
              <span className="w-mono" title={connection.url} style={{ overflowWrap: "anywhere" }}>
                {connection.url.replace(/^https?:\/\//, "")}
              </span>
              <div className="w-faint w-small">{connection.transport === "sse" ? "SSE" : "Streamable HTTP"}</div>
            </span>,
          ],
          [
            <span key="k" className="w-row" style={{ gap: 6 }}>
              Credential <Tip>Read from this variable at the moment of each call. The credential itself is never stored, shown or logged.</Tip>
            </span>,
            credential.env === null ? (
              <span key="c" className="w-muted">
                None asked for
              </span>
            ) : (
              <span key="c">
                <span className="w-mono">{credential.env}</span>
                <div className="w-faint w-small w-row" style={{ gap: 6 }}>
                  {credential.header === "Authorization" ? "Authorization, as a bearer token" : `${credential.header} header`}
                  {credential.set ? (
                    <Pill tone="ok" title="The variable is set where the deployment runs">
                      Set
                    </Pill>
                  ) : (
                    <Pill tone="bad" title="The variable is not set where the deployment runs">
                      Not set
                    </Pill>
                  )}
                </div>
              </span>
            ),
          ],
          [
            <span key="k" className="w-row" style={{ gap: 6 }}>
              Limits <Tip>Agents are told both, and why. Calls cost the system, not owls.</Tip>
            </span>,
            <span key="l">
              {connection.calls_per_minute === null ? "No rate" : `${connection.calls_per_minute} calls/min`}
              <div className="w-faint w-small">{connection.timeout_seconds} s timeout</div>
            </span>,
          ],
          [
            "Offered as",
            <span key="o">
              <span className="w-mono">{connection.tool_prefix}__*</span>
              <div className="w-faint w-small">
                {offered.length} tool{offered.length === 1 ? "" : "s"}
              </div>
            </span>,
          ],
          [
            "Stake",
            <span key="st" className="w-row" style={{ gap: 6, flexWrap: "nowrap", maxWidth: 280 }}>
              <span className="w-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {connection.stake}
              </span>
              <Tip>{`${connection.stake} Recorded on every reading kept from the connection, as a fact about the source and never a finding against it.`}</Tip>
            </span>,
          ],
        ]}
      />

      <section className="w-sec">
        <Tabs
          current={tab}
          tabs={[
            { key: "tools", label: "Tools", href: base, count: listed.length },
            { key: "calls", label: "Calls", href: `${base}?tab=calls`, count: totalCalls },
            { key: "settings", label: "Settings", href: `${base}?tab=settings` },
          ]}
        />

        {tab === "tools" && (
          <>
            <div className="w-toolbar">
              <span className="w-muted w-small">
                {[
                  `${offered.length} of ${listed.length} offered`,
                  withdrawn.length > 0 && `${withdrawn.length} withdrawn`,
                  writing > 0 && `${writing} can't be offered`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="w-faint w-small w-spacer w-row" style={{ gap: 6 }}>
                Descriptions are the server&rsquo;s own: what agents are shown
                <Tip>
                  Agents are offered only the tools switched on here. Each pick is of the tool exactly as it is shown now; if it later changes at the server it is withdrawn until you look at it again.
                </Tip>
              </span>
            </div>
            {listed.length === 0 ? (
              <div className="w-card">
                <Empty>
                  {state.status === "never_checked" || state.status === "failing"
                    ? "The server has not listed its tools yet. Look at its tools once it answers."
                    : "The server lists no tools."}
                </Empty>
              </div>
            ) : (
              <ToolPicks
                connectionId={connection.id}
                action={offerToolsAction}
                rows={listed.map((tool) => ({
                  tool,
                  seen: shortWhen(tool.seen_at),
                  withdrawnWhen: tool.withdrawn ? shortWhen(tool.withdrawn.at) : null,
                  withdrawnWhy: tool.withdrawn ? withdrawnWords(tool.withdrawn.reason) : null,
                }))}
              />
            )}
            {unlisted.length > 0 && (
              <div className="w-faint w-small">
                No longer listed by the server, and kept because calls or readings refer to them:{" "}
                {unlisted.map((t) => (t.withdrawn ? `${t.name} (withdrawn ${shortDay(t.withdrawn.at)}, ${withdrawnWords(t.withdrawn.reason)})` : t.name)).join(", ")}
              </div>
            )}
          </>
        )}

        {tab === "calls" && (
          <>
            <div className="w-toolbar">
              <Seg
                current={keptOnly ? "kept" : "all"}
                options={[
                  { key: "all", href: `${base}?tab=calls`, label: "All calls" },
                  { key: "kept", href: `${base}?tab=calls&calls=kept`, label: "Kept as sources" },
                ]}
              />
              <Tip>
                Every call is recorded when it is made, with the size and fingerprint of what came back. A call is not yet a source: agents probe, and an agent keeps a reading only when a judgment rests on it. What the system answered is not shown here; a kept reading is read as its source. A call is listed for those who read at the label of the run that made it.
              </Tip>
              {called.not_shown_note && <span className="w-faint w-small w-spacer">{called.not_shown_note}</span>}
            </div>
            {called.calls.length === 0 ? (
              <div className="w-card">
                <Empty>
                  {keptOnly
                    ? called.not_shown > 0
                      ? "No reading from this connection has been kept as a source at a label you read."
                      : "No reading from this connection has been kept as a source yet."
                    : called.not_shown > 0
                      ? "No call through this connection was made at a label you read."
                      : "No agent has called this connection yet. A run is offered it when the label it works at reads this connection's label, and only the tools picked."}
                </Empty>
              </div>
            ) : (
              <Table label="Calls">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Tool</th>
                    <th>Outcome</th>
                    <th className="w-num">Characters</th>
                    <th>Fingerprint</th>
                    <th>Made by</th>
                    <th>Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {called.calls.map((call) => (
                    <Call key={call.id} call={call} />
                  ))}
                </tbody>
              </Table>
            )}
            {called.calls.length === CALLS_SHOWN && (
              <div className="w-faint w-small">The newest {CALLS_SHOWN} are shown. Earlier calls are kept, and the API serves them.</div>
            )}
          </>
        )}

        {tab === "settings" && labels && parties && (
          <div className="w-card">
            <div className="w-card-b" style={{ maxWidth: 720 }}>
              <WorkForm
                action={changeConnectionAction}
                submit="Save changes"
                primary
                extra={
                  <Tip>
                    Only what you change is changed, and the log says which settings. A new address or way of speaking to the server is, as far as anyone can tell, a different server: every tool that was offered is withdrawn until you look at what the new address lists and pick again. A new party applies to readings from now on.
                  </Tip>
                }
              >
                <input type="hidden" name="connection_id" value={connection.id} />
                <ConnectionFields labels={labels} parties={parties} current={connection} />
              </WorkForm>
            </div>
          </div>
        )}
      </section>
    </WorkPage>
  );
}

function Call({ call }: { call: ConnectionCall }) {
  const tone = call.outcome === "answered" ? "ok" : call.outcome === "in_flight" ? "info" : call.outcome === "tool_error" ? "warn" : "bad";
  return (
    <tr>
      <td className="w-top" style={{ whiteSpace: "nowrap" }}>
        {shortWhen(call.called_at)}
      </td>
      <td className="w-top">
        <span className="w-mono">{call.tool}</span>
        <details>
          <summary>What was asked</summary>
          <pre className="w-code" style={{ marginTop: 6 }}>
            {JSON.stringify(call.arguments ?? {}, null, 2)}
          </pre>
        </details>
      </td>
      <td className="w-top">
        <Pill tone={tone}>{callOutcome(call.outcome)}</Pill>
        {call.error && <div className="w-faint w-small">{call.error}</div>}
      </td>
      <td className="w-num w-top">{call.result_chars === null ? "" : call.result_chars.toLocaleString("en-GB")}</td>
      <td className="w-top">
        {call.result_sha256 && (
          <span className="w-mono w-faint" title={call.result_sha256}>
            {call.result_sha256.slice(0, 12)}…
          </span>
        )}
      </td>
      <td className="w-top">
        {call.agent ?? ""}
        {call.run_id && (
          <>
            {" "}
            <Link href={`/runs/${call.run_id}`}>Run</Link>
          </>
        )}
        {call.claim_id && (
          <>
            {" · "}
            <Link href={`/claims/${call.claim_id}`}>Node</Link>
          </>
        )}
      </td>
      <td className="w-top">
        {call.source_id ? (
          <>
            <Link href={`/sources/${call.source_id}`}>The source</Link>
            <div className="w-faint w-small">{shortWhen(call.kept_at)}</div>
          </>
        ) : (
          <span className="w-faint">Not kept</span>
        )}
      </td>
    </tr>
  );
}
