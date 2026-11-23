import { isOwnLabel, layersOf } from "@/lib/label-layers";
import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { Icon } from "@/components/work/icons";
import {
  Banner,
  ButtonLink,
  Drawer,
  Empty,
  Lbl,
  Party,
  Pill,
  Section,
  Table,
  Tabs,
  Tip,
  WorkHead,
  WorkPage,
  age,
  plural,
  shortDay,
} from "@/components/work/ui";
import {
  fetchAccounts,
  fetchGrants,
  fetchLabels,
  fetchParties,
  fetchPermissionDefinitions,
  fetchPermissionLog,
  type AccountView,
  type GrantView,
  type LabelView,
  type PartyView,
  type PermissionDefinition,
} from "@/lib/admin-api";
import { capitalised, holdersText, logSentence, permissionName, permissionShort } from "@/lib/admin-words";
import { GrantForm, type GrantChoices } from "./GrantForm";
import { RemoveGrant } from "./RemoveGrant";

export const metadata: Metadata = { title: "People · Minerval" };
export const dynamic = "force-dynamic";

// Who may do what in this deployment. Every member may read what each
// permission covers and what they hold themselves; who holds what across the
// deployment, and granting and removing, are for holders of the permission
// to administer. Every grant and removal is in the Activity log
// (app/admin/activity), which every member may read.

type Params = { tab?: string; drawer?: string; account?: string; q?: string; perm?: string };

/** The deployment's own account, which nobody signs in to, is not a person to grant to. */
const isPerson = (account: AccountView) => !account.external_id?.startsWith("platform:");

/** A grant in a word or two, its scope beside it: "Read · finance", "Consent · Acme". */
function GrantChip({
  grant,
  group,
  remove,
}: {
  grant: { permission: string; label?: string | null; party?: { name: string } | null };
  /** Held through this group: drawn dashed, and removed on the group. */
  group?: string | null;
  remove?: string;
}) {
  const what = grantWords(grant);
  return (
    <span
      className={group ? "w-chip w-dashed" : "w-chip"}
      title={group ? `Through the group ${group}. Removed on the group, not here.` : permissionName(grant.permission)}
    >
      {permissionShort(grant.permission)}
      {grant.label && (
        <>
          <span className="w-faint">·</span>
          <Lbl name={grant.label} />
        </>
      )}
      {grant.party && (
        <>
          <span className="w-faint">·</span>
          <Party name={grant.party.name} />
        </>
      )}
      {remove && <RemoveGrant grantId={remove} what={what} />}
    </span>
  );
}

function grantWords(g: { permission: string; label?: string | null; party?: { name: string } | null }): string {
  return [permissionShort(g.permission), g.label ?? g.party?.name].filter(Boolean).join(" · ");
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ""))).toUpperCase() || "?";
}

function lastActive(iso: string | null | undefined): string {
  if (!iso) return "—";
  const minutes = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (minutes < 5) return "now";
  if (minutes < 24 * 60) return `${age(iso)} ago`;
  return shortDay(iso);
}

function Person({ account, you }: { account: AccountView; you: boolean }) {
  return (
    <div className="w-row" style={{ flexWrap: "nowrap", gap: 10 }}>
      <span className="w-avatar" aria-hidden>
        {initials(account.display_name)}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="w-row" style={{ gap: 6 }}>
          <span style={{ color: "var(--w-ink)", fontWeight: 500 }}>{account.display_name}</span>
          {you && <Pill>you</Pill>}
        </div>
        <div className="w-faint w-small" title={account.external_id ?? "no sign-in identity"}>
          {account.email ?? account.external_id ?? "no sign-in identity"}
        </div>
      </div>
    </div>
  );
}

