import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { AccountApiError, fetchAccount, type GrantView, type OwlLedgerEntry, type OwlPack } from "../../../../lib/account-api";
import {
  getOrganization,
  listDeployments,
  listInvitations,
  listLog,
  listMembers,
  listOldKeys,
  listOrganizationCredentials,
  listOrganizationGrants,
  organizationAccount,
  organizationLedger,
  organizationMandates,
  type CredentialRow,
  type DeploymentView,
  type GrantRow,
  type InvitationView,
  type LogEntry,
  type MemberView,
  type OldKeyView,
  type OrganizationView,
} from "../../../../lib/organizations-api";
import {
  DEPLOYMENT_GRANTS,
  MEMBER_PERMISSIONS,
  PERMISSION_WORDS,
  type OrganizationPermission,
} from "../../../../lib/organization-permissions";
import { actingOrganization } from "../../../../lib/acting-as";
import { dateish, owls } from "../../../../lib/account-format";
import { ActionForm } from "../../../../components/admin/ActionForm";
import { MastheadHeight } from "@/components/MastheadHeight";
import { PageHead } from "@/components/PageHead";
import { switchActingAction } from "../../acting-actions";
import {
  buyOwlsAction,
  cancelInvitationAction,
  grantAction,
  inviteAction,
  removeMemberAction,
  revokeCredentialAction,
  setAllowanceAction,
  renameAction,
  revokeOldKeyAction,
  setRoleAction,
  withdrawGrantAction,
} from "../actions";

export const metadata: Metadata = { title: "Organization · Minerval" };
export const dynamic = "force-dynamic";

// One organization (docs/organizations.md, "The organization's pages"): for
// running it, drawn as the rest of the account is. Who is in it, what each
// member and deployment may do as it, its deployments, its money and its
// record. Acting as it on the public graph is done on the public graph's own
// pages, after switching to it (lib/acting-as.ts); nothing here acts there.

