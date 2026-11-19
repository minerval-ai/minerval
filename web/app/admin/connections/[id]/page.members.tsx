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
  type ConnectionRoleView,
  type ConnectionView,
} from "@/lib/admin-api";
import { callOutcome, withdrawnWords } from "@/lib/admin-words";
import {
  changeConnectionAction,
  lookAction,
  offerToolsAction,
  removeConnectionCredentialAction,
  setConnectionCredentialAction,
  switchConnectionAction,
} from "../../actions";
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
  let canKeepCredentials: boolean;
  let roles: ConnectionRoleView[];
  try {
    ({ notice, connection, can_keep_credentials: canKeepCredentials, roles } = await fetchConnection(who.externalId, id));
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
              Credential{" "}
              <Tip>
                {credential.source === "stored"
                  ? "Given on this page and kept encrypted, under a key only the deployment's environment holds. Opened at the moment of each call, for this address only. Never shown again; replace or remove it under Settings."
                  : "Read from this variable at the moment of each call. The credential itself is never stored, shown or logged."}
              </Tip>
            </span>,
            <CredentialSummary key="c" credential={credential} />,
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
            <span key="k" className="w-row" style={{ gap: 6 }}>
              Offered to <Tip>{roles.filter((r) => connection.offered_to.includes(r.role)).map((r) => r.name).join("; ") || "No agent: tick roles under Settings."}</Tip>
            </span>,
            <span key="to">
              {connection.offered_to.length === 0 ? (
                <span className="w-faint">No agent</span>
              ) : (
                `${connection.offered_to.length} of ${roles.length} roles`
              )}
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
            connection.stake === null ? (
              <span key="st" className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <span className="w-faint">None given</span>
                <Tip>No stake is recorded on readings kept from this connection. They still belong to its party, and an interest that bears on one question is recorded by the agent weighing that question.</Tip>
              </span>
            ) : (
              <span key="st" className="w-row" style={{ gap: 6, flexWrap: "nowrap", maxWidth: 280 }}>
                <span className="w-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {connection.stake}
                </span>
                <Tip>{`${connection.stake} Recorded on every reading kept from the connection, as a fact about the source and never a finding against it.`}</Tip>
              </span>
            ),
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
                <ConnectionFields labels={labels} parties={parties} current={connection} roles={roles} />
              </WorkForm>
            </div>
          </div>
        )}
        {tab === "settings" && <CredentialCard connection={connection} canKeepCredentials={canKeepCredentials} />}
      </section>
    </WorkPage>
  );
}

function CredentialSummary({ credential }: { credential: ConnectionView["credential"] }) {
  if (credential.source === null) return <span className="w-muted">None asked for</span>;
  const header = credential.header === "Authorization" ? "Authorization, as a bearer token" : `${credential.header} header`;
  if (credential.source === "stored") {
    const key = credential.stored?.key ?? "missing";
    return (
      <span>
        Given here, kept encrypted
        <div className="w-faint w-small w-row" style={{ gap: 6 }}>
          {header}
          {credential.stored && ` · ${shortDay(credential.stored.given_at)}`}
          {key === "missing" ? (
            <Pill tone="bad" title="The key it was encrypted with is not set where the deployment runs, so calls go without it">
              Key missing
            </Pill>
          ) : (
            <Pill tone="ok" title={key === "previous" ? "Encrypted under a previous key, which is still set" : "Encrypted under the current key"}>
              Set
            </Pill>
          )}
        </div>
      </span>
    );
  }
  return (
    <span>
      <span className="w-mono">{credential.env}</span>
      <div className="w-faint w-small w-row" style={{ gap: 6 }}>
        {header}
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
  );
}

// The credential given on this page, in its own forms: pasting one sends it
// once and nothing shows it again, and saving the other settings never sends
// one.
function CredentialCard({ connection, canKeepCredentials }: { connection: ConnectionView; canKeepCredentials: boolean }) {
  const stored = connection.credential.source === "stored";
  return (
    <section className="w-card" aria-label="Credential" style={{ marginTop: 14 }}>
      <div className="w-card-h">Credential</div>
      <div className="w-card-b" style={{ maxWidth: 720 }}>
        <p className="w-muted w-small" style={{ marginTop: 0 }}>
          {stored
            ? "A credential was given here and is kept encrypted. It is never shown again. Pasting another replaces it."
            : connection.credential.source === "environment"
              ? `The credential is read from ${connection.credential.env}. Pasting one here keeps it encrypted instead, and the variable is no longer read.`
              : "Paste a read-only credential for the system. It is encrypted as it arrives and never shown again."}{" "}
          It is tied to this address: changing the address or the transport removes it.
        </p>
        {canKeepCredentials ? (
          <WorkForm action={setConnectionCredentialAction} submit={stored ? "Replace and test" : "Keep and test"} primary>
            <input type="hidden" name="connection_id" value={connection.id} />
            <div className="w-field">
              <label htmlFor="c-credential">{stored ? "New credential" : "Credential"}</label>
              <input
                id="c-credential"
                className="w-input w-mono"
                name="credential"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={8192}
                placeholder={connection.credential.header === "Authorization" ? "Paste the token, without “Bearer ”" : "Paste the credential"}
              />
            </div>
          </WorkForm>
        ) : (
          <Banner>
            <span>
              This deployment has no key to keep a credential with: CREDENTIAL_ENCRYPTION_KEY is not set where it runs. Whoever runs the deployment can set one; until then, name an environment variable above.
            </span>
          </Banner>
        )}
        {stored && (
          <div style={{ marginTop: 12 }}>
            <WorkForm action={removeConnectionCredentialAction} submit="Remove credential" danger small>
              <input type="hidden" name="connection_id" value={connection.id} />
            </WorkForm>
          </div>
        )}
      </div>
    </section>
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
