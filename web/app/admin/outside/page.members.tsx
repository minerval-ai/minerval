import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {

  ButtonLink,
  Drawer,
  Empty,
  Kv,
  Pill,
  Section,
  Seg,
  Stat,
  Stats,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  owls,
  plural,
  shortDay,
  shortWhen,
  type Tone,
} from "@/components/work/ui";
import {
  british,
  checkConnection,
  fetchConnectionAndDefaults,
  fetchOutwardLog,
  fetchPublicConversations,
  type ConnectionView,
  type ConnectWith,
  type Hosting,
  type DeploymentGrant,
  type OutwardAct,
  type PublicAccount,
  type PublicConversation,
} from "@/lib/outside-api";
import { LiveRefresh } from "@/components/LiveRefresh";
import { registerPublisherAction } from "../../releases/actions";
import { backPublicMandateAction, checkConnectionAction, connectAction, disconnectAction, openPublicMandateAction } from "./actions";
import { HeadSub, Note, loadAccount, tryRead } from "./parts";
import { DEPLOYMENT_GRANTS, PERMISSION_WORDS } from "@/lib/organization-permissions";

export const metadata: Metadata = { title: "Public graph · Minerval" };
export const dynamic = "force-dynamic";

// What this deployment does on the public graph besides releasing pages
// (docs/outward-acts.md): the organization's account there, its public owls
// and public mandates, and every act made in its name, with who made it and
// exactly what was sent. Every member may read this page. The forms are shown
// to those who hold the permission for acting on the public graph (direct),
// and registering the signing key to administrators.

/**
 * Each kind of act in the log, as a short verb phrase for its row, and the
 * group the filter puts it in. The API's own sentence (`what`) is the row's
 * hover text, and stands in for a kind this table does not know.
 */
const KINDS: Record<string, { verb: string; group: Group }> = {
  take_up_request: { verb: "Took up a request", group: "requests" },
  decline_request: { verb: "Declined a request it took up", group: "requests" },
  open_public_mandate: { verb: "Started a public mandate", group: "mandates" },
  public_mandate_message: { verb: "Wrote to the public Grantmaker", group: "mandates" },
  fund_public_mandate: { verb: "Funded a public mandate", group: "mandates" },
  back_public_mandate: { verb: "Added owls to a public mandate", group: "mandates" },
  publish_mandate: { verb: "Published a mandate's terms", group: "mandates" },
  fund_public_node: { verb: "Paid for a public assessment", group: "nodes" },
  raise_public_node: { verb: "Asked a mandate to assess a node", group: "nodes" },
  keep_current: { verb: "Asked for a fresh public assessment", group: "nodes" },
  send_report: { verb: "Sent an agent's report", group: "reports" },
  send_failure_facts: { verb: "Sent a tool failure's facts", group: "reports" },
  register_publisher: { verb: "Registered the signing key", group: "key" },
  connect_deployment: { verb: "Asked to connect to minerval.ai", group: "key" },
  disconnect_deployment: { verb: "Disconnected from minerval.ai", group: "key" },
};

type Group = "requests" | "mandates" | "nodes" | "reports" | "key";
const GROUPS: Array<{ key: Group | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "requests", label: "Requests" },
  { key: "mandates", label: "Mandates" },
  { key: "nodes", label: "Nodes" },
  { key: "reports", label: "Reports" },
  { key: "key", label: "Key" },
];

const RESULT: Record<OutwardAct["result"], { tone: Tone; text: string }> = {
  done: { tone: "ok", text: "Done" },
  refused: { tone: "bad", text: "Not taken" },
  failed: { tone: "warn", text: "Not sent" },
};

function verbOf(a: OutwardAct): string {
  const known = KINDS[a.kind]?.verb;
  if (known) return known;
  const what = british(a.what);
  return what.charAt(0).toUpperCase() + what.slice(1);
}

function mandateTone(status: string | null): Tone {
  if (!status) return "neu";
  if (/active|open|running|funded/i.test(status)) return "ok";
  if (/closed|ended|exhausted|spent|withdrawn/i.test(status)) return "neu";
  return "info";
}