type Tab = "overview" | "members" | "deployments" | "activity" | "billing" | "log";
const TABS: Tab[] = ["overview", "members", "deployments", "activity", "billing", "log"];
const TAB_WORDS: Record<Tab, string> = {
  overview: "Overview",
  members: "Members",
  deployments: "Deployments",
  activity: "Activity",
  billing: "Billing",
  log: "Log",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How an act in the organization's name was made, as its log says (docs/organizations.md, "The record"). */
const HOW: Record<string, string> = {
  page: " on minerval.ai",
  assistant: " through the Assistant",
  api_key: " with an API key",
  mcp_client: " through an MCP client",
};

/** A log entry in words. */
function logLine(e: LogEntry, names: Map<string, string>, deployments: Map<string, string>): string {
  const who = (id: unknown) => (typeof id === "string" ? names.get(id) ?? "someone" : "someone");
  const grantee = (d: Record<string, unknown>) =>
    typeof d.deployment_id === "string" ? `the deployment ${deployments.get(d.deployment_id) ?? ""}`.trim() : who(d.account_id);
  const d = e.detail;
  switch (e.kind) {
    case "created":
      return "made the organization";
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
    case "granted":
      return `gave ${grantee(d)} ${String(d.permission)}`;
    case "withdrew":
      return `withdrew ${String(d.permission)} from ${grantee(d)}`;
    case "grants_withdrawn":
      return `withdrew what ${who(d.account_id)} held (${Array.isArray(d.permissions) ? (d.permissions as string[]).join(", ") : ""})`;
    case "admin_added_by_operator":
      return `made ${who(d.account_id)} an admin, with the operator key`;
    case "converted":
      return "accepted, as first admin, that the shared account becomes this organization";
    case "old_key_revoked":
      return `revoked the old key ${String(d.key_prefix)}…`;
    case "deployment_approved":
      return `approved the deployment ${String(d.name)}, with ${Array.isArray(d.grants) ? (d.grants as string[]).join(", ") : "its grants"}`;
    case "deployment_disconnected":
      return `the deployment ${String(d.name)} disconnected`;
    case "acted":
      return `acted as the organization${HOW[String(d.how)] ?? ""}: ${String(d.method)} ${String(d.route)} (${String(d.status)})`;
    case "credential_revoked":
      return `revoked ${who(d.account_id)}'s ${d.kind === "mcp_client" ? "MCP client" : "API key"} for the organization`;
    case "credentials_revoked":
      return `revoked what ${who(d.account_id)} had made to act as the organization, as they left`;
    default:
      return e.kind.replace(/_/g, " ");
  }
}

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: askedTab } = await searchParams;
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
  const mine = org.permissions ?? [];
  const mayBuy = admin || mine.includes("buy");
  const mayAct = admin || mine.length > 0;
  const tabs = TABS.filter((t) => t !== "billing" || mayBuy);
  const tab: Tab = (tabs as string[]).includes(askedTab ?? "") ? (askedTab as Tab) : "overview";
  const base = `/account/organizations/${id}`;
  const here = (t: Tab) => (t === "overview" ? base : `${base}?tab=${t}`);

  const [myId, members, invitations, oldKeys, deployments, log, account, acting] = await Promise.all([
    fetchAccount(me).then((a) => a.user.id, () => null),
    listMembers(me, id).catch(() => [] as MemberView[]),
    listInvitations(me, id).catch(() => [] as InvitationView[]),
    listOldKeys(me, id).catch(() => [] as OldKeyView[]),
    listDeployments(me, id).catch(() => [] as DeploymentView[]),
    tab === "log" || tab === "overview" || tab === "activity"
      ? listLog(me, id, tab === "overview" ? 6 : 200).catch(() => [] as LogEntry[])
      : Promise.resolve([] as LogEntry[]),
    organizationAccount(me, id).catch(() => null),
    actingOrganization(),
  ]);
  const [mandates, ledger, grants] = await Promise.all([
    tab === "activity" || tab === "overview" ? organizationMandates(me, id).catch(() => [] as GrantView[]) : Promise.resolve([] as GrantView[]),
    tab === "billing" && admin ? organizationLedger(me, id, 100).catch(() => [] as OwlLedgerEntry[]) : Promise.resolve([] as OwlLedgerEntry[]),
    tab === "deployments" ? listOrganizationGrants(me, id).catch(() => [] as GrantRow[]) : Promise.resolve([] as GrantRow[]),
  ]);
  const credentials = tab === "members" ? await listOrganizationCredentials(me, id).catch(() => [] as CredentialRow[]) : [];

  const live = deployments.filter((d) => !d.retired_at);
  const names = new Map(members.map((m) => [m.account_id, m.display_name]));
  const deploymentNames = new Map(deployments.map((d) => [d.id, d.name]));
  const balance = account?.entitlement.owl_balance;
  const actingHere = acting?.id === id;
  const openInvitations = invitations.filter((i) => i.state === "open");

  return (
    <div className="account-home org-home">
      <MastheadHeight />
      <PageHead
        back={{ href: "/account/organizations", label: "Your organizations" }}
        kicker="Organization"
        title={org.name}
        actions={<Link href={`/contributors/${id}`}>public page</Link>}
        meta={
          <>
            You are {admin ? "an admin" : "a member"} · {plural(members.length, "member")} · {plural(live.length, "deployment")} connected · made{" "}
            {dateish(org.created_at)}
          </>
        }
      />

      <ActingAsBox org={org} mayAct={mayAct} actingHere={actingHere} admin={admin} />

      <nav className="acct-nav" aria-label="Organization">
        {tabs.map((t) => (
          <Link key={t} href={here(t)} aria-current={t === tab ? "page" : undefined} className={t === tab ? "org-tab-current" : undefined}>
            {TAB_WORDS[t]}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <>
          <section className="acct-figures" aria-label="Summary">
            <div className="acct-figure">
              <div className="sc">Balance</div>
              <p className="acct-figure-value">{balance === undefined ? "—" : `${owls(balance)} owls`}</p>
              <p className="acct-figure-note">The organization&rsquo;s own, apart from any member&rsquo;s.</p>
            </div>
            <div className="acct-figure">
              <div className="sc">Members</div>
              <p className="acct-figure-value">{members.length}</p>
              <p className="acct-figure-note">
                {plural(members.filter((m) => m.role === "admin").length, "admin")} · {plural(openInvitations.length, "invitation")} open
              </p>
            </div>
            <div className="acct-figure">
              <div className="sc">Deployments</div>
              <p className="acct-figure-value">{live.length}</p>
              <p className="acct-figure-note">{live.length ? "Connected, each under its own grants" : "None connected"}</p>
            </div>
            <div className="acct-figure">
              <div className="sc">Mandates</div>
              <p className="acct-figure-value">{mandates.length}</p>
              <p className="acct-figure-note">Funded in its name</p>
            </div>
          </section>

          <section className="acct-section">
            <div className="acct-head">
              <h2>What you may do as {org.name}</h2>
            </div>
            <PermissionList held={admin ? [...MEMBER_PERMISSIONS] : mine} all={[...MEMBER_PERMISSIONS]} />
            {org.allowance_left_micro_usd !== undefined && (
              <p className="acct-prose">
                An admin set an allowance on what you spend of its owls: {owls(org.allowance_left_micro_usd / 1_000_000)} owls are left. It
                does not renew; an admin raises it.
              </p>
            )}
            <p className="acct-note">
              {admin
                ? "As an admin you hold every permission a member can be given, and you give them to others on the Members tab."
                : "An admin gives these on the Members tab. What you do as the organization is on its log under your name."}
            </p>
          </section>

          {oldKeys.length > 0 && (
            <section className="acct-section">
              <div className="acct-head">
                <h2>Old keys still live</h2>
                <span className="acct-note">They can do anything the organization can. Revoke each once nothing uses it.</span>
              </div>
              {oldKeys.map((k) => (
                <div key={k.id} className="acct-line">
                  <div>
                    <code>{k.key_prefix}…</code> {k.name}
                    <span className="acct-detail">
                      made {dateish(k.created_at)} · {k.last_used_at ? `last used ${dateish(k.last_used_at)}` : "never used"}
                    </span>
                  </div>
                  {admin && (
                    <ActionForm action={revokeOldKeyAction} submit="Revoke" inline danger>
                      <input type="hidden" name="organization_id" value={id} />
                      <input type="hidden" name="key_id" value={k.id} />
                    </ActionForm>
                  )}
                </div>
              ))}
            </section>
          )}

          <section className="acct-section">
            <div className="acct-head">
              <h2>Recent</h2>
              <Link className="acct-note" href={here("log")}>
                The whole log →
              </Link>
            </div>
            <LogLines log={log} names={names} deployments={deploymentNames} />
          </section>

          {admin && (
            <section className="acct-section">
              <div className="acct-head">
                <h2>Name</h2>
              </div>
              <ActionForm action={renameAction} submit="Rename">
                <input type="hidden" name="organization_id" value={id} />
                <label>
                  Name
                  <input name="name" defaultValue={org.name} required maxLength={120} />
                  <small>Public, and proves nothing on its own: two organizations can share a name.</small>
                </label>
              </ActionForm>
            </section>
          )}
        </>
      )}

      {tab === "members" && (
        <>
          <section className="acct-section">
            <div className="acct-head">
              <h2>Members</h2>
              <span className="acct-note">An organization always has an admin. An admin holds every permission.</span>
            </div>
            {members.map((m) => (
              <MemberLine
                key={m.account_id}
                m={m}
                self={m.account_id === myId}
                admin={admin}
                organizationId={id}
                credentials={credentials.filter((c) => c.account_id === m.account_id)}
              />
            ))}
          </section>

          <section className="acct-section">
            <div className="acct-head">
              <h2>Invitations</h2>
              <span className="acct-note">A link for one person, open for seven days</span>
            </div>
            {invitations.length === 0 ? (
              <p className="acct-prose acct-quiet">No invitations made.</p>
            ) : (
              invitations.map((i) => (
                <div key={i.id} className="acct-line">
                  <div>
                    As {i.role}
                    <span className="acct-detail">
                      made {dateish(i.made_at)}
                      {i.made_by ? ` by ${i.made_by}` : ""} ·{" "}
                      {i.state === "open"
                        ? `open until ${dateish(i.expires_at)}`
                        : i.state === "accepted"
                          ? `accepted${i.accepted_by ? ` by ${i.accepted_by}` : ""}`
                          : i.state}
                    </span>
                  </div>
                  {admin && i.state === "open" && (
                    <ActionForm action={cancelInvitationAction} submit="Cancel" inline>
                      <input type="hidden" name="organization_id" value={id} />
                      <input type="hidden" name="invitation_id" value={i.id} />
                    </ActionForm>
                  )}
                </div>
              ))
            )}
            {admin && (
              <ActionForm action={inviteAction} submit="Make an invitation link">
                <input type="hidden" name="organization_id" value={id} />
                <fieldset className="admin-fieldset">
                  <legend>Invite someone as</legend>
                  <label className="admin-check">
                    <input type="radio" name="role" value="member" defaultChecked /> a member, who reads everything here and does as the organization
                    what you then give them
                  </label>
                  <label className="admin-check">
                    <input type="radio" name="role" value="admin" /> an admin, who also runs the organization and holds every permission
                  </label>
                </fieldset>
                <small className="acct-note">The link is shown once. The person opens it signed in as themselves and accepts.</small>
              </ActionForm>
            )}
          </section>

          <section className="acct-section">
            <div className="acct-head">
              <h2>Leaving</h2>
            </div>
            <ActionForm action={removeMemberAction} submit={`Leave ${org.name}`} danger inline>
              <input type="hidden" name="organization_id" value={id} />
              <input type="hidden" name="account_id" value={myId ?? ""} />
              <input type="hidden" name="leaving" value="1" />
            </ActionForm>
          </section>
        </>
      )}

      {tab === "deployments" && (
        <>
          <section className="acct-section">
            <div className="acct-head">
              <h2>Deployments</h2>
              <span className="acct-note">Private deployments that act as the organization with their own keys, each under its own grants</span>
            </div>
            {deployments.length === 0 ? (
              <div className="acct-prose acct-measure">
                <p>
                  None connected. A private deployment holds the organization&rsquo;s own material and its private graph, publishes
                  through its gate, and follows the public graph.
                </p>
                <p>
                  To connect one, an administrator of it presses <b>Connect to minerval.ai</b> on its Public graph overview, and an
                  admin here approves. To run one, see <Link href="/docs/self-hosting">running a deployment</Link>.
                </p>
              </div>
            ) : (
              deployments.map((d) => (
                <DeploymentBlock key={d.id} d={d} grants={grants.filter((g) => g.deployment_id === d.id)} admin={admin} organizationId={id} />
              ))
            )}
          </section>
        </>
      )}

      {tab === "activity" && (
        <Activity org={org} mandates={mandates} log={log} deployments={live} names={names} />
      )}

      {tab === "billing" && mayBuy && (
        <>
          <section className="acct-section">
            <div className="acct-head">
              <h2>Buy owls for {org.name}</h2>
              <span className="acct-note">Paid by you, through Stripe; they go to the organization&rsquo;s balance, not yours</span>
            </div>
            <div className="org-packs">
              {(account?.packs ?? ([] as OwlPack[])).map((p) => (
                <ActionForm
                  key={p.id}
                  action={buyOwlsAction}
                  submit={`${owls(p.owls)} owls · ${(p.price_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`}
                >
                  <input type="hidden" name="organization_id" value={id} />
                  <input type="hidden" name="pack_id" value={p.id} />
                </ActionForm>
              ))}
            </div>
          </section>
          {admin && (
            <section className="acct-section">
              <div className="acct-head">
                <h2>Owl history</h2>
                <span className="acct-note">Balance {balance === undefined ? "—" : `${owls(balance)} owls`}</span>
              </div>
              {ledger.length === 0 ? (
                <p className="acct-prose acct-quiet">Nothing yet.</p>
              ) : (
                ledger.map((e) => (
                  <div key={e.id} className="acct-line">
                    <div>
                      {e.reason.replace(/_/g, " ")}
                      <span className="acct-detail">{dateish(e.created_at)}</span>
                    </div>
                    <span className="acct-amount">{owls(e.amount_micro_usd / 1_000_000)}</span>
                  </div>
                ))
              )}
            </section>
          )}
        </>
      )}

      {tab === "log" && (
        <section className="acct-section">
          <div className="acct-head">
            <h2>Log</h2>
            <span className="acct-note">Every change and every act in its name. Read by members of {org.name} only.</span>
          </div>
          <LogLines log={log} names={names} deployments={deploymentNames} />
        </section>
      )}
    </div>
  );
}

