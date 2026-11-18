import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { AccountApiError, fetchAccount, type GrantView, type OwlLedgerEntry, type OwlPack } from "../../../../lib/account-api";
import {
  getOrganization,
  listInvitations,
  listLog,
  listMembers,
  listOldKeys,
  organizationAccount,
  organizationLedger,
  organizationMandates,
  type InvitationView,
  type LogEntry,
  type MemberView,
  type OldKeyView,
  type OrganizationView,
} from "../../../../lib/organizations-api";
import {
  Banner,
  ButtonLink,
  Card,
  Drawer,
  Empty,
  Pill,
  Section,
  Stat,
  Stats,
  Table,
  Tabs,
  WorkHead,
  WorkPage,
  owls,
  plural,
  shortDay,
  shortWhen,
} from "../../../../components/work/ui";
import { WorkForm } from "../../../../components/work/WorkForm";
import {
  addToMandateAction,
  buyOwlsAction,
  cancelInvitationAction,
  fundClaimAction,
  inviteAction,
  removeMemberAction,
  renameAction,
  revokeOldKeyAction,
  setRoleAction,
} from "../actions";

export const metadata: Metadata = { title: "Organization · Minerval" };
export const dynamic = "force-dynamic";

// One organization (docs/organizations.md, "The organization's pages"). Its
// members read every tab but the two that act with its money; its admins
// change it and act for it, from their own session, as themselves.

type Tab = "overview" | "members" | "acts" | "billing" | "log";
const TABS: Tab[] = ["overview", "members", "acts", "billing", "log"];
const ADMIN_TABS: ReadonlySet<Tab> = new Set(["acts", "billing"]);