export default async function OutsidePage({ searchParams }: { searchParams: Promise<{ kind?: string; drawer?: string; check?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { kind, drawer, check } = await searchParams;
  // Sent back here by minerval.ai after an admin approved this deployment: ask now, so it shows connected at once.
  if (check === "1") await checkConnection(who.externalId).catch(() => undefined);
  const filter = GROUPS.some((g) => g.key === kind) ? (kind as Group | "all") : "all";

  const mayAct = can(who, "direct");
  const [{ data: account, problem: accountProblem }, { data: log, problem: logProblem }, { data: talks, problem: talksProblem }, connectionRead] = await Promise.all([
    loadAccount(who.externalId),
    tryRead(() => fetchOutwardLog(who.externalId), "The log of acts on the public graph could not be read"),
    // The conversations with the public Grantmaker are read by those who may act there, who are the ones who open and fund them.
    mayAct
      ? tryRead(() => fetchPublicConversations(who.externalId), "The conversations with the public Grantmaker could not be read")
      : Promise.resolve({ data: null, problem: null }),
    fetchConnectionAndDefaults(who.externalId).catch(() => ({ connection: null as ConnectionView | null, connect_with: undefined })),
  ]);
  const connection = connectionRead.connection;
  const acts = log ?? [];
  const mayAdminister = can(who, "administer");
  const connected = !!account?.connected;
  const shown = filter === "all" ? acts : acts.filter((a) => KINDS[a.kind]?.group === filter);
  const registration = account?.registration ?? null;
  const close = filter === "all" ? "/admin/outside" : `/admin/outside?kind=${filter}`;
  const drawerHref = (d: string) => (filter === "all" ? `/admin/outside?drawer=${d}` : `/admin/outside?kind=${filter}&drawer=${d}`);
  const mandates = account?.public_mandates ?? [];
  // Drafts: conversations not funded, beside the mandates already funded. One that was funded is its mandate's row.
  const drafts = (talks?.conversations ?? []).filter((t) => !t.funded && !["declined", "abandoned"].includes(t.status_on_the_public_graph ?? ""));

  return (
    <WorkPage>
      <WorkHead
        title="Public graph"
        sub={
          <HeadSub account={account} problem={accountProblem}>
            Acts there as an ordinary account{" "}
            <Tip>
              Every act is a call any account on the public graph could make, under the organization&apos;s own account. Each is made by a
              person who holds the permission for it, and is listed below with who made it and exactly what was sent.
            </Tip>
          </HeadSub>
        }
        actions={
          mayAct &&
          connected && (
            <ButtonLink href={drawerHref("new")} primary icon="plus">
              New public mandate
            </ButtonLink>
          )
        }
      />

      {accountProblem && <Note tone="bad">{accountProblem}</Note>}
      {account && !connected && <Note tone="warn">{british(account.in_words ?? "This deployment is not connected to the public graph.")}</Note>}

      <ConnectionCard connection={connection} mayAdminister={mayAdminister} connectHref={drawerHref("connect")} disconnectHref={drawerHref("disconnect")} />

      {account && <AccountStats account={account} mayAdminister={mayAdminister} keyHref={drawerHref("key")} />}

      {mayAdminister && drawer === "connect" && (
        <Drawer title={connection?.state === "waiting" ? "Waiting for your organization" : "Connect to minerval.ai"} close={close}>
          <ConnectDrawer connection={connection} connectWith={connectionRead.connect_with ?? null} />
        </Drawer>
      )}
      {mayAdminister && drawer === "disconnect" && connection && (
        <Drawer title="Disconnect from minerval.ai" close={close}>
          <p className="w-muted" style={{ marginTop: 0 }}>
            This deployment tells minerval.ai to retire it, with one last signed request, and forgets its connection key. Nothing it sent
            there is taken back. Connecting again makes a new key and needs a new approval.
          </p>
          <WorkForm action={disconnectAction} submit="Disconnect" danger lock="Retires the key on minerval.ai" />
        </Drawer>
      )}

      {connected && (
        <Section
          title="Public mandates"
          aside={`${plural(mandates.length, "mandate")} · public on the public graph${drafts.length > 0 ? ` · ${plural(drafts.length, "draft")}` : ""}`}
          id="mandates"
        >
          {talksProblem && <Note tone="bad">{talksProblem}</Note>}
          {mandates.length === 0 && drafts.length === 0 ? (
            <div className="w-tbox">
              <Empty>The organization funds no mandate on the public graph.</Empty>
            </div>
          ) : (
            <Table label="Public mandates">
              <thead>
                <tr>
                  <th>Mandate</th>
                  <th>Status</th>
                  <th style={{ width: 240 }}>Spent (public owls)</th>
                  {mayAct && <th className="w-act">Add owls</th>}
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => (
                  <DraftRow key={d.id} d={d} mayAct={mayAct} />
                ))}
                {mandates.map((m) => {
                  const share = m.spent_owls !== null && m.budget_owls ? Math.min(100, Math.round((m.spent_owls / m.budget_owls) * 100)) : null;
                  return (
                    <tr key={m.id}>
                      <td>
                        {m.conversation_id && mayAct ? (
                          <Link href={`/admin/outside/mandates/${m.conversation_id}`} style={{ fontWeight: 500 }} title="The conversation with the public Grantmaker it was funded from">
                            {m.title ?? "A public mandate"}
                          </Link>
                        ) : (
                          <span style={{ fontWeight: 500 }}>{m.title ?? "A public mandate"}</span>
                        )}
                        <div className="w-faint w-mono">{m.id}</div>
                      </td>
                      <td>{m.status ? <Pill tone={mandateTone(m.status)}>{cap(m.status.replace(/_/g, " "))}</Pill> : <span className="w-faint">—</span>}</td>
                      <td>
                        {share !== null ? (
                          <div className="w-row" style={{ flexWrap: "nowrap", gap: 10 }}>
                            <div className="w-bar" style={{ flex: 1 }}>
                              <i style={{ width: `${share}%` }} />
                            </div>
                            <span className="w-small" style={{ whiteSpace: "nowrap" }}>
                              {owls(m.spent_owls)} of {owls(m.budget_owls)}
                            </span>
                          </div>
                        ) : (
                          <span className="w-small">{m.budget_owls !== null ? `${owls(m.budget_owls)} budget` : "—"}</span>
                        )}
                      </td>
                      {mayAct && (
                        <td className="w-act">
                          <WorkForm action={backPublicMandateAction} submit="Add owls" inline>
                            <input type="hidden" name="mandate_id" value={m.id} />
                            <input className="w-input w-narrow" name="owls" type="number" min="0.01" step="0.01" placeholder="Owls" aria-label="Public owls to add" required />
                          </WorkForm>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Section>
      )}

      <Section
        title="Activity"
        aside={
          <>
            every act in the organization&apos;s name · pages sent are in the <Link href="/outbound">Outbox</Link>
          </>
        }
        id="log"
      >
        {logProblem && <Note tone="bad">{logProblem}</Note>}
        {acts.length > 0 && (
          <div className="w-toolbar">
            <Seg
              current={filter}
              options={GROUPS.filter((g) => g.key === "all" || acts.some((a) => KINDS[a.kind]?.group === g.key) || g.key === filter).map((g) => ({
                key: g.key,
                href: g.key === "all" ? "/admin/outside" : `/admin/outside?kind=${g.key}`,
                label: g.label,
              }))}
            />
          </div>
        )}
        {shown.length === 0 ? (
          <div className="w-tbox">
            <Empty>
              {acts.length === 0 ? "Nothing has been done on the public graph from this deployment." : "No act of this kind."}
            </Empty>
          </div>
        ) : (
          <Table label="Acts on the public graph">
            <thead>
              <tr>
                <th style={{ width: 110 }}>When</th>
                <th>What</th>
                <th>By</th>
                <th>On the public graph</th>
                <th>Result</th>
                <th className="w-act" />
              </tr>
            </thead>
            {shown.map((a) => (
              <ActRow key={a.id} a={a} />
            ))}
          </Table>
        )}
      </Section>

      {drawer === "new" && mayAct && connected && account && (
        <Drawer title="New public mandate" close={close} wide>
          <WorkForm action={openPublicMandateAction} submit="Send to the public Grantmaker" primary lock="Sent as written, and public">
            <div className="w-field">
              <label htmlFor="pm-message">What the mandate is for</label>
              <textarea id="pm-message" className="w-input" name="message" rows={6} required maxLength={10000} placeholder="In your own words, as the public will read them" />
              <span className="w-help">These words leave the deployment exactly as you write them. Nothing from this deployment is added.</span>
            </div>
            <details className="w-pub-more">
              <summary>What a public mandate shows outside</summary>
              <p className="w-small" style={{ margin: "8px 0 0", maxWidth: "62ch" }}>
                {british(account.what_a_public_mandate_shows ?? "")}
              </p>
            </details>
            <label className="w-check">
              <input type="checkbox" name="understood" value="yes" required /> I have read what this shows outside
            </label>
          </WorkForm>
        </Drawer>
      )}

      {drawer === "key" && mayAdminister && (
        <Drawer title={registration ? "Re-register the signing key" : "Register the signing key"} close={close}>
          <p className="w-small" style={{ margin: 0 }}>
            The public graph takes a package only from the account this deployment&apos;s signing key is registered to. Registering names the
            organization&apos;s account there as the publisher of what this deployment signs, and says where the deployment runs. Registering
            again retires the earlier registration, which stays on the public record.
          </p>
          {registration?.is_the_current_key === false && (
            <p className="w-small" style={{ margin: 0 }}>
              The key registered now, {registration.key_fingerprint.slice(0, 16)}, is not the one this deployment signs with
              {account?.signing_key_fingerprint ? ` (${account.signing_key_fingerprint.slice(0, 16)})` : ""}. Registering puts the current key on record.
            </p>
          )}
          <WorkForm action={registerPublisherAction} submit={registration ? "Re-register" : "Register key"} primary lock="Public on the publisher's record">
            <div className="w-field">
              <label htmlFor="pm-interest">
                Declared interest <span className="w-faint">optional</span>
              </label>
              <textarea id="pm-interest" className="w-input" name="declared_interest" rows={3} maxLength={1000} />
              <span className="w-help">Shown whole beside every page the organization publishes: what it stands to gain or lose from how those nodes are judged.</span>
            </div>
            <span className="w-help">Recorded here with your name and the permissions you hold.</span>
          </WorkForm>
        </Drawer>
      )}
    </WorkPage>
  );
}

function AccountStats({ account, mayAdminister, keyHref }: { account: PublicAccount; mayAdminister: boolean; keyHref: string }) {
  const holders = /^Holders of ([\w, ]+?) may act/i.exec(account.who_may_act)?.[1];
  const r = account.registration ?? null;
  const pill = !r ? (
    <Pill tone={account.signing_key_fingerprint === null ? "neu" : "warn"}>Not registered</Pill>
  ) : r.is_the_current_key === false ? (
    <Pill tone="warn">Another key registered</Pill>
  ) : (
    <Pill tone="ok">Registered {shortDay(r.registered_at)}</Pill>
  );
  const about = [
    account.registration_in_words ? british(account.registration_in_words) : null,
    r ? `Key ${r.key_fingerprint.slice(0, 16)}, to ${r.account.name ?? r.account.id ?? "the organization's account"}, ${shortWhen(r.registered_at)}.` : null,
    r?.registered_from_here ? `Registered from here${r.registered_from_here.by ? ` by ${r.registered_from_here.by}` : ""}.` : null,
    r?.declared_interest ? `Declared interest: “${r.declared_interest}”` : null,
    r ? `Read from ${r.read_from}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Stats>
      <Stat
        k="Public owls"
        v={account.connected ? owls(account.public_owls ?? 0) : "—"}
        s={
          <span className="w-row" style={{ gap: 6 }}>
            Separate from private owls{" "}
            <Tip>
              {british(
                account.public_owls_statement ??
                  "Public owls are the account's balance on the public graph. They never convert to or from this deployment's own owls."
              )}
            </Tip>
          </span>
        }
      />
      <Stat
        k={
          <>
            Who may act <Tip>{`${british(account.who_may_act)} Registering the signing key takes administer.`}</Tip>
          </>
        }
        v={<span style={{ fontSize: 16 }}>{holders ? `Holders of ${holders}` : "See note"}</span>}
        s="Signing key: administer"
      />
      <Stat
        k={<>Signing key {about && <Tip>{about}</Tip>}</>}
        v={
          <span className="w-row" style={{ gap: 8, marginTop: 4 }}>
            {pill}
            {mayAdminister && (
              <ButtonLink href={keyHref} small>
                {r ? "Re-register" : "Register key"}
              </ButtonLink>
            )}
          </span>
        }
        s={r ? <span className="w-mono">{r.key_fingerprint.slice(0, 16)}</span> : undefined}
      />
    </Stats>
  );
}

/** A conversation with the public Grantmaker whose mandate is not funded yet: its draft, linked to the conversation. */
function DraftRow({ d, mayAct }: { d: PublicConversation; mayAct: boolean }) {
  const drafted = d.status_on_the_public_graph === "proposed";
  return (
    <tr>
      <td>
        <Link href={`/admin/outside/mandates/${d.id}`} style={{ fontWeight: 500 }}>
          {d.title ?? "A new public mandate"}
        </Link>
        <div className="w-faint w-small">
          {d.opened_at ? `Opened ${shortDay(d.opened_at)}` : "Opened"}
          {d.opened_by ? ` by ${d.opened_by}` : d.opened_from_here ? "" : " · not from here"}
        </div>
      </td>
      <td>
        <Pill tone="info">{drafted ? "Draft · not funded" : "Draft"}</Pill>
      </td>
      <td>
        <span className="w-faint w-small">Not funded</span>
      </td>
      {mayAct && (
        <td className="w-act">
          <Link className="w-btn w-sm" href={`/admin/outside/mandates/${d.id}`}>
            Open
          </Link>
        </td>
      )}
    </tr>
  );
}

function ActRow({ a }: { a: OutwardAct }) {
  const result = RESULT[a.result] ?? { tone: "neu" as Tone, text: a.result };
  const sent = Object.keys(a.sent ?? {}).length > 0;
  return (
    <tbody className="w-pub-xg">
      <tr>
        <td className="w-muted" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {shortWhen(a.at)}
        </td>
        <td title={british(a.what)}>{verbOf(a)}</td>
        <td className="w-small">
          {a.by ? (/^the /.test(a.by) ? cap(a.by) : a.by) : <span className="w-faint">Nobody named</span>}
          {a.holding.length > 0 && (
            <>
              {" "}
              <Tip>{`Holding ${a.holding.join(", ")}`}</Tip>
            </>
          )}
        </td>
        <td>{a.on_the_public_graph ? <span className="w-mono">{a.on_the_public_graph}</span> : <span className="w-faint">—</span>}</td>
        <td>
          <Pill tone={result.tone}>{result.text}</Pill>
        </td>
        <td className="w-act">
          <details className="w-pub-tg">
            <summary className="w-btn w-ghost w-sm" aria-label="Show what was sent">
              Sent
            </summary>
          </details>
        </td>
      </tr>
      <tr className="w-detail w-pub-xrow">
        <td />
        <td colSpan={5}>
          <div className="w-pub-xb">
            <div>
              <span className="w-pub-k">Sent</span>
              {sent ? <pre className="w-code">{JSON.stringify(a.sent, null, 2)}</pre> : <span className="w-faint w-small">Nothing was sent with it.</span>}
            </div>
            <div>
              <span className="w-pub-k">What the public graph answered</span>
              <div className="w-small">{a.the_public_graph_said ? a.the_public_graph_said : <span className="w-faint">Nothing recorded.</span>}</div>
              <p className="w-small w-muted" style={{ margin: "10px 0 0" }}>
                {cap(british(a.what))}.
              </p>
            </div>
          </div>
        </td>
      </tr>
    </tbody>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const GRANT_WORDS = PERMISSION_WORDS;

/** This deployment's connection to minerval.ai (docs/organizations.md, "Connecting"). */
function ConnectionCard({
  connection,
  mayAdminister,
  connectHref,
  disconnectHref,
}: {
  connection: ConnectionView | null;
  mayAdminister: boolean;
  connectHref: string;
  disconnectHref: string;
}) {
  const state = connection?.state ?? "none";
  if (state === "connected" && connection) {
    const orgName = connection.organization?.name ?? "the organization";
    // Its organization's page on minerval.ai, where its admins change what this deployment may do.
    const orgPage = connection.web_url && connection.organization ? `${connection.web_url}/account/organizations/${connection.organization.id}` : null;
    return (
      <Section
        title={
          orgPage ? (
            <>
              Connected as <a href={orgPage}>{orgName}</a>
            </>
          ) : (
            `Connected as ${orgName}`
          )
        }
        aside={`This deployment is ${connection.deployment?.name ?? "connected"} on minerval.ai, since ${shortDay(connection.connected_at)}`}
        actions={mayAdminister ? <ButtonLink href={disconnectHref} danger small>Disconnect</ButtonLink> : undefined}
      >
        <div className="w-row" style={{ flexWrap: "wrap", gap: 6 }}>
          <Pill tone="ok">Connected</Pill>
          {DEPLOYMENT_GRANTS.map((g) => (
            <span key={g} title={GRANT_WORDS[g]}>
              <Pill tone={connection.grants.includes(g) ? "ok" : "neu"}>
                <span className="w-mono">{g}</span> {connection.grants.includes(g) ? "held" : "not held"}
              </Pill>
            </span>
          ))}
        </div>
        <p className="w-muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          What it may do is chosen by an admin of {orgName} on minerval.ai
          {orgPage ? (
            <>
              , on its <a href={`${orgPage}?tab=deployments`}>Deployments tab</a>
            </>
          ) : null}
          . Every request there is signed with this deployment&apos;s own key (<span className="w-mono">{connection.key_id?.slice(0, 8)}</span>
          ){connection.hosting ? `, and states that it runs ${HOSTING_LABEL[connection.hosting].toLowerCase()}` : ""}.
        </p>
        {connection.problem && <Note tone="warn">{british(connection.problem)}</Note>}
      </Section>
    );
  }
  return (
    <Section
      title="minerval.ai"
      aside={state === "waiting" ? "Waiting for an admin of your organization" : "Not connected"}
      actions={
        mayAdminister ? (
          <ButtonLink href={connectHref} primary small>
            {state === "waiting" ? "Open the request" : "Connect to minerval.ai"}
          </ButtonLink>
        ) : undefined
      }
    >
      <p className="w-muted" style={{ margin: 0 }}>
        {state === "waiting"
          ? `Code ${connection?.code ?? ""}: waiting for an admin of your organization to approve it on minerval.ai.`
          : state === "denied"
            ? "An admin of the organization denied the last request. Connect again to ask anew."
            : state === "expired"
              ? "The last code expired before anyone approved it. Connect again for a new one."
              : mayAdminister
                ? "Connect it to act for your organization on minerval.ai with a key of its own: following the public graph, publishing what its gate lets out, and the acts on this page. An admin of the organization approves it there."
                : "Not connected to minerval.ai. An administrator of this deployment connects it, and an admin of the organization approves it there."}
      </p>
    </Section>
  );
}

const HOSTING_LABEL: Record<Hosting, string> = {
  own_machines: "On our own machines",
  third_party: "On machines we hired",
  minerval: "Minerval runs it for us",
};

const HOSTING_HELP: Record<Hosting, string> = {
  own_machines: "Servers the organization owns or controls itself.",
  third_party: "A cloud provider or host the organization pays, such as AWS or a data centre.",
  minerval: "A deployment Minerval runs for the organization. Minerval checks this one.",
};

function ConnectDrawer({ connection, connectWith }: { connection: ConnectionView | null; connectWith: ConnectWith | null }) {
  if (connection?.state === "waiting") {
    return (
      <>
        {/* The drawer asks the public graph every five seconds while it is open: reading this page checks a waiting connection. */}
        <LiveRefresh seconds={5} />
        <p className="w-muted" style={{ marginTop: 0 }}>
          An admin of your organization approves this on minerval.ai, signed in as themselves, and chooses what this deployment may do there.
          This drawer checks every few seconds and shows it connected; nothing restarts.
        </p>
        {connection.link && (
          <div className="w-row" style={{ gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
            <ButtonLink href={connection.link} primary>
              Approve on minerval.ai
            </ButtonLink>
          </div>
        )}
        <p className="w-muted" style={{ fontSize: 12.5 }}>
          You are sent back here after approving. Not an admin of the organization? Open “Someone else approves” for the link to send one of its admins.
        </p>
        <details className="w-details">
          <summary>Someone else approves</summary>
          <p className="w-muted">Send them this link. They check that the code and key id match what you see here.</p>
          <div className="w-mono" style={{ fontSize: 26, letterSpacing: "0.08em", textAlign: "center", padding: "12px 0", border: "1px dashed var(--w-rule2)", borderRadius: 10 }}>
            {connection.code}
          </div>
          {connection.link && (
            <p style={{ wordBreak: "break-all" }}>
              <a href={connection.link}>{connection.link}</a>
            </p>
          )}
        </details>
        <Kv
          rows={[
            ["Key id", <span key="k" className="w-mono">{connection.key_id?.slice(0, 8)} (first eight)</span>],
            ["Expires", shortWhen(connection.code_expires_at)],
          ]}
        />
        <WorkForm action={checkConnectionAction} submit="Check now" />
      </>
    );
  }
  const replacing = connection?.state === "connected";
  const w = connectWith;
  return (
    <>
      <p className="w-muted" style={{ marginTop: 0 }}>
        This deployment makes a key of its own, which never leaves it, and asks your organization on minerval.ai to approve it. An admin of the
        organization chooses what it may do there.
        {replacing && " It is connected already: connecting again makes a new key, and the old connection stops when this one is approved."}
      </p>
      <WorkForm action={connectAction} submit={replacing ? "Connect again" : "Connect"} primary>
        {replacing && <input type="hidden" name="replace" value="1" />}
        <div className="w-field">
          <label htmlFor="connect-name">What to call this deployment</label>
          <input id="connect-name" className="w-input" name="name" required maxLength={120} defaultValue={w?.name ?? connection?.deployment?.name ?? ""} />
          <span className="w-help">Shown to your organization, and on every page this deployment publishes. Your organization&apos;s admin can change it.</span>
        </div>
        <div className="w-field">
          <span className="w-label">Where it runs</span>
          {w?.hosting_fixed && w.hosting ? (
            <>
              <input type="hidden" name="hosting" value={w.hosting} />
              <p style={{ margin: "2px 0" }}>
                <b>{HOSTING_LABEL[w.hosting]}</b>
              </p>
              <span className="w-help">Fixed by the operator who runs this server (DEPLOYMENT_HOSTING).</span>
            </>
          ) : (
            <>
              <div className="w-options">
                {(Object.keys(HOSTING_LABEL) as Hosting[]).map((h) => (
                  <label key={h} className="w-option">
                    <input type="radio" name="hosting" value={h} required defaultChecked={w?.hosting === h} />
                    <div>
                      <b>{HOSTING_LABEL[h]}</b>
                      <span>{HOSTING_HELP[h]}</span>
                    </div>
                  </label>
                ))}
              </div>
              <span className="w-help">
                Shown to your organization&apos;s admin and on every page this deployment publishes. It is your statement.
              </span>
            </>
          )}
        </div>
        {w && w.needs.length > 0 && (
          <div className="w-field">
            <span className="w-label">What its settings need</span>
            <ul className="w-muted" style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
              {w.needs.map((n) => (
                <li key={n.grant}>
                  <span className="w-mono">{n.grant}</span>: {n.why}
                </li>
              ))}
            </ul>
            <span className="w-help">Sent so the admin can see why. They choose; these are only ticked to start with.</span>
          </div>
        )}
        <details className="w-details">
          <summary>Advanced</summary>
          <div className="w-field">
            <label htmlFor="connect-url">The public graph&apos;s address</label>
            <input id="connect-url" className="w-input" name="api_url" placeholder={w?.api_url ?? "https://api.claimgraph.io"} />
            <span className="w-help">Minerval&apos;s, unless you were told another.</span>
          </div>
          {w && (
            <p className="w-muted" style={{ fontSize: 12.5 }}>
              {w.address
                ? `This deployment's own address, ${w.address}, is sent too, for links back to it: the admin is returned here after approving.`
                : "This deployment has no address of its own to send (PUBLIC_WEB_BASE_URL), so the admin is not sent back here after approving; this drawer still sees the approval."}
            </p>
          )}
        </details>
      </WorkForm>
    </>
  );
}