/** The switch, on the organization's own page: act as it, or back as yourself. */
function ActingAsBox({ org, mayAct, actingHere, admin }: { org: OrganizationView; mayAct: boolean; actingHere: boolean; admin: boolean }) {
  if (!mayAct) {
    return (
      <p className="acct-prose acct-measure org-acting">
        You hold no permission to act as {org.name} on the public graph. An admin can give you some on the Members tab.
      </p>
    );
  }
  return (
    <form action={switchActingAction} className={`org-acting${actingHere ? " org-acting-on" : ""}`}>
      <input type="hidden" name="organization_id" value={actingHere ? "" : org.id} />
      <input type="hidden" name="return_to" value={`/account/organizations/${org.id}`} />
      <p>
        {actingHere ? (
          <>
            You are acting as <b>{org.name}</b>. Every page of the public graph works as it, with what you may do as it, and the header
            says so on every page.
          </>
        ) : (
          <>
            Act as {org.name} on the public graph, with the same pages you use as yourself: contributing, funding, mandates, requests and
            the rest, {admin ? "with every permission" : "with what you have been given"}. The public record shows {org.name}; its log
            shows you.
          </>
        )}
      </p>
      <button type="submit" className="order-button">
        {actingHere ? "Act as yourself again" : `Act as ${org.name}`}
      </button>
    </form>
  );
}

