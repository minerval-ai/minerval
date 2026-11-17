import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { NeedsPermission, Notice, can, viewer } from "@/components/admin/access";
import { WorkNav } from "@/components/inside/nav";
import { dateish } from "@/lib/account-format";
import {
  fetchGrants,
  fetchLabels,
  fetchParties,
  fetchProviderClearance,
  fetchSetupChecklist,
  type GrantView,
  type ProviderClearance,
  type ProviderView,
  type SetupChecklist,
} from "@/lib/admin-api";
import { capitalised, count, holdersText, labelClearanceFacts } from "@/lib/admin-words";
import {
  addLabelReadAction,
  addPartyAction,
  defineLabelAction,
  removeLabelReadAction,
  setProviderClearanceAction,
  setSourcePartyAction,
} from "../actions";

// The name the organisation's own party carries from setup until an administrator names it
// (OWN_ORGANIZATION_SETUP_NAME in the API's permission service).
const OWN_ORGANISATION_SETUP_NAME = "This organization";

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

// The providers a label may be cleared for, ticked where it is, and the
// "same as public" box, which stands for every one listed: every provider is
// cleared for public. Nothing is ticked that nobody ticked.
function ProviderChecks({ providers, cleared }: { providers: ProviderView[]; cleared: readonly string[] }) {
  return (
    <>
      {providers.map((p) => (
        <label key={p.name} className="admin-check">
          <input type="checkbox" name="providers" value={p.name} defaultChecked={cleared.includes(p.name)} />
          <span>
            <code>{p.name}</code>
            <small>
              {" "}
              {p.description}
              {!p.configured && " Not set up in this deployment."}
            </small>
          </span>
          <input type="hidden" name="offered" value={p.name} />
        </label>
      ))}
      <label className="admin-check">
        <input type="checkbox" name="same_as_public" />
        <span>
          The same as public: every one listed above
          <small> Ticking this clears them all, whatever else is ticked.</small>
        </span>
      </label>
    </>
  );
}

/**
 * What the labels page offers to clear: the providers this deployment has
 * set up, and any already cleared, so that a clearance can be taken back
 * after a provider is no longer set up.
 */
function offeredProviders(clearance: ProviderClearance): ProviderView[] {
  const cleared = new Set(clearance.labels.flatMap((l) => l.cleared));
  return clearance.providers.filter((p) => p.configured || cleared.has(p.name));
}