/** A log entry in words. */
function logLine(e: LogEntry, names: Map<string, string>): string {
  const who = (id: unknown) => (typeof id === "string" ? names.get(id) ?? "someone" : "someone");
  const d = e.detail;
  switch (e.kind) {
    case "created":
      return `made the organization`;
    case "renamed":
      return `renamed it from ${String(d.from)} to ${String(d.to)}`;
    case "invited":
      return `made an invitation as ${String(d.role)}`;
    case "invitation_cancelled":
      return "cancelled an invitation";
    case "joined":
      return `joined as ${String(d.role)}`;
    case "role_changed":
      return `made ${who(d.account_id)} ${d.to === "admin" ? "an admin" : "a member"}`;
    case "removed":
      return `removed ${who(d.account_id)}`;
    case "left":
      return "left";
    case "admin_added_by_operator":
      return `made ${who(d.account_id)} an admin, with the operator key`;
    case "converted":
      return "accepted, as first admin, that the shared account becomes this organization";
    case "old_key_revoked":
      return `revoked the old key ${String(d.key_prefix)}…`;
    case "acted":
      return `acted for the organization: ${String(d.method)} ${String(d.route)} (${String(d.status)})`;
    default:
      return e.kind;
  }
}

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; drawer?: string }>;
}) {
  const { id } = await params;
  const { tab: askedTab, drawer } = await searchParams;
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  const me = session.externalId;

  let org: OrganizationView;
  try {
    org = await getOrganization(me, id);
  } catch (err) {
    if (err instanceof AccountApiError && err.status === 404) notFound();
    throw err;
  }
  const admin = org.role === "admin";
  const wanted = (TABS as string[]).includes(askedTab ?? "") ? (askedTab as Tab) : "overview";
  const tab: Tab = ADMIN_TABS.has(wanted) && !admin ? "overview" : wanted;
  const base = `/account/organizations/${id}`;
  const here = (t: Tab, extra = "") => `${base}?tab=${t}${extra}`;

  const [myId, members, invitations, oldKeys, log, account] = await Promise.all([
    fetchAccount(me).then((a) => a.user.id, () => null),
    listMembers(me, id).catch(() => [] as MemberView[]),
    listInvitations(me, id).catch(() => [] as InvitationView[]),
    listOldKeys(me, id).catch(() => [] as OldKeyView[]),
    tab === "log" || tab === "overview" ? listLog(me, id, tab === "log" ? 200 : 6).catch(() => [] as LogEntry[]) : Promise.resolve([] as LogEntry[]),
    admin ? organizationAccount(me, id).catch(() => null) : Promise.resolve(null),
  ]);
  const [mandates, ledger] = await Promise.all([
    admin && tab === "acts" ? organizationMandates(me, id).catch(() => [] as GrantView[]) : Promise.resolve([] as GrantView[]),
    admin && tab === "billing" ? organizationLedger(me, id, 100).catch(() => [] as OwlLedgerEntry[]) : Promise.resolve([] as OwlLedgerEntry[]),
  ]);
  const names = new Map(members.map((m) => [m.account_id, m.display_name]));
  const admins = members.filter((m) => m.role === "admin").length;
  const openInvitations = invitations.filter((i) => i.state === "open");
  const balance = account?.entitlement.owl_balance;

  const tabs = [
    { key: "overview", label: "Overview", href: here("overview") },
    { key: "members", label: "Members", href: here("members"), count: members.length },
    ...(admin
      ? [
          { key: "acts", label: "Public acts", href: here("acts") },
          { key: "billing", label: "Billing", href: here("billing") },
        ]
      : []),
    { key: "log", label: "Log", href: here("log") },
  ];

  return (
    <WorkPage>
      <WorkHead
        title={org.name}
        sub={`Organization · you are ${admin ? "an admin" : "a member"}`}
        crumbs={[
          { href: "/account", label: "Account" },
          { href: "/account/organizations", label: "Organizations" },
        ]}
        actions={
          <>
            <ButtonLink href={`/contributors/${id}`}>Public page</ButtonLink>
            {admin && (
              <ButtonLink href={here("billing")} primary>
                Buy owls
              </ButtonLink>
            )}
          </>
        }
      />
      <Tabs tabs={tabs} current={tab} />

      {tab === "overview" && (
        <>
          <Stats>
            <Stat k="Public owls" v={balance === undefined ? "—" : owls(balance)} s={admin ? "Bought on minerval.ai" : "Admins see the balance"} />
            <Stat k="Members" v={members.length} s={`${plural(admins, "admin")} · ${plural(openInvitations.length, "invitation")} open`} />
            <Stat k="Old keys still live" v={oldKeys.length} s={oldKeys.length ? "From before it was an organization" : "None"} />
          </Stats>
          {oldKeys.length > 0 && (
            <Section title="Old keys still live" aside="They can do anything the organization can. Revoke each once nothing uses it">
              <Table label="Old keys">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Name</th>
                    <th>Made</th>
                    <th>Last used</th>
                    {admin && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {oldKeys.map((k) => (
                    <tr key={k.id}>
                      <td className="w-mono">{k.key_prefix}…</td>
                      <td>{k.name}</td>
                      <td>{shortDay(k.created_at)}</td>
                      <td>{k.last_used_at ? shortWhen(k.last_used_at) : "Never"}</td>
                      {admin && (
                        <td>
                          <WorkForm action={revokeOldKeyAction} submit="Revoke" danger inline>
                            <input type="hidden" name="organization_id" value={id} />
                            <input type="hidden" name="key_id" value={k.id} />
                          </WorkForm>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Section>
          )}
          {admin && (
            <Section title="Name">
              <Card>
                <WorkForm action={renameAction} submit="Rename">
                  <input type="hidden" name="organization_id" value={id} />
                  <div className="w-field">
                    <label htmlFor="org-rename">Name</label>
                    <input id="org-rename" className="w-input" name="name" defaultValue={org.name} required maxLength={120} />
                    <span className="w-help">Public, and proves nothing on its own.</span>
                  </div>
                </WorkForm>
              </Card>
            </Section>
          )}
          <Section title="Recent" actions={<Link href={here("log")}>Whole log</Link>}>
            <LogTable log={log} names={names} />
          </Section>
        </>
      )}

      {tab === "members" && (
        <>
          <Section
            title="Members"
            aside="An organization always has an admin"
            actions={admin ? <ButtonLink href={here("members", "&drawer=invite")} primary>Invite</ButtonLink> : undefined}
          >
            <Table label="Members">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Added</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const self = m.account_id === myId;
                  return (
                    <tr key={m.account_id}>
                      <td>
                        <Link href={`/contributors/${m.account_id}`}>{m.display_name}</Link>
                        {self && <span className="w-muted"> (you)</span>}
                      </td>
                      <td>
                        <Pill tone={m.role === "admin" ? "info" : "neu"}>{m.role === "admin" ? "Admin" : "Member"}</Pill>
                      </td>
                      <td>
                        {shortDay(m.added_at)}
                        {m.added_by ? ` by ${m.added_by}` : ""}
                      </td>
                      <td>
                        <div className="w-row">
                          {admin && (
                            <WorkForm action={setRoleAction} submit={m.role === "admin" ? "Make member" : "Make admin"} inline>
                              <input type="hidden" name="organization_id" value={id} />
                              <input type="hidden" name="account_id" value={m.account_id} />
                              <input type="hidden" name="role" value={m.role === "admin" ? "member" : "admin"} />
                            </WorkForm>
                          )}
                          {admin && (
                            <WorkForm action={removeMemberAction} submit="Remove" danger inline>
                              <input type="hidden" name="organization_id" value={id} />
                              <input type="hidden" name="account_id" value={m.account_id} />
                            </WorkForm>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Section>
          <Section title="Invitations" aside="Single use, for seven days">
            {invitations.length === 0 ? (
              <Empty>No invitations made.</Empty>
            ) : (
              <Table label="Invitations">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Made</th>
                    <th>State</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <tr key={i.id}>
                      <td>{i.role === "admin" ? "Admin" : "Member"}</td>
                      <td>
                        {shortDay(i.made_at)}
                        {i.made_by ? ` by ${i.made_by}` : ""}
                      </td>
                      <td>
                        {i.state === "open" && <Pill tone="info">Open until {shortDay(i.expires_at)}</Pill>}
                        {i.state === "accepted" && <Pill tone="ok">Accepted{i.accepted_by ? ` by ${i.accepted_by}` : ""}</Pill>}
                        {i.state === "cancelled" && <Pill>Cancelled</Pill>}
                        {i.state === "expired" && <Pill>Expired</Pill>}
                      </td>
                      <td>
                        {admin && i.state === "open" && (
                          <WorkForm action={cancelInvitationAction} submit="Cancel" inline>
                            <input type="hidden" name="organization_id" value={id} />
                            <input type="hidden" name="invitation_id" value={i.id} />
                          </WorkForm>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
          <Section title="Leaving">
            <WorkForm action={removeMemberAction} submit={`Leave ${org.name}`} danger>
              <input type="hidden" name="organization_id" value={id} />
              <input type="hidden" name="account_id" value={myId ?? ""} />
              <input type="hidden" name="leaving" value="1" />
            </WorkForm>
          </Section>
          {admin && drawer === "invite" && (
            <Drawer title={`Invite to ${org.name}`} close={here("members")}>
              <p className="w-muted" style={{ marginTop: 0 }}>
                Make a link and send it however you like. The person opens it signed in as themselves and accepts. Nobody is added without
                accepting.
              </p>
              <WorkForm action={inviteAction} submit="Make link" primary lock="Shown once">
                <input type="hidden" name="organization_id" value={id} />
                <div className="w-options" role="radiogroup" aria-label="Role">
                  <label className="w-option">
                    <input type="radio" name="role" value="member" defaultChecked />
                    <div>
                      <b>Member</b>
                      <span>Sees the organization, its members and its log.</span>
                    </div>
                  </label>
                  <label className="w-option">
                    <input type="radio" name="role" value="admin" />
                    <div>
                      <b>Admin</b>
                      <span>Also changes members and invitations, buys owls, and spends them for the organization.</span>
                    </div>
                  </label>
                </div>
              </WorkForm>
            </Drawer>
          )}
        </>
      )}

      {tab === "acts" && admin && (
        <>
          <Banner>
            You act as {org.name} here. The public record shows {org.name}; the organization&apos;s log shows you. Balance:{" "}
            {balance === undefined ? "unknown" : `${owls(balance)} public owls`}.
          </Banner>
          <Section title="Public mandates" aside={`Funded by ${org.name}`}>
            {mandates.length === 0 ? (
              <Empty>None yet. A mandate is opened in a conversation with the public Grantmaker.</Empty>
            ) : (
              <Table label="Mandates">
                <thead>
                  <tr>
                    <th>Mandate</th>
                    <th>State</th>
                    <th>Budget</th>
                    <th>Spent</th>
                    <th>Add owls</th>
                  </tr>
                </thead>
                <tbody>
                  {mandates.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <Link href={`/mandates/${g.id}`}>{g.name}</Link>
                      </td>
                      <td>
                        <Pill>{g.status}</Pill>
                      </td>
                      <td>{owls(g.budget_owls)}</td>
                      <td>{owls(g.spent_owls)}</td>
                      <td>
                        <WorkForm action={addToMandateAction} submit="Add" inline>
                          <input type="hidden" name="organization_id" value={id} />
                          <input type="hidden" name="mandate_id" value={g.id} />
                          <input className="w-input w-narrow" name="owls" inputMode="decimal" aria-label="Owls to add" required />
                        </WorkForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
          <Section title="Pay for a claim's assessment">
            <Card>
              <WorkForm action={fundClaimAction} submit={`Pay from ${org.name}`} primary>
                <input type="hidden" name="organization_id" value={id} />
                <div className="w-field">
                  <label htmlFor="fund-claim">Claim</label>
                  <input id="fund-claim" className="w-input" name="claim" required placeholder="The claim's address or id" />
                </div>
                <div className="w-field">
                  <label htmlFor="fund-owls">Owls</label>
                  <input id="fund-owls" className="w-input w-narrow" name="owls" inputMode="decimal" required />
                </div>
              </WorkForm>
            </Card>
          </Section>
          <p className="w-muted">
            Contributing, proposing nodes and publishing pages are not offered here: they are a connected deployment&apos;s work, under its
            grants. No key, token or Assistant card acts as {org.name}; only an admin in a session.
          </p>
        </>
      )}

      {tab === "billing" && admin && (
        <>
          <Stats>
            <Stat k="Public owls" v={balance === undefined ? "—" : owls(balance)} />
          </Stats>
          <Section title="Buy owls" aside={`For ${org.name}, paid by you through Stripe`}>
            <div className="w-row" style={{ flexWrap: "wrap", gap: 8 }}>
              {(account?.packs ?? ([] as OwlPack[])).map((p) => (
                <WorkForm key={p.id} action={buyOwlsAction} submit={`${owls(p.owls)} owls · ${(p.price_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`} inline>
                  <input type="hidden" name="organization_id" value={id} />
                  <input type="hidden" name="pack_id" value={p.id} />
                </WorkForm>
              ))}
            </div>
          </Section>
          <Section title="Owl history">
            {ledger.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <Table label="Owl history">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>Owls</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((e) => (
                    <tr key={e.id}>
                      <td>{shortWhen(e.created_at)}</td>
                      <td>{e.reason.replace(/_/g, " ")}</td>
                      <td>{owls(e.amount_micro_usd / 1_000_000)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        </>
      )}

      {tab === "log" && (
        <Section title="Log" aside={`Readable by members of ${org.name} only`}>
          <LogTable log={log} names={names} />
        </Section>
      )}
    </WorkPage>
  );
}

function LogTable({ log, names }: { log: LogEntry[]; names: Map<string, string> }) {
  if (log.length === 0) return <Empty>Nothing yet.</Empty>;
  return (
    <Table label="Log">
      <thead>
        <tr>
          <th>When</th>
          <th>Who</th>
          <th>What</th>
        </tr>
      </thead>
      <tbody>
        {log.map((e) => (
          <tr key={e.id}>
            <td>{shortWhen(e.at)}</td>
            <td>{e.credential === "operator" ? "The operator key" : e.actor?.display_name ?? "A removed account"}</td>
            <td>{logLine(e, names)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
