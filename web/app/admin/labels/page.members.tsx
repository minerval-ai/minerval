import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { AdminNav, NeedsPermission, Notice, can, viewer } from "@/components/admin/access";
import { dateish } from "@/lib/account-format";
import {
  fetchGrants,
  fetchLabels,
  fetchParties,
  fetchSetupChecklist,
  type GrantView,
  type SetupChecklist,
} from "@/lib/admin-api";
import { capitalised, count, holdersText, labelClearanceFacts } from "@/lib/admin-words";
import {
  addLabelReadAction,
  addPartyAction,
  defineLabelAction,
  removeLabelReadAction,
  setSourcePartyAction,
} from "../actions";

export const metadata: Metadata = { title: "Labels and parties · Minerval" };
export const dynamic = "force-dynamic";

// Labels say who may read a thing; parties say whose material a source is.
// Both are the administrators' to define, and neither is ever removed,
// because rows carry them. This is one of the few pages that names labels:
// it is where they are managed.

const holdersOf = (grants: GrantView[]) =>
  capitalised(
    holdersText({
      accounts: new Set(grants.filter((g) => g.account).map((g) => g.account!.id)).size,
      groups: new Set(grants.filter((g) => g.group !== null).map((g) => g.group)).size,
    })
  );

export default async function LabelsPage() {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Labels and parties" permission="administer" />;

  const [labels, parties, grants, checklist] = await Promise.all([
    fetchLabels(who.externalId),
    fetchParties(who.externalId),
    fetchGrants(who.externalId),
    // For the providers cleared for each label and the count of sources by
    // party. The page reads without them.
    fetchSetupChecklist(who.externalId).catch(() => null as SetupChecklist | null),
  ]);
  const cleared = new Map((checklist?.labels ?? []).map((l) => [l.name, l]));
  const sourcesBy = new Map((checklist?.material.sources_by_party ?? []).map((p) => [p.party.id, p.sources]));
  const ownLabels = labels.filter((l) => l.name !== "public");

  return (
    <div className="admin-page">
      <PageHead
        kicker="Administration"
        title="Labels and parties"
        lede="A label says who may read a thing. A party is whoever a source belongs to. Neither is ever removed once defined, because sources, judgments and runs carry them."
      />
      <AdminNav current="/admin/labels" />

      <section className="acct-section admin-first" id="labels">
        <div className="acct-head">
          <h2>Labels</h2>
        </div>
        <p className="acct-prose acct-measure">
          Labels are not ranked. A person reads at the labels they are granted, and at whatever
          those labels are recorded here as reading, and nothing else. Two labels that do not read
          each other stay apart. An agent&rsquo;s run works at one label and reads on the same
          terms.
        </p>
        <div className="acct-scroll">
          <table className="account-table acct-table">
            <thead>
              <tr>
                <th>label</th>
                <th>what it is for</th>
                <th>also reads</th>
                <th>who reads at it</th>
                <th>defined</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((l) => (
                <tr key={l.name}>
                  <td>
                    <code>{l.name}</code>
                  </td>
                  <td>{l.description}</td>
                  <td>
                    {l.name === "public" ? (
                      <span className="acct-quiet">Nothing. Public never reads another label.</span>
                    ) : l.reads.length === 0 ? (
                      <span className="acct-quiet">Only itself</span>
                    ) : (
                      <ul className="admin-grants">
                        {l.reads.map((r) => (
                          <li key={r}>
                            <code>{r}</code>
                            <ActionForm action={removeLabelReadAction} submit="take back" inline danger>
                              <input type="hidden" name="label" value={l.name} />
                              <input type="hidden" name="reads" value={r} />
                            </ActionForm>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {l.name === "public"
                      ? "Every member"
                      : holdersOf(grants.filter((g) => g.permission === "read" && g.label === l.name))}
                  </td>
                  <td className="acct-num-left">{dateish(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ownLabels.length === 0 && (
          <p className="account-empty">
            The only label is public, so everything in this deployment can be read by every member.
            Define a label below for material that is not for everyone.
          </p>
        )}

        {ownLabels.length > 0 && (
          <>
            <div className="acct-sub admin-gap">
              <h3>What each label may be sent to</h3>
            </div>
            <p className="acct-prose acct-measure">
              Text at a label reaches a model provider or an outside service only if that provider
              is cleared for the label. Whoever runs the deployment clears providers in its{" "}
              <code>PROVIDER_LABELS</code> setting; it is not changed from this page.
            </p>
            <ul className="admin-checks">
              {ownLabels.flatMap((l) => {
                const facts = cleared.get(l.name);
                return (facts ? labelClearanceFacts(facts) : []).map((fact) => <li key={fact}>{fact}</li>);
              })}
            </ul>
          </>
        )}

        <div className="acct-cols">
          <div className="acct-main">
            <h3>Define a label</h3>
            <ActionForm action={defineLabelAction} submit="Define the label">
              <label>
                Name
                <input name="name" required pattern="[a-z][a-z0-9_\-]{0,62}" autoComplete="off" />
                <small>
                  Lower-case letters, digits, hyphens and underscores, starting with a letter. The
                  name is shown to everyone cleared for the label and cannot be changed.
                </small>
              </label>
              <label>
                What it is for
                <input name="description" required maxLength={500} autoComplete="off" />
              </label>
              {ownLabels.length > 0 && (
                <fieldset className="admin-fieldset">
                  <legend>Its holders may also read</legend>
                  {ownLabels.map((l) => (
                    <label key={l.name} className="admin-check">
                      <input type="checkbox" name="reads" value={l.name} />
                      <code>{l.name}</code>
                    </label>
                  ))}
                </fieldset>
              )}
            </ActionForm>
            <p className="acct-note">
              Every label reads public without it being said. Defining a label gives nobody the
              right to read at it: that is granted on{" "}
              <Link href="/admin/people#grant">People and permissions</Link>. From the moment a
              deployment has a label besides public it is treated as holding private material, and
              the checks on the <Link href="/admin#checks">setup page</Link> that protect private
              material must pass before agent work starts.
            </p>
          </div>

          {ownLabels.length > 1 && (
            <aside className="acct-side acct-side-wide">
              <h3>Say that one label reads another</h3>
              <Notice>
                Adding a pair widens what every holder of the first label may read, at once.
                Everyone who reads at it can then read everything at the second label too, and so
                can every agent run that works at it. It can be taken back, and both acts are
                logged.
              </Notice>
              <ActionForm action={addLabelReadAction} submit="Record the pair">
                <label>
                  Holders of
                  <select name="label" required defaultValue="">
                    <option value="" disabled>
                      Choose a label
                    </option>
                    {ownLabels.map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  may also read
                  <select name="reads" required defaultValue="">
                    <option value="" disabled>
                      Choose a label
                    </option>
                    {ownLabels.map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              </ActionForm>
            </aside>
          )}
        </div>
      </section>

      <section className="acct-section" id="parties">
        <div className="acct-head">
          <h2>Parties</h2>
        </div>
        <p className="acct-prose acct-measure">
          Every source belongs to a party: this organisation, or an outside party that supplied
          it, such as a customer, a supplier or a partner. The party is recorded so that its stake
          in what a source says can be weighed, and because release is granted party by party: the
          holders of release for a party are who decides whether anything resting on its material
          leaves the deployment. Publishing outward is not built yet, so for now that grant only
          records who they are.
        </p>
        {parties.length === 0 ? (
          <p className="account-empty">
            No party is recorded yet. Add this organisation first, then any outside party whose
            material the graph will hold.
          </p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>party</th>
                  <th className="admin-num">sources</th>
                  <th>who holds release for it</th>
                  <th>added</th>
                </tr>
              </thead>
              <tbody>
                {parties.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      {p.is_own_organization && <span className="acct-detail">this organisation</span>}
                    </td>
                    <td className="admin-num">{(sourcesBy.get(p.id) ?? 0).toLocaleString("en-GB")}</td>
                    <td>{holdersOf(grants.filter((g) => g.permission === "release" && g.party?.id === p.id))}</td>
                    <td className="acct-num-left">{dateish(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="acct-cols">
          <div className="acct-main">
            <h3>Add a party</h3>
            <ActionForm action={addPartyAction} submit="Add the party">
              <label>
                Name
                <input name="name" required maxLength={200} autoComplete="off" />
                <small>Shown wherever the party&rsquo;s material is, to the people entitled to know of it.</small>
              </label>
              {!parties.some((p) => p.is_own_organization) && (
                <label className="admin-check">
                  <input type="checkbox" name="is_own_organization" />
                  This is the organisation that runs this deployment
                </label>
              )}
            </ActionForm>
          </div>

          <aside className="acct-side acct-side-wide" id="sources">
            <h3>Whose material a source is</h3>
            {checklist && (
              <p className="acct-prose">
                {count(checklist.material.sources, "source")} recorded
                {checklist.material.sources > 0 && (
                  <>
                    , {checklist.material.sources_with_no_party.toLocaleString("en-GB")} of them as
                    no party&rsquo;s
                  </>
                )}
                . The table gives the count for each party.
              </p>
            )}
            <p className="acct-prose">
              A source added by a person starts as no party&rsquo;s. A reading kept through a
              connection is the material of the party whose system it was read from. Each change
              made here is logged with what the party was before.
            </p>
            {parties.length > 0 && (
              <ActionForm action={setSourcePartyAction} submit="Record whose it is">
                <label>
                  The source
                  <input name="source" required autoComplete="off" />
                  <small>The address of the source&rsquo;s page, or its id.</small>
                </label>
                <label>
                  Is the material of
                  <select name="party_id" defaultValue="">
                    <option value="">No party</option>
                    {parties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </ActionForm>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}
