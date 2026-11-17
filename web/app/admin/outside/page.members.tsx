import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {

  ButtonLink,
  Drawer,
  Empty,
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
import { british, fetchOutwardLog, type OutwardAct, type PublicAccount } from "@/lib/outside-api";
import { registerPublisherAction } from "../../showings/actions";
import { backPublicMandateAction, openPublicMandateAction } from "./actions";
import { HeadSub, Note, loadAccount, tryRead } from "./parts";

export const metadata: Metadata = { title: "Public graph · Minerval" };
export const dynamic = "force-dynamic";

// What this deployment does on the public graph besides showing pages
// (docs/outward-acts.md): the organisation's account there, its public owls
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

export default async function OutsidePage({ searchParams }: { searchParams: Promise<{ kind?: string; drawer?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { kind, drawer } = await searchParams;
  const filter = GROUPS.some((g) => g.key === kind) ? (kind as Group | "all") : "all";

  const [{ data: account, problem: accountProblem }, { data: log, problem: logProblem }] = await Promise.all([
    loadAccount(who.externalId),
    tryRead(() => fetchOutwardLog(who.externalId), "The log of acts on the public graph could not be read"),
  ]);
  const acts = log ?? [];
  const mayAct = can(who, "direct");
  const mayAdminister = can(who, "administer");
  const connected = !!account?.connected;
  const shown = filter === "all" ? acts : acts.filter((a) => KINDS[a.kind]?.group === filter);
  const registered = acts.find((a) => a.kind === "register_publisher" && a.result === "done");
  const close = filter === "all" ? "/admin/outside" : `/admin/outside?kind=${filter}`;
  const drawerHref = (d: string) => (filter === "all" ? `/admin/outside?drawer=${d}` : `/admin/outside?kind=${filter}&drawer=${d}`);
  const mandates = account?.public_mandates ?? [];

  return (
    <WorkPage>
      <WorkHead
        title="Public graph"
        sub={
          <HeadSub account={account} problem={accountProblem}>
            Acts there as an ordinary account{" "}
            <Tip>
              Every act is a call any account on the public graph could make, under the organisation&apos;s own account. Each is made by a
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

      {account && <AccountStats account={account} registeredAt={registered?.at ?? null} mayAdminister={mayAdminister} keyHref={drawerHref("key")} />}

      {connected && (
        <Section title="Public mandates" aside={`${plural(mandates.length, "mandate")} · public on the public graph`} id="mandates">
          {mandates.length === 0 ? (
            <div className="w-tbox">
              <Empty>The organisation funds no mandate on the public graph.</Empty>
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
                {mandates.map((m) => {
                  const share = m.spent_owls !== null && m.budget_owls ? Math.min(100, Math.round((m.spent_owls / m.budget_owls) * 100)) : null;
                  return (
                    <tr key={m.id}>
                      <td>
                        <span style={{ fontWeight: 500 }}>{m.title ?? "A public mandate"}</span>
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
            every act in the organisation&apos;s name · pages sent are in the <Link href="/outbound">Outbox</Link>
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
        <Drawer title={registered ? "Re-register the signing key" : "Register the signing key"} close={close}>
          <p className="w-small" style={{ margin: 0 }}>
            The public graph takes a package only from the account this deployment&apos;s signing key is registered to. Registering names the
            organisation&apos;s account there as the publisher of what this deployment signs, and says where the deployment runs. Registering
            again retires the earlier registration, which stays on the public record.
          </p>
          <WorkForm action={registerPublisherAction} submit={registered ? "Re-register" : "Register key"} primary lock="Public on the publisher's record">
            <div className="w-field">
              <label htmlFor="pm-interest">
                Declared interest <span className="w-faint">optional</span>
              </label>
              <textarea id="pm-interest" className="w-input" name="declared_interest" rows={3} maxLength={1000} />
              <span className="w-help">Shown whole beside every page the organisation publishes: what it stands to gain or lose from how those nodes are judged.</span>
            </div>
            <span className="w-help">Recorded here with your name and the permissions you hold.</span>
          </WorkForm>
        </Drawer>
      )}
    </WorkPage>
  );
}

function AccountStats({
  account,
  registeredAt,
  mayAdminister,
  keyHref,
}: {
  account: PublicAccount;
  registeredAt: string | null;
  mayAdminister: boolean;
  keyHref: string;
}) {
  const holders = /^Holders of ([\w, ]+?) may act/i.exec(account.who_may_act)?.[1];
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
        k={
          <>
            Signing key <Tip>Whether the key is registered on the public graph is not readable here; this shows the last registration in the log.</Tip>
          </>
        }
        v={
          <span className="w-row" style={{ gap: 8, marginTop: 4 }}>
            {registeredAt ? <Pill tone="ok">Registered {shortDay(registeredAt)}</Pill> : <Pill tone="neu">None in the log</Pill>}
            {mayAdminister && (
              <ButtonLink href={keyHref} small>
                {registeredAt ? "Re-register" : "Register key"}
              </ButtonLink>
            )}
          </span>
        }
      />
    </Stats>
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