export default async function LabelsPage() {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Labels and parties" permission="administer" />;

  const [labels, parties, grants, checklist, clearance] = await Promise.all([
    fetchLabels(who.externalId),
    fetchParties(who.externalId),
    fetchGrants(who.externalId),
    // For the providers cleared for each label and the count of sources by
    // party. The page reads without them.
    fetchSetupChecklist(who.externalId).catch(() => null as SetupChecklist | null),
    // Which providers each label may be sent to, and what each is sent. The
    // page reads without it, offering no change.
    fetchProviderClearance(who.externalId).catch(() => null as ProviderClearance | null),
  ]);
  // Clearing is offered where the settings do not fix it, to a holder of the permission for it.
  const clears = clearance !== null && !clearance.fixed_by_settings && can(who, "clear_providers");
  const offered = clearance ? offeredProviders(clearance) : [];
  const clearedFor = new Map((clearance?.labels ?? []).map((l) => [l.label, l.cleared]));
  const cleared = new Map((checklist?.labels ?? []).map((l) => [l.name, l]));
  const sourcesBy = new Map((checklist?.material.sources_by_party ?? []).map((p) => [p.party.id, p.sources]));
  const ownLabels = labels.filter((l) => l.name !== "public");
  const ownParty = parties.find((p) => p.is_own_organization);
  const generalAt = generalMandateAt(checklist);

  return (
    <div className="admin-page">
      <PageHead
        kicker="Administration"
        title="Labels and parties"
        lede="A label says who may read a thing. A party is whoever a source belongs to. Neither is ever removed once defined, because sources, judgments and runs carry them."
      />
      <WorkNav who={who} current="/admin/labels" />

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
                <th>General mandate</th>
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
                  <td>
                    <GeneralMandateCell label={l.name} state={generalAt(l.name)} />
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
            <div className="acct-sub admin-gap" id="providers">
              <h3>What each label may be sent to</h3>
            </div>
            {clearance?.fixed_by_settings ? (
              <p className="acct-prose acct-measure">
                Text at a label reaches a model provider or an outside service only if that provider
                is cleared for the label. Here that is fixed by the deployment&rsquo;s settings (its{" "}
                <code>PROVIDER_LABELS</code> setting, or <code>[provider_labels]</code> in its config
                file), so it is not changed from this page. Whoever runs the deployment changes it there.
              </p>
            ) : (
              <p className="acct-prose acct-measure">
                Text at a label reaches a model provider or an outside service only if that provider
                is cleared for the label. Every provider is cleared for public, and none for any other
                label until someone ticks it here: which outside party may read private text is never
                a default. Ticking one sends it the text of every agent run at that label, as the list
                below says. Each change is logged, and is in force within a few seconds, with no restart.
                {!can(who, "clear_providers") && " Changing it takes the permission to clear providers, which you do not hold."}
              </p>
            )}
            <ul className="admin-checks">
              {ownLabels.flatMap((l) => {
                const facts = cleared.get(l.name);
                return (facts ? labelClearanceFacts(facts) : []).map((fact) => <li key={fact}>{fact}</li>);
              })}
            </ul>
            {clears && (
              <div className="acct-cols">
                {ownLabels.map((l) => (
                  <div key={l.name} className="acct-main">
                    <h4>
                      <code>{l.name}</code> may be sent to
                    </h4>
                    <ActionForm action={setProviderClearanceAction} submit={`Save what ${l.name} may be sent to`}>
                      <input type="hidden" name="label" value={l.name} />
                      <fieldset className="admin-fieldset">
                        <legend>Cleared for {l.name}</legend>
                        <ProviderChecks providers={offered} cleared={clearedFor.get(l.name) ?? []} />
                      </fieldset>
                    </ActionForm>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="acct-cols">
          <div className="acct-main">
            <h3>Define a label</h3>
            {ownLabels.length === 0 && (
              <p className="acct-prose">
                The first label besides <code>public</code> changes how the whole deployment
                reads: from then on the database holds every reader, and every agent&rsquo;s run,
                to the labels they are cleared for. Defining it takes about ten seconds, while
                every running process is given time to notice.
              </p>
            )}
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
              {clears && (
                <fieldset className="admin-fieldset">
                  <legend>Its text may be sent to</legend>
                  <small>
                    Nothing is ticked: a label is served by no model provider or outside service until
                    one is cleared for it, and each one ticked is sent the text of every agent run at the
                    label, as it says. This can be changed later, below the list of labels.
                  </small>
                  <ProviderChecks providers={offered} cleared={[]} />
                </fieldset>
              )}
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
              Upkeep and audits at a label are paid by a General mandate at that label, because a
              mandate&rsquo;s work runs at its label. A new label has none until an administrator who
              reads it sets one up on <Link href="/admin/owls#standing-mandates">Owls</Link>; the
              column above links to the form for each label. None is needed at a label that will
              hold only work someone asks for and pays for. The setup page lists a label with none as
              to do while it holds nothing, and as failing once nodes or judgments are held there.
            </p>
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
          leaves the deployment, at the gates (<Link href="/gates">Gates</Link>, and the queue at{" "}
          <Link href="/gate">At the gate</Link>).
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
              {/* The organisation itself is a party from setup, under a name that stands in for
                  its own until an administrator gives it. It is offered here until then. */}
              {(!ownParty || ownParty.name === OWN_ORGANISATION_SETUP_NAME) && (
                <label className="admin-check">
                  <input type="checkbox" name="is_own_organization" />
                  <span>
                    This is the organisation that runs this deployment
                    {ownParty && (
                      <small>
                        {" "}
                        It is a party already, listed above as &ldquo;{ownParty.name}&rdquo;. Ticking
                        this gives it the name you enter.
                      </small>
                    )}
                  </span>
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

type GeneralState = "set_up" | "none" | "not_read" | "unknown";

// Whether a General mandate is set up at each label, as the setup checklist
// says: at the labels the reader reads, where the deployment holds more than
// one. A label the reader does not read is not answered for here.
function generalMandateAt(checklist: SetupChecklist | null): (label: string) => GeneralState {
  const general = checklist?.standing_mandates.find((m) => m.name === "general");
  return (label) => {
    if (!general) return "unknown";
    if (general.by_label) {
      const at = general.by_label.find((l) => l.label === label);
      return at ? (at.mandate ? "set_up" : "none") : "not_read";
    }
    if (label === "public") return general.mandate ? "set_up" : "none";
    return "not_read";
  };
}

function GeneralMandateCell({ label, state }: { label: string; state: GeneralState }) {
  const owlsAt = `/admin/owls#standing-mandate-${label}`;
  switch (state) {
    case "set_up":
      return <Link href={owlsAt}>Set up</Link>;
    case "none":
      return (
        <>
          None, so nothing pays for upkeep or audits here. <Link href={owlsAt}>Set one up</Link>, unless
          the label will hold only work someone asks for and pays for.
        </>
      );
    case "not_read":
      return (
        <span className="acct-quiet">
          Not shown: you do not read this label. An administrator who reads it sets one up on{" "}
          <Link href="/admin/owls#standing-mandates">Owls</Link>.
        </span>
      );
    default:
      return <span className="acct-quiet">Could not be read just now.</span>;
  }
}
