import type { Metadata } from "next";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, can, viewer, when } from "@/components/admin/access";
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
  type LogEntry,
  type PartyView,
  type PermissionDefinition,
} from "@/lib/admin-api";
import { capitalised, grantText, holdersText, logSentence, permissionName } from "@/lib/admin-words";
import { grantAction, removeGrantAction } from "../actions";

export const metadata: Metadata = { title: "People and permissions · Minerval" };
export const dynamic = "force-dynamic";

// Who may do what in this deployment. Every member may read what each
// permission covers, what they hold themselves, and the log of every grant
// and removal: who holds power over a graph is part of what its readers
// weigh. Who holds what now, and granting and removing, are for holders of
// the permission to administer.

const LOG_ENTRIES = 200;

/** The deployment's own account, which nobody signs in to, is not a person to grant to. */
const isPerson = (account: AccountView) => !account.external_id?.startsWith("platform:");

export default async function PeoplePage() {
  const who = await viewer();
  if (!who) return null;
  const administers = can(who, "administer");

  const [definitions, log] = await Promise.all([
    fetchPermissionDefinitions(who.externalId).catch(() => [] as PermissionDefinition[]),
    fetchPermissionLog(who.externalId, LOG_ENTRIES).catch(() => null),
  ]);
  let grants: GrantView[] = [];
  let accounts: AccountView[] = [];
  let labels: LabelView[] = [];
  let parties: PartyView[] = [];
  if (administers) {
    [grants, accounts, labels, parties] = await Promise.all([
      fetchGrants(who.externalId),
      fetchAccounts(who.externalId),
      fetchLabels(who.externalId),
      fetchParties(who.externalId),
    ]);
    accounts = accounts.filter(isPerson);
  }

  const ownLabels = labels.filter((l) => l.name !== "public");
  const groupGrants = grants.filter((g) => g.group !== null);
  const groupNames = [...new Set(groupGrants.map((g) => g.group!))].sort();
  const directGrants = (account: AccountView) => grants.filter((g) => g.account?.id === account.id);
  const throughGroups = (account: AccountView) =>
    groupGrants.filter((g) => account.groups.some((m) => m.current && m.name === g.group));
  const holders = accounts.filter((a) => directGrants(a).length > 0 || throughGroups(a).length > 0);
  const holdingNothing = accounts.filter((a) => directGrants(a).length === 0 && throughGroups(a).length === 0);
  const heldBy = (permission: string) => {
    const held = grants.filter((g) => g.permission === permission);
    return capitalised(
      holdersText({
        accounts: new Set(held.filter((g) => g.account).map((g) => g.account!.id)).size,
        groups: new Set(held.filter((g) => g.group !== null).map((g) => g.group)).size,
      })
    );
  };

  return (
    <div className="admin-page">
      <PageHead
        kicker="Administration"
        title="People and permissions"
        lede="Six permissions, each granted on its own, to a person or to a group your identity provider names. One person may hold several. Nothing in the deployment decides who should hold which: its administrators do, and every grant and removal is logged below for every member to read."
      />
      {administers && <AdminNav current="/admin/people" />}

      <section className="acct-section admin-first" id="permissions">
        <div className="acct-head">
          <h2>What each permission covers</h2>
        </div>
        <div className="acct-scroll">
          <table className="account-table acct-table">
            <thead>
              <tr>
                <th>permission</th>
                <th>lets its holder</th>
                <th>never lets anyone</th>
                {administers && <th>held by</th>}
              </tr>
            </thead>
            <tbody>
              {definitions.map((d) => (
                <tr key={d.name}>
                  <td>
                    <strong>{permissionName(d.name)}</strong>
                    {d.scope !== "none" && (
                      <span className="acct-detail">
                        {d.scope === "label" ? "granted at one label" : "granted for one party"}
                      </span>
                    )}
                  </td>
                  <td>{d.covers}</td>
                  <td>{d.never}</td>
                  {administers && <td>{heldBy(d.name)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {!administers && (
        <section className="acct-section" id="yours">
          <div className="acct-head">
            <h2>What you hold</h2>
          </div>
          <ul className="admin-grants">
            {who.mine.grants.map((g, i) => (
              <li key={i}>
                The permission to {grantText(g)}
                {g.through_group && <span className="acct-detail">through the group {g.through_group}</span>}
              </li>
            ))}
          </ul>
          <p className="acct-prose acct-measure">
            Who holds what across the deployment, and granting and removing, need the permission to
            administer the deployment, which you do not hold. An administrator of this deployment
            grants it. The log below is open to you as it is to every member.
          </p>
        </section>
      )}

      {administers && (
        <>
          <section className="acct-section" id="holders">
            <div className="acct-head">
              <h2>Who holds what</h2>
            </div>
            <div className="acct-sub">
              <h3>People</h3>
            </div>
            <div className="acct-scroll">
              <table className="account-table acct-table">
                <thead>
                  <tr>
                    <th>person</th>
                    <th>holds, granted to them</th>
                    <th>holds, through a group</th>
                  </tr>
                </thead>
                <tbody>
                  {holders.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Person account={a} you={a.id === who.mine.account.id} />
                      </td>
                      <td>
                        <Grants grants={directGrants(a)} removable />
                      </td>
                      <td>
                        <Grants grants={throughGroups(a)} showGroup />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="acct-sub admin-gap">
              <h3>Groups</h3>
              <span className="acct-note">
                a grant to a group reaches everyone whose latest sign-in carried the group
              </span>
            </div>
            {groupNames.length === 0 ? (
              <p className="account-empty">
                No permission is granted to a group. Granting to a group your identity provider
                names lets membership be managed there.
              </p>
            ) : (
              <table className="account-table acct-table">
                <thead>
                  <tr>
                    <th>group</th>
                    <th>holds</th>
                    <th>people whose sign-in carried it</th>
                  </tr>
                </thead>
                <tbody>
                  {groupNames.map((name) => {
                    const members = accounts.filter((a) => a.groups.some((m) => m.name === name));
                    return (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>
                          <Grants grants={groupGrants.filter((g) => g.group === name)} removable />
                        </td>
                        <td>
                          {members.length === 0
                            ? "Nobody has signed in with this group yet."
                            : members.map((a) => {
                                const current = a.groups.find((m) => m.name === name)?.current;
                                return (
                                  <div key={a.id}>
                                    {a.display_name}
                                    {!current && (
                                      <span className="acct-detail">
                                        their sign-in has lapsed, so this does not reach them until they
                                        sign in again
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="acct-section" id="grant">
            <div className="acct-head">
              <h2>Grant a permission</h2>
            </div>
            <p className="acct-prose acct-measure">
              A grant is to one person or to one group. Reading and opening raw sources are granted
              at one label, and release for one party; the other three take neither. The grant is
              logged with your name and is never deleted: removing it later marks it as removed.
            </p>
            <ActionForm action={grantAction} submit="Grant">
              <label>
                Permission
                <select name="permission" required defaultValue="">
                  <option value="" disabled>
                    Choose a permission
                  </option>
                  {definitions.map((d) => (
                    <option key={d.name} value={d.name}>
                      {permissionName(d.name)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="admin-form-row">
                <label>
                  To a person
                  <select name="account_id" defaultValue="">
                    <option value="">Nobody chosen</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.display_name}
                        {a.email ? ` (${a.email})` : ""}
                      </option>
                    ))}
                  </select>
                  <small>Everyone who has signed in is listed.</small>
                </label>
                <label>
                  Or to a group
                  <input name="group" maxLength={256} autoComplete="off" />
                  <small>The group&rsquo;s name exactly as your identity provider sends it.</small>
                </label>
              </div>
              <div className="admin-form-row">
                <label>
                  At the label
                  <select name="label" defaultValue="">
                    <option value="">No label</option>
                    {ownLabels.map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    For reading and for opening raw sources.
                    {ownLabels.length === 0 && " No label besides public is defined yet."}
                  </small>
                </label>
                <label>
                  For the party
                  <select name="party_id" defaultValue="">
                    <option value="">No party</option>
                    {parties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    For release.{parties.length === 0 && " No party is recorded yet."}
                  </small>
                </label>
              </div>
            </ActionForm>
          </section>

          <section className="acct-section" id="nothing">
            <div className="acct-head">
              <h2>Signed in, holding nothing</h2>
            </div>
            {holdingNothing.length === 0 ? (
              <p className="account-empty">Everyone who has signed in holds something.</p>
            ) : (
              <>
                <p className="acct-prose acct-measure">
                  These people have signed in and hold no permission, so the deployment shows them
                  nothing. Each was shown the identity below and told that an administrator grants
                  permissions.
                </p>
                <table className="account-table acct-table">
                  <thead>
                    <tr>
                      <th>person</th>
                      <th>groups their sign-in carried</th>
                      <th>last here</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdingNothing.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Person account={a} you={false} />
                        </td>
                        <td>{a.groups.length === 0 ? "None" : a.groups.map((g) => g.name).join(", ")}</td>
                        <td className="acct-num-left">{when(a.last_active_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </>
      )}

      <section className="acct-section" id="log">
        <div className="acct-head">
          <h2>The log</h2>
        </div>
        <p className="acct-prose acct-measure">
          Every grant, every removal and every other administrative act, newest first. Nothing is
          ever deleted from it. Where an entry names a label you are not cleared to read, or a
          party you are not entitled to know of, the name is withheld and the entry says so. That
          the act happened, who did it and when is always shown.
        </p>
        {log === null ? (
          <p className="account-empty">The log could not be read just now. Try again in a moment.</p>
        ) : log.length === 0 ? (
          <p className="account-empty">Nothing has been logged yet.</p>
        ) : (
          <Log entries={log} more={log.length === LOG_ENTRIES} />
        )}
      </section>
    </div>
  );
}

function Person({ account, you }: { account: AccountView; you: boolean }) {
  return (
    <>
      {account.display_name}
      {you && <span className="acct-detail">you</span>}
      <br />
      <span className="acct-note">
        {account.email ? `${account.email} · ` : ""}
        <code>{account.external_id ?? "no sign-in identity"}</code>
      </span>
    </>
  );
}

function Grants({
  grants,
  removable = false,
  showGroup = false,
}: {
  grants: GrantView[];
  removable?: boolean;
  showGroup?: boolean;
}) {
  if (grants.length === 0) return <span className="acct-quiet">Nothing</span>;
  return (
    <ul className="admin-grants">
      {grants.map((g) => (
        <li key={g.id}>
          {capitalised(grantText(g))}
          {showGroup && g.group && <span className="acct-detail">{g.group}</span>}
          {removable && (
            <ActionForm action={removeGrantAction} submit="remove" inline danger>
              <input type="hidden" name="grant_id" value={g.id} />
            </ActionForm>
          )}
        </li>
      ))}
    </ul>
  );
}

function Log({ entries, more }: { entries: LogEntry[]; more: boolean }) {
  return (
    <>
      <table className="account-table acct-table">
        <thead>
          <tr>
            <th>when</th>
            <th>what happened</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={`${entry.at}-${i}`}>
              <td className="acct-num-left">{when(entry.at)}</td>
              <td>{logSentence(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more && (
        <p className="acct-note">
          The newest {entries.length} entries are shown. Earlier ones are kept, and the API serves
          them (<code>GET /permissions/log</code>).
        </p>
      )}
    </>
  );
}