function PermissionList({ held, all }: { held: readonly OrganizationPermission[]; all: readonly OrganizationPermission[] }) {
  return (
    <ul className="org-permissions">
      {all.map((p) => (
        <li key={p} className={held.includes(p) ? "org-held" : "org-not-held"}>
          <code>{p}</code> <span>{PERMISSION_WORDS[p]}</span>
          <span className="acct-status">{held.includes(p) ? "yours" : "not given"}</span>
        </li>
      ))}
    </ul>
  );
}

function MemberLine({
  m,
  self,
  admin,
  organizationId,
  credentials,
}: {
  m: MemberView;
  self: boolean;
  admin: boolean;
  organizationId: string;
  credentials: CredentialRow[];
}) {
  const missing = MEMBER_PERMISSIONS.filter((p) => !m.permissions.includes(p));
  return (
    <div className="acct-line org-member">
      <div>
        <Link href={`/contributors/${m.account_id}`}>{m.display_name}</Link>
        {self && <span className="acct-detail">(you)</span>}
        <span className="acct-detail">
          {m.role === "admin" ? "admin" : "member"} · added {dateish(m.added_at)}
          {m.added_by ? ` by ${m.added_by}` : ""}
        </span>
        <div className="acct-line-under org-grants">
          {m.role === "admin" ? (
            <span className="acct-note">Holds every permission.</span>
          ) : m.grants.length === 0 ? (
            <span className="acct-note">May not act as the organization yet.</span>
          ) : (
            <GrantChips grants={m.grants} admin={admin} organizationId={organizationId} />
          )}
          {admin && m.role !== "admin" && missing.length > 0 && (
            <GiveForm organizationId={organizationId} field="account_id" grantee={m.account_id} choices={missing} />
          )}
          {credentials.length > 0 && (
            <ul className="admin-grants org-grant-list">
              {credentials.map((c) => (
                <li key={`${c.kind}:${c.id}`}>
                  {c.kind === "api_key" ? "API key" : "MCP client"} <b>{c.name}</b>
                  <span className="acct-detail">
                    acts as the organization · made {dateish(c.made_at)} · {c.last_used_at ? `last used ${dateish(c.last_used_at)}` : "never used"}
                  </span>
                  {(admin || self) && (
                    <ActionForm action={revokeCredentialAction} submit="revoke" inline danger>
                      <input type="hidden" name="organization_id" value={organizationId} />
                      <input type="hidden" name="kind" value={c.kind} />
                      <input type="hidden" name="credential_id" value={c.id} />
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {admin && (
        <div className="org-member-acts">
          <ActionForm action={setRoleAction} submit={m.role === "admin" ? "make member" : "make admin"} inline>
            <input type="hidden" name="organization_id" value={organizationId} />
            <input type="hidden" name="account_id" value={m.account_id} />
            <input type="hidden" name="role" value={m.role === "admin" ? "member" : "admin"} />
          </ActionForm>
          {!self && (
            <ActionForm action={removeMemberAction} submit="remove" inline danger>
              <input type="hidden" name="organization_id" value={organizationId} />
              <input type="hidden" name="account_id" value={m.account_id} />
            </ActionForm>
          )}
        </div>
      )}
    </div>
  );
}

function GrantChips({ grants, admin, organizationId }: { grants: GrantRow[]; admin: boolean; organizationId: string }) {
  return (
    <ul className="admin-grants org-grant-list">
      {grants.map((g) => (
        <li key={g.id}>
          <code title={PERMISSION_WORDS[g.permission]}>{g.permission}</code>
          <span className="acct-detail">
            given {dateish(g.granted_at)}
            {g.granted_by ? ` by ${g.granted_by}` : ""}
          </span>
          {g.permission === "spend" && (
            <span className="acct-detail">
              {g.allowance_micro_usd === null
                ? "no allowance: the whole balance"
                : `allowance ${owls(Math.max(0, g.allowance_micro_usd - g.allowance_spent_micro_usd) / 1_000_000)} left of ${owls(g.allowance_micro_usd / 1_000_000)}`}
            </span>
          )}
          {admin && (
            <ActionForm action={withdrawGrantAction} submit="withdraw" inline danger>
              <input type="hidden" name="organization_id" value={organizationId} />
              <input type="hidden" name="grant_id" value={g.id} />
            </ActionForm>
          )}
          {admin && g.permission === "spend" && (
            <ActionForm action={setAllowanceAction} submit="Set allowance">
              <input type="hidden" name="organization_id" value={organizationId} />
              <input type="hidden" name="grant_id" value={g.id} />
              <label>
                Owls it may spend in all, counting {owls(g.allowance_spent_micro_usd / 1_000_000)} spent
                <input
                  name="allowance_owls"
                  inputMode="decimal"
                  defaultValue={g.allowance_micro_usd === null ? "" : String(g.allowance_micro_usd / 1_000_000)}
                  placeholder="blank: the whole balance"
                />
                <small>It has no period; raise it to let them spend more.</small>
              </label>
            </ActionForm>
          )}
        </li>
      ))}
    </ul>
  );
}

function GiveForm({
  organizationId,
  field,
  grantee,
  choices,
}: {
  organizationId: string;
  field: "account_id" | "deployment_id";
  grantee: string;
  choices: readonly OrganizationPermission[];
}) {
  return (
    <ActionForm action={grantAction} submit="Give">
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name={field} value={grantee} />
      <label>
        Give a permission
        <select name="permission" defaultValue={choices[0]}>
          {choices.map((p) => (
            <option key={p} value={p} title={PERMISSION_WORDS[p]}>
              {p}
            </option>
          ))}
        </select>
      </label>
    </ActionForm>
  );
}

function DeploymentBlock({
  d,
  grants,
  admin,
  organizationId,
}: {
  d: DeploymentView;
  grants: GrantRow[];
  admin: boolean;
  organizationId: string;
}) {
  const missing = DEPLOYMENT_GRANTS.filter((g) => !d.grants.includes(g));
  return (
    <div className="acct-job org-deployment">
      <div className="acct-job-head">
        <div>
          <b>{d.name}</b>
          <span className="acct-detail">
            {d.hosting_words} (its statement) · key <code>{d.key_id.slice(0, 8)}</code>
          </span>
        </div>
        <span className="acct-status">{d.retired_at ? `retired ${dateish(d.retired_at)}` : d.last_write_at ? `last wrote ${dateish(d.last_write_at)}` : "connected"}</span>
      </div>
      <p className="acct-note">
        Approved {dateish(d.approved_at)}
        {d.approved_by ? ` by ${d.approved_by}` : ""}.
      </p>
      {!d.retired_at && (
        <>
          {grants.length === 0 ? (
            <p className="acct-note">Holds no grant: it can do nothing on the public graph.</p>
          ) : (
            <GrantChips grants={grants} admin={admin} organizationId={organizationId} />
          )}
          {admin && missing.length > 0 && <GiveForm organizationId={organizationId} field="deployment_id" grantee={d.id} choices={missing} />}
          {d.recent_writes.length > 0 && (
            <details className="acct-asTable">
              <summary>{plural(d.recent_writes.length, "recent write")} · reads are not recorded</summary>
              {d.recent_writes.slice(0, 30).map((w, i) => (
                <div key={i} className="acct-line">
                  <div>
                    <code>
                      {w.method} {w.route}
                    </code>
                    <span className="acct-detail">{dateish(w.at)}</span>
                  </div>
                  <span className="acct-status">{w.status}</span>
                </div>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Activity({
  org,
  mandates,
  log,
  deployments,
  names,
}: {
  org: OrganizationView;
  mandates: GrantView[];
  log: LogEntry[];
  deployments: DeploymentView[];
  names: Map<string, string>;
}) {
  const acts = [
    ...log
      .filter((e) => e.kind === "acted")
      .map((e) => ({
        at: e.at,
        what: `${String(e.detail.method)} ${String(e.detail.route)}`,
        status: Number(e.detail.status),
        by: e.actor?.display_name ?? names.get(e.actor?.id ?? "") ?? "a former member",
        how: HOW[String(e.detail.how)]?.trim() ?? "on minerval.ai",
      })),
    ...deployments.flatMap((d) =>
      d.recent_writes.map((w) => ({ at: w.at, what: `${w.method} ${w.route}`, status: w.status, by: d.name, how: "through its deployment" }))
    ),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <>
      <section className="acct-section">
        <div className="acct-head">
          <h2>Mandates in its name</h2>
          <span className="acct-note">Funded by {org.name}</span>
        </div>
        {mandates.length === 0 ? (
          <p className="acct-prose acct-quiet">None yet. Act as {org.name} and open one in conversation with the Grantmaker, from Ask.</p>
        ) : (
          mandates.map((g) => (
            <div key={g.id} className="acct-line">
              <div>
                <Link href={`/mandates/${g.id}`}>{g.name}</Link>
                <span className="acct-detail">{g.status.replace(/_/g, " ")}</span>
              </div>
              <span className="acct-amount">
                {owls(g.spent_owls)} of {owls(g.budget_owls)} owls
              </span>
            </div>
          ))
        )}
      </section>
      <section className="acct-section">
        <div className="acct-head">
          <h2>Done in its name</h2>
          <span className="acct-note">By its members on minerval.ai and by its deployments, newest first</span>
        </div>
        {acts.length === 0 ? (
          <p className="acct-prose acct-quiet">Nothing yet.</p>
        ) : (
          acts.slice(0, 100).map((a, i) => (
            <div key={i} className="acct-line">
              <div>
                <code>{a.what}</code>
                <span className="acct-detail">
                  {a.by}, {a.how} · {dateish(a.at)}
                </span>
              </div>
              <span className={`acct-status${a.status >= 400 ? " acct-status-rejected" : ""}`}>{a.status < 400 ? "done" : `refused (${a.status})`}</span>
            </div>
          ))
        )}
      </section>
    </>
  );
}

function LogLines({ log, names, deployments }: { log: LogEntry[]; names: Map<string, string>; deployments: Map<string, string> }) {
  if (log.length === 0) return <p className="acct-prose acct-quiet">Nothing yet.</p>;
  return (
    <>
      {log.map((e) => (
        <div key={e.id} className="acct-line">
          <div>
            {e.credential === "operator" ? "The operator key" : e.actor?.display_name ?? "A removed account"} {logLine(e, names, deployments)}
          </div>
          <span className="acct-detail">{dateish(e.at)}</span>
        </div>
      ))}
    </>
  );
}
