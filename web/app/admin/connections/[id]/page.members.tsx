import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, NeedsPermission, Notice, can, viewer, when } from "@/components/admin/access";
import { AccountApiError } from "@/lib/account-api";
import {
  fetchConnection,
  fetchConnectionCalls,
  fetchLabels,
  fetchParties,
  type ConnectionCall,
  type ConnectionTool,
  type ConnectionView,
} from "@/lib/admin-api";
import {
  CONNECTION_STATE_WORDS,
  callOutcome,
  capitalised,
  count,
  toolMarking,
  withdrawnWords,
} from "@/lib/admin-words";
import { changeConnectionAction, lookAction, offerToolsAction, switchConnectionAction } from "../../actions";
import { ConnectionFields } from "../ConnectionFields";

export const metadata: Metadata = { title: "Connection · Minerval" };
export const dynamic = "force-dynamic";

// One connection: how it stands, its tools to be picked one by one, the
// tools that were withdrawn, and the calls agents made through it with which
// were kept as sources. What a system answered is never shown here: a kept
// reading is read as the source it became.

const CALLS_SHOWN = 100;

export default async function ConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ calls?: string }>;
}) {
  const { id } = await params;
  const { calls: callsView } = await searchParams;
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
  const keptOnly = callsView === "kept";
  const [labels, parties, calls] = await Promise.all([
    fetchLabels(who.externalId),
    fetchParties(who.externalId),
    fetchConnectionCalls(who.externalId, id, { keptOnly, limit: CALLS_SHOWN }).catch(() => [] as ConnectionCall[]),
  ]);

  const listed = connection.tools.filter((t) => t.listed);
  const unlisted = connection.tools.filter((t) => !t.listed);
  const withdrawn = connection.tools.filter((t) => t.withdrawn !== null);
  const offered = connection.tools.filter((t) => t.offered);
  const state = connection.state;
  const base = `/admin/connections/${connection.id}`;

  return (
    <div className="admin-page">
      <PageHead
        back={{ href: "/admin/connections", label: "Connections" }}
        kicker="Connection"
        title={connection.name}
        meta={
          <>
            a system of {connection.party.name} · label <code>{connection.label}</code> ·{" "}
            {CONNECTION_STATE_WORDS[state.status] ?? state.status}
            {state.last_answered_at && <> · last answered {when(state.last_answered_at)}</>}
          </>
        }
      />
      <AdminNav current="/admin/connections" />
      <Notice>{notice}</Notice>

      {/* ------------------------------------------------ how it stands */}
      <section className="acct-section admin-first" id="state">
        <div className="acct-head">
          <h2>How it stands</h2>
        </div>
        <div className="acct-cols">
          <div className="acct-main">
            <StateLines connection={connection} offered={offered.length} withdrawn={withdrawn.length} />
            <p className="acct-prose acct-measure">
              Looking asks the server for its tools as they are now. It is how to see what a server
              offers, how to test that it answers and takes the credential, and what brings a
              withdrawn tool back for picking. Looking never offers anything to an agent.
            </p>
            <ActionForm action={lookAction} submit="Look at the server's tools now">
              <input type="hidden" name="connection_id" value={connection.id} />
            </ActionForm>
          </div>
          <aside className="acct-side acct-side-wide">
            <h3>{connection.enabled ? "Switch it off" : "Switch it on"}</h3>
            <p className="acct-prose">
              {connection.enabled
                ? "Switched off, no run is offered its tools. A connection is never deleted, since calls and kept readings refer to it, and readings already kept stand."
                : "It is switched off: no run is offered its tools. Readings already kept stand."}
            </p>
            <ActionForm action={switchConnectionAction} submit={connection.enabled ? "Switch off" : "Switch on"}>
              <input type="hidden" name="connection_id" value={connection.id} />
              <input type="hidden" name="enabled" value={connection.enabled ? "false" : "true"} />
            </ActionForm>
          </aside>
        </div>
      </section>

      {/* ------------------------------------------------ tools */}
      <section className="acct-section" id="tools">
        <div className="acct-head">
          <h2>Its tools</h2>
          <span className="acct-note">
            {offered.length} of {listed.length} offered to agents
          </span>
        </div>
        {listed.length === 0 ? (
          <p className="account-empty">
            {state.status === "never_checked" || state.status === "failing"
              ? "The server has not listed its tools yet. Look at it above once it answers."
              : "The server lists no tools."}
          </p>
        ) : (
          <>
            <p className="acct-prose acct-measure">
              Agents are offered only the tools ticked here. Read each tool&rsquo;s description and
              what it takes before you tick it: the description is the system&rsquo;s own, and it is
              what an agent will be shown. Each pick is of the tool exactly as it is shown now. If
              the tool later changes at the server it is withdrawn until you look at it again.
            </p>
            <ActionForm action={offerToolsAction} submit="Offer the ticked tools to agents, and no others">
              <input type="hidden" name="connection_id" value={connection.id} />
              {listed.map((tool) => (
                <Tool key={tool.name} tool={tool} />
              ))}
            </ActionForm>
          </>
        )}

        {withdrawn.length > 0 && (
          <>
            <div className="acct-sub admin-gap" id="withdrawn">
              <h3>Withdrawn</h3>
            </div>
            <p className="acct-prose acct-measure">
              These were offered and stopped being offered without anyone deciding so, because
              what an administrator picked is no longer what the server has. Look at the server
              above, read the tool as it now is, and pick it again if it should be offered.
            </p>
            <div className="acct-scroll">
              <table className="account-table acct-table">
                <thead>
                  <tr>
                    <th>tool</th>
                    <th>withdrawn</th>
                    <th>because</th>
                  </tr>
                </thead>
                <tbody>
                  {withdrawn.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <code>{t.name}</code>
                      </td>
                      <td className="acct-num-left">{when(t.withdrawn!.at)}</td>
                      <td>{capitalised(withdrawnWords(t.withdrawn!.reason))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {unlisted.length > 0 && (
          <p className="acct-note">
            No longer listed by the server, and kept here because calls or readings refer to them:{" "}
            {unlisted.map((t) => t.name).join(", ")}.
          </p>
        )}
      </section>

      {/* ------------------------------------------------ calls */}
      <section className="acct-section" id="calls">
        <div className="acct-head">
          <h2>Calls agents made</h2>
          <div className="acct-switch">
            <Link href={`${base}#calls`} aria-current={keptOnly ? undefined : "true"}>
              All calls
            </Link>
            <Link href={`${base}?calls=kept#calls`} aria-current={keptOnly ? "true" : undefined}>
              Kept as sources
            </Link>
          </div>
        </div>
        <p className="acct-prose acct-measure">
          Every call is recorded when it is made, with the size and fingerprint of what came back.
          A call is not yet a source: agents probe, and an agent keeps a reading only when a
          judgment rests on it. What the system answered is not shown here; a kept reading is read
          as its source.
        </p>
        {calls.length === 0 ? (
          <p className="account-empty">
            {keptOnly
              ? "No reading from this connection has been kept as a source yet."
              : "No agent has called this connection yet. A run is offered it when the label it works at reads this connection's label, and only the tools picked above."}
          </p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>when</th>
                  <th>tool</th>
                  <th>how it ended</th>
                  <th className="admin-num">characters</th>
                  <th>fingerprint</th>
                  <th>made by</th>
                  <th>kept</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <Call key={call.id} call={call} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {calls.length === CALLS_SHOWN && (
          <p className="acct-note">
            The newest {CALLS_SHOWN} are shown. Earlier calls are kept, and the API serves them.
          </p>
        )}
      </section>

      {/* ------------------------------------------------ settings */}
      <section className="acct-section" id="settings">
        <div className="acct-head">
          <h2>Settings</h2>
        </div>
        <p className="acct-prose acct-measure">
          Only what you change is changed, and the log says which settings. A new address or way
          of speaking to the server is, as far as anyone can tell, a different server: every tool
          that was offered is withdrawn until you look at what the new address lists and pick
          again. A new label or party applies to readings from now on; those already kept carry
          what the connection had when they were read.
        </p>
        <details className="acct-asTable">
          <summary>Change this connection&rsquo;s settings</summary>
          <ActionForm action={changeConnectionAction} submit="Save the changes">
            <input type="hidden" name="connection_id" value={connection.id} />
            <ConnectionFields labels={labels} parties={parties} current={connection} />
          </ActionForm>
        </details>
      </section>
    </div>
  );
}

function StateLines({
  connection,
  offered,
  withdrawn,
}: {
  connection: ConnectionView;
  offered: number;
  withdrawn: number;
}) {
  const { state, credential } = connection;
  return (
    <div className="acct-scroll">
      <table className="account-table acct-table admin-facts">
        <tbody>
          <tr>
            <td>Server</td>
            <td>
              <code>{connection.url}</code>
              <span className="acct-detail">
                {connection.transport === "sse" ? "SSE" : "streamable HTTP"}
              </span>
            </td>
          </tr>
          <tr>
            <td>State</td>
            <td>
              {state.status === "answering" && <>Answering. Last asked {when(state.last_checked_at)}.</>}
              {state.status === "never_checked" && <>The server has never been asked for its tools.</>}
              {state.status === "off" && <>Switched off.</>}
              {state.status === "failing" && (
                <>
                  Not answering. {state.last_error?.message}
                  <span className="acct-detail">{when(state.last_error?.at)}</span>
                </>
              )}
            </td>
          </tr>
          <tr>
            <td>Credential</td>
            <td>
              {credential.env === null ? (
                "The server is asked for none."
              ) : (
                <>
                  Read from <code>{credential.env}</code> at the moment of each call, and sent in the{" "}
                  <code>{credential.header}</code> header.{" "}
                  {credential.set
                    ? "That variable is set where the deployment runs."
                    : "That variable is not set where the deployment runs."}{" "}
                  The credential itself is never stored, shown or logged.
                </>
              )}
            </td>
          </tr>
          <tr>
            <td>The party&rsquo;s stake</td>
            <td>{connection.stake}</td>
          </tr>
          <tr>
            <td>Limits agents are told</td>
            <td>
              {connection.calls_per_minute === null
                ? "No rate: nothing bounds calls but each run's own budget and judgment."
                : `${count(connection.calls_per_minute, "call")} a minute across all runs.`}{" "}
              A call unanswered after {connection.timeout_seconds} seconds is given up.
            </td>
          </tr>
          <tr>
            <td>Offered to agents</td>
            <td>
              {offered === 0 ? "No tool yet." : `${count(offered, "tool")}, under names starting ${connection.tool_prefix}__.`}
              {withdrawn > 0 && <> {count(withdrawn, "tool")} withdrawn and waiting for you to look again.</>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Tool({ tool }: { tool: ConnectionTool }) {
  const pick = JSON.stringify({ name: tool.name, definition_hash: tool.definition_hash });
  return (
    <div className="admin-tool">
      <label>
        <input type="checkbox" name="offer" value={pick} defaultChecked={tool.offered} disabled={tool.marked_as_writing} />
        <code>{tool.name}</code>
        <span className="acct-detail">
          {tool.offered ? `offered to agents as ${tool.offered_as}` : "not offered"}
          {tool.calls > 0 && ` · ${count(tool.calls, "call")}, ${tool.readings_kept} kept`}
        </span>
      </label>
      <p>{tool.description || "The server gives this tool no description."}</p>
      <p className="admin-tool-hint">{toolMarking(tool)}</p>
      {tool.withdrawn && (
        <p className="admin-tool-hint">
          Withdrawn {when(tool.withdrawn.at)} because {withdrawnWords(tool.withdrawn.reason)}. What is
          shown here is the tool as the server had it when it was last looked at.
        </p>
      )}
      <details>
        <summary>What it takes, and the definition a pick is made on</summary>
        <pre className="admin-pre">{JSON.stringify(tool.input_schema, null, 2)}</pre>
        {tool.annotations && (
          <>
            The server&rsquo;s markings, as given:
            <pre className="admin-pre">{JSON.stringify(tool.annotations, null, 2)}</pre>
          </>
        )}
        <span className="admin-hash">
          definition {tool.definition_hash.slice(0, 16)}… · seen {when(tool.seen_at)}
        </span>
      </details>
    </div>
  );
}

function Call({ call }: { call: ConnectionCall }) {
  return (
    <tr>
      <td className="acct-num-left">{when(call.called_at)}</td>
      <td>
        <code>{call.tool}</code>
        <details className="admin-args">
          <summary>what was asked</summary>
          {call.arguments_withheld ? (
            <span className="admin-withheld">
              Withheld: the arguments are an agent&rsquo;s words at a label you are not cleared to
              read.
            </span>
          ) : (
            <pre className="admin-pre">{JSON.stringify(call.arguments ?? {}, null, 2)}</pre>
          )}
        </details>
      </td>
      <td>
        {callOutcome(call.outcome)}
        {call.error && <span className="acct-detail">{call.error}</span>}
      </td>
      <td className="admin-num">{call.result_chars === null ? "" : call.result_chars.toLocaleString("en-GB")}</td>
      <td>
        {call.result_sha256 && (
          <span className="admin-hash" title={call.result_sha256}>
            {call.result_sha256.slice(0, 12)}…
          </span>
        )}
      </td>
      <td>
        {call.agent ?? ""}
        {call.run_id && (
          <>
            {" "}
            <Link href={`/runs/${call.run_id}`}>the run</Link>
          </>
        )}
        {call.claim_id && (
          <>
            {" · "}
            <Link href={`/claims/${call.claim_id}`}>the node</Link>
          </>
        )}
      </td>
      <td>
        {call.source_id ? (
          <>
            <Link href={`/sources/${call.source_id}`}>the source</Link>
            <span className="acct-detail">{when(call.kept_at)}</span>
          </>
        ) : (
          <span className="acct-quiet">Not kept</span>
        )}
      </td>
    </tr>
  );
}