/** A short line for each permission, for the grant form; the API's own sentence is on the Permissions tab. */
const BLURBS: Record<string, string> = {
  direct: "Open mandates, add sources, release pages outside",
  consent: "Consent at a gate to what rests on one party's material going out",
  fund: "Put owls behind mandates, jobs and requests",
  read: "Read what agents wrote at one label, and the labels it reads",
  read_sources: "Open the sources themselves, at one label only",
  administer: "Grant permissions, define labels and parties, connect systems",
  clear_providers: "Choose which providers may be sent a label's text",
};

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Params> }) {
  const who = await viewer();
  if (!who) return null;
  const params = await searchParams;
  const administers = can(who, "administer");

  const [definitions, recent] = await Promise.all([
    fetchPermissionDefinitions(who.externalId).catch(() => [] as PermissionDefinition[]),
    fetchPermissionLog(who.externalId, 3).catch(() => []),
  ]);

  const permissionsTable = (heldBy?: (permission: string) => string) => (
    <Table label="What each permission covers">
      <thead>
        <tr>
          <th>Permission</th>
          <th>Lets its holder</th>
          <th>Never lets anyone</th>
          {heldBy && <th>Held by</th>}
        </tr>
      </thead>
      <tbody>
        {definitions.map((d) => (
          <tr key={d.name}>
            <td className="w-top" style={{ minWidth: 170 }}>
              <div style={{ fontWeight: 500, color: "var(--w-ink)" }}>{permissionName(d.name)}</div>
              {d.scope !== "none" && (
                <div className="w-faint w-small">{d.scope === "label" ? "at one label" : "for one party"}</div>
              )}
            </td>
            <td className="w-top w-small">{d.covers}</td>
            <td className="w-top w-small w-muted">{d.never}</td>
            {heldBy && <td className="w-top w-small" style={{ whiteSpace: "nowrap" }}>{heldBy(d.name)}</td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );

  const recentCard = recent.length > 0 && (
    <Section
      title="Recent"
      actions={
        <Link className="w-small" href="/admin/activity?type=Access">
          Activity log →
        </Link>
      }
    >
      <div className="w-card w-card-b">
        {recent.map((entry, i) => (
          <div className="w-line" key={i} style={{ gridTemplateColumns: "92px minmax(0, 1fr)" }}>
            <time dateTime={entry.at}>{shortDay(entry.at)} {entry.at.slice(11, 16)}</time>
            <span>{logSentence(entry)}</span>
          </div>
        ))}
      </div>
    </Section>
  );

  // A member who does not administer: what they hold, and what each permission covers.
  if (!administers) {
    return (
      <WorkPage>
        <WorkHead
          title="People"
          sub="What you hold, and what each permission covers"
          actions={
            <ButtonLink href="/admin/activity" icon="log">
              Activity log
            </ButtonLink>
          }
        />
        <Section
          title="What you hold"
          aside={
            <Tip>Who holds what across the deployment, and granting and removing, need the permission to administer. An administrator grants it.</Tip>
          }
        >
          <div className="w-card w-card-b">
            {who.mine.grants.length === 0 ? (
              <span className="w-muted">Nothing yet. An administrator grants permissions.</span>
            ) : (
              <div className="w-row" style={{ gap: 6 }}>
                {who.mine.grants.map((g, i) => (
                  <GrantChip key={i} grant={g} group={g.through_group} />
                ))}
              </div>
            )}
          </div>
        </Section>
        <Section title="Permissions" aside={definitions.length}>
          {permissionsTable()}
        </Section>
        {recentCard}
      </WorkPage>
    );
  }

  let grants: GrantView[];
  let accounts: AccountView[];
  let labels: LabelView[];
  let parties: PartyView[];
  try {
    [grants, accounts, labels, parties] = await Promise.all([
      fetchGrants(who.externalId),
      fetchAccounts(who.externalId),
      fetchLabels(who.externalId),
      fetchParties(who.externalId),
    ]);
  } catch {
    return (
      <WorkPage>
        <WorkHead title="People" />
        <Banner tone="bad">Who holds what could not be read just now. Try again in a moment.</Banner>
      </WorkPage>
    );
  }
  accounts = accounts.filter(isPerson);

  const groupGrants = grants.filter((g) => g.group !== null);
  const groupNames = [...new Set(groupGrants.map((g) => g.group!))].sort();
  const directGrants = (a: AccountView) => grants.filter((g) => g.account?.id === a.id);
  const throughGroups = (a: AccountView) => groupGrants.filter((g) => a.groups.some((m) => m.current && m.name === g.group));
  const holds = (a: AccountView) => directGrants(a).length + throughGroups(a).length > 0;
  const members = accounts.filter(holds);
  const holdingNothing = accounts.filter((a) => !holds(a));
  const heldBy = (permission: string) => {
    const held = grants.filter((g) => g.permission === permission);
    return capitalised(
      holdersText({
        accounts: new Set(held.filter((g) => g.account).map((g) => g.account!.id)).size,
        groups: new Set(held.filter((g) => g.group !== null).map((g) => g.group)).size,
      }),
    );
  };

  const tab = ["members", "groups", "none", "permissions"].includes(params.tab ?? "") ? params.tab! : "members";
  const q = (params.q ?? "").trim().toLowerCase();
  const perm = definitions.some((d) => d.name === params.perm) ? params.perm! : "";
  const shownMembers = members.filter(
    (a) =>
      (!q || `${a.display_name} ${a.email ?? ""} ${a.external_id ?? ""}`.toLowerCase().includes(q)) &&
      (!perm || [...directGrants(a), ...throughGroups(a)].some((g) => g.permission === perm)),
  );

  const here = (over: Partial<Params>) => {
    const next = new URLSearchParams();
    const merged: Params = { tab: tab === "members" ? undefined : tab, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const s = next.toString();
    return s ? `/admin/people?${s}` : "/admin/people";
  };
  const closeDrawer = here({ q: params.q, perm: params.perm });

  const layers = layersOf(who.mine);
  const choices: GrantChoices = {
    permissions: definitions.map((d) => ({
      name: d.name,
      title: permissionName(d.name),
      blurb: BLURBS[d.name] ?? d.covers,
      scope: d.scope,
    })),
    people: accounts.map((a) => ({
      id: a.id,
      name: a.display_name,
      email: a.email,
      holds: [...directGrants(a), ...throughGroups(a)].map(grantWords).join(", "),
    })),
    // The labels a person is granted: not the ones every member reads without a grant.
    labels: labels.filter((l) => isOwnLabel(l.name, layers)).map((l) => l.name),
    parties: parties.map((p) => ({ id: p.id, name: p.name })),
  };

  return (
    <WorkPage>
      <WorkHead
        title="People"
        sub={[
          plural(members.length, "member"),
          plural(groupNames.length, "group"),
          ...(holdingNothing.length > 0 ? [`${holdingNothing.length} signed in without access`] : []),
        ].join(" · ")}
        actions={
          <>
            <ButtonLink href="/admin/activity?type=Access" icon="log">
              Activity log
            </ButtonLink>
            <ButtonLink href={here({ drawer: "grant", q: params.q, perm: params.perm })} primary icon="plus">
              Grant access
            </ButtonLink>
          </>
        }
      />

      <Tabs
        current={tab}
        tabs={[
          { key: "members", label: "Members", href: "/admin/people", count: members.length },
          { key: "groups", label: "Groups", href: "/admin/people?tab=groups", count: groupNames.length },
          { key: "none", label: "No access", href: "/admin/people?tab=none", count: holdingNothing.length },
          { key: "permissions", label: "Permissions", href: "/admin/people?tab=permissions", count: definitions.length },
        ]}
      />

      {tab === "members" && (
        <>
          <form className="w-toolbar" action="/admin/people" method="get">
            <label className="w-search" style={{ width: 240 }}>
              <Icon name="search" size={14} />
              <input type="search" name="q" defaultValue={params.q ?? ""} placeholder="Filter people" aria-label="Filter people" />
            </label>
            <select className="w-select" name="perm" defaultValue={perm} aria-label="Permission" style={{ width: "auto" }}>
              <option value="">Any permission</option>
              {definitions.map((d) => (
                <option key={d.name} value={d.name}>
                  {permissionShort(d.name)}
                </option>
              ))}
            </select>
            <button className="w-btn w-sm" type="submit">
              Filter
            </button>
            {(q || perm) && (
              <Link className="w-small" href="/admin/people">
                Clear
              </Link>
            )}
            <span className="w-muted w-small w-spacer w-row" style={{ gap: 6 }}>
              <span className="w-chip w-dashed" style={{ height: 18, padding: "0 7px" }} aria-hidden />
              held through a group
            </span>
          </form>
          <Table label="Members">
            <thead>
              <tr>
                <th>Person</th>
                <th>Access</th>
                <th>Last active</th>
                <th className="w-act" />
              </tr>
            </thead>
            <tbody>
              {shownMembers.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <Empty>{members.length === 0 ? "Nobody holds a permission yet." : "Nobody matches."}</Empty>
                  </td>
                </tr>
              ) : (
                shownMembers.map((a) => (
                  <tr key={a.id}>
                    <td style={{ minWidth: 220 }}>
                      <Person account={a} you={a.id === who.mine.account.id} />
                    </td>
                    <td>
                      <div className="w-row" style={{ gap: 6 }}>
                        {directGrants(a).map((g) => (
                          <GrantChip key={g.id} grant={g} remove={g.id} />
                        ))}
                        {throughGroups(a).map((g) => (
                          <GrantChip key={g.id} grant={g} group={g.group} />
                        ))}
                      </div>
                    </td>
                    <td className="w-muted w-small" style={{ whiteSpace: "nowrap" }} title={a.last_active_at}>
                      {lastActive(a.last_active_at)}
                    </td>
                    <td className="w-act">
                      <ButtonLink href={here({ drawer: "grant", account: a.id })} small title={`Grant ${a.display_name} access`}>
                        Grant
                      </ButtonLink>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </>
      )}

      {tab === "groups" && (
        <>
          <div className="w-muted w-small w-row" style={{ gap: 6 }}>
            A grant to a group reaches everyone whose latest sign-in carried the group.
            <Tip>Granting to a group your identity provider names lets membership be managed there.</Tip>
          </div>
          <Table label="Groups">
            <thead>
              <tr>
                <th>Group</th>
                <th>Holds</th>
                <th>People whose sign-in carried it</th>
              </tr>
            </thead>
            <tbody>
              {groupNames.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <Empty>No permission is granted to a group.</Empty>
                  </td>
                </tr>
              ) : (
                groupNames.map((name) => {
                  const carried = accounts.filter((a) => a.groups.some((m) => m.name === name));
                  return (
                    <tr key={name}>
                      <td className="w-top">
                        <span className="w-mono">{name}</span>
                      </td>
                      <td className="w-top">
                        <div className="w-row" style={{ gap: 6 }}>
                          {groupGrants
                            .filter((g) => g.group === name)
                            .map((g) => (
                              <GrantChip key={g.id} grant={g} remove={g.id} />
                            ))}
                        </div>
                      </td>
                      <td className="w-top">
                        {carried.length === 0 ? (
                          <span className="w-faint">Nobody has signed in with it yet</span>
                        ) : (
                          <div className="w-row" style={{ gap: 10 }}>
                            {carried.map((a) => {
                              const current = a.groups.find((m) => m.name === name)?.current;
                              return (
                                <span key={a.id} className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                                  {a.display_name}
                                  {!current && (
                                    <Pill tone="warn" title="Their sign-in has lapsed, so this does not reach them until they sign in again">
                                      lapsed
                                    </Pill>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </Table>
        </>
      )}

      {tab === "none" && (
        <>
          <div className="w-muted w-small w-row" style={{ gap: 6 }}>
            Signed in, holding nothing: the deployment shows them nothing.
            <Tip>Each was shown the identity below and told that an administrator grants permissions.</Tip>
          </div>
          <Table label="Signed in without access">
            <thead>
              <tr>
                <th>Person</th>
                <th>Groups their sign-in carried</th>
                <th>Last active</th>
                <th className="w-act" />
              </tr>
            </thead>
            <tbody>
              {holdingNothing.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <Empty>Everyone who has signed in holds something.</Empty>
                  </td>
                </tr>
              ) : (
                holdingNothing.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Person account={a} you={false} />
                    </td>
                    <td>
                      {a.groups.length === 0 ? (
                        <span className="w-faint">None</span>
                      ) : (
                        <div className="w-row" style={{ gap: 6 }}>
                          {a.groups.map((g) => (
                            <span key={g.name} className="w-chip w-mono">
                              {g.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="w-muted w-small" title={a.last_active_at}>
                      {lastActive(a.last_active_at)}
                    </td>
                    <td className="w-act">
                      <ButtonLink href={here({ drawer: "grant", account: a.id })} small>
                        Grant
                      </ButtonLink>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </>
      )}

      {tab === "permissions" && permissionsTable(heldBy)}

      {recentCard}

      {params.drawer === "grant" && (
        <Drawer title="Grant access" close={closeDrawer}>
          <GrantForm choices={choices} account={params.account} />
        </Drawer>
      )}
    </WorkPage>
  );
}

