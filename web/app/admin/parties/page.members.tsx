import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  ButtonLink,
  Lbl,
  Count,
  Drawer,
  Empty,
  Party,
  Pill,
  Section,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  plural,
  shortDay,
} from "@/components/work/ui";
import { fetchGrants, fetchParties, fetchSetupChecklist, type GrantView, type PartyView, type SetupChecklist } from "@/lib/admin-api";
import { fetchSources, type SourceList } from "@/lib/sources-api";
import { addPartyAction, setSourcePartyAction } from "../actions";

export const metadata: Metadata = { title: "Parties · Minerval" };
export const dynamic = "force-dynamic";

// Parties say whose material a source is: this organisation, or an outside
// party that supplied it. A party is recorded so that its stake in what a
// source says can be weighed, and because release is granted party by party.
// Parties are the administrators' to add, and never removed, because sources
// carry them.

const PAGE = "/admin/parties";
const UNASSIGNED_SHOWN = 50;

// The name the organisation's own party carries from setup until an administrator names it
// (OWN_ORGANIZATION_SETUP_NAME in the API's permission service).
const OWN_ORGANISATION_SETUP_NAME = "This organization";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");

export default async function PartiesPage({ searchParams }: { searchParams: Promise<{ drawer?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Parties" permission="administer" />;
  const { drawer } = await searchParams;

  const [parties, grants, checklist, unassignedList] = await Promise.all([
    fetchParties(who.externalId),
    fetchGrants(who.externalId),
    // For the count of sources by party. The page reads without it.
    fetchSetupChecklist(who.externalId).catch(() => null as SetupChecklist | null),
    // The sources recorded as no party's, each to be given one in its row.
    // Without the list, a source is named by pasting its address.
    fetchSources(who.externalId, { party: "none", limit: UNASSIGNED_SHOWN }).catch(() => null as SourceList | null),
  ]);
  const sourcesBy = new Map((checklist?.material.sources_by_party ?? []).map((p) => [p.party.id, p.sources]));
  const ownParty = parties.find((p) => p.is_own_organization);
  // The organisation itself is a party from setup, under a name that stands in
  // for its own until an administrator gives it; it is offered until then.
  const ownOffered = !ownParty || ownParty.name === OWN_ORGANISATION_SETUP_NAME;
  const release = grants.filter((g) => g.permission === "release" && !g.removed_at);
  const unassigned = unassignedList?.total ?? checklist?.material.sources_with_no_party ?? null;
  const listed = unassignedList?.sources ?? [];
  // A source is also named by its address: to change one that has a party,
  // and for any not among the rows. It is folded away where the rows cover every unassigned one.
  const pasteFolded = unassignedList !== null && unassignedList.total <= listed.length;

  return (
    <WorkPage>
      <WorkHead
        title="Parties"
        sub={
          <span className="w-row" style={{ gap: 6 }}>
            Whose material a source is · who may release it
            <Tip>
              Every source belongs to a party: this organisation, or an outside party that supplied it, such as a customer, a supplier or a partner. Release is granted party by party: the holders of release for a party decide whether anything resting on its material leaves the deployment, at the gates. Parties are never removed.
            </Tip>
          </span>
        }
        actions={
          <ButtonLink href={`${PAGE}?drawer=add`} primary icon="plus">
            Add party
          </ButtonLink>
        }
      />

      {parties.length === 0 ? (
        <div className="w-card">
          <Empty>No party is recorded yet. Add this organisation first, then any outside party whose material the graph will hold.</Empty>
        </div>
      ) : (
        <Table label="Parties">
          <thead>
            <tr>
              <th>Party</th>
              <th className="w-num">Sources</th>
              <th>
                Release holders <Tip>Who decides, at the gates, whether anything resting on the party&apos;s material leaves the deployment.</Tip>
              </th>
              <th className="w-num">Added</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="w-row">
                    <Party name={p.name} own={p.is_own_organization} />
                    {p.is_own_organization && <Pill tone="info">Your organisation</Pill>}
                  </span>
                </td>
                <td className="w-num">{checklist ? (sourcesBy.get(p.id) ?? 0).toLocaleString("en-GB") : "—"}</td>
                <td>
                  <Holders grants={release.filter((g) => g.party?.id === p.id)} />
                </td>
                <td className="w-num w-muted" style={{ whiteSpace: "nowrap" }}>
                  {shortDay(p.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Section
        title="Sources without a party"
        id="sources"
        aside={
          <span className="w-row" style={{ gap: 8 }}>
            {unassigned !== null && <Count n={unassigned} hot={unassigned > 0} />}
            <span>
              {checklist ? `of ${plural(checklist.material.sources, "source")} · added by a person, not yet assigned` : "Added by a person, not yet assigned"}
            </span>
            <Tip>
              A source added by a person starts as no party&apos;s. A reading kept through a connection is the material of the party whose system it was read from. Each change made here is logged with what the party was before.
            </Tip>
          </span>
        }
      >
        {parties.length === 0 ? (
          <div className="w-card">
            <div className="w-card-b w-muted">Add a party first; then a source can be recorded as its material.</div>
          </div>
        ) : (
          <>
            {listed.length > 0 && (
              <Table label="Sources without a party">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Label</th>
                    <th className="w-num">Added</th>
                    <th>Party</th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map((src) => (
                    <tr key={src.id}>
                      <td>
                        <Link href={`/sources/${src.id}`}>{src.title || src.url || "Untitled source"}</Link>
                      </td>
                      <td>
                        <Lbl name={src.label} />
                      </td>
                      <td className="w-num w-muted" style={{ whiteSpace: "nowrap" }}>
                        {shortDay(src.added_at)}
                      </td>
                      <td>
                        <WorkForm action={setSourcePartyAction} submit="Save" inline>
                          <input type="hidden" name="source" value={src.id} />
                          <PartySelect parties={parties} label={`Whose material ${src.title} is`} />
                        </WorkForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {pasteFolded ? (
              <details>
                <summary className="w-small" style={{ cursor: "pointer", color: "var(--w-accent)" }}>
                  Change any source&rsquo;s party
                </summary>
                <div style={{ marginTop: 8 }}>
                  <ByAddress parties={parties} />
                </div>
              </details>
            ) : (
              <ByAddress parties={parties} />
            )}
            <span className="w-help">
              Find a source on <Link href="/sources">Sources</Link>. Each change is logged with the previous party.
            </span>
          </>
        )}
      </Section>

      {drawer === "add" && (
        <Drawer title="Add party" close={PAGE}>
          <WorkForm
            action={addPartyAction}
            submit="Add party"
            primary
            lock="Parties are never removed"
            extra={
              <Link href={PAGE} className="w-btn w-ghost">
                Cancel
              </Link>
            }
          >
            <div className="w-field">
              <label htmlFor="party-name">Name</label>
              <input id="party-name" className="w-input" name="name" required maxLength={200} autoComplete="off" />
              <span className="w-help">Shown wherever its material is, to the people entitled to know of it.</span>
            </div>
            <label className="w-check" style={ownOffered ? undefined : { opacity: 0.6 }}>
              <input type="checkbox" name="is_own_organization" disabled={!ownOffered} />
              <span>
                This is the organisation that runs this deployment
                <br />
                <span className="w-help">
                  {!ownParty
                    ? "Add it first: release and connections name it."
                    : ownOffered
                      ? `It is a party already, as "${ownParty.name}". Ticking this gives it the name you enter.`
                      : `${ownParty.name} already is.`}
                </span>
              </span>
            </label>
          </WorkForm>
        </Drawer>
      )}
    </WorkPage>
  );
}

/** Whose material a source is, the source named by its page's address or its id. */
function ByAddress({ parties }: { parties: PartyView[] }) {
  return (
    <div className="w-card">
      <div className="w-card-b">
        <WorkForm action={setSourcePartyAction} submit="Record" inline>
          <input
            className="w-input"
            name="source"
            required
            autoComplete="off"
            placeholder="The source's page address, or its id"
            aria-label="The source"
            style={{ width: 340, height: 26 }}
          />
          <span className="w-muted w-small">is the material of</span>
          <PartySelect parties={parties} label="Party" />
        </WorkForm>
      </div>
    </div>
  );
}

function PartySelect({ parties, label }: { parties: PartyView[]; label: string }) {
  return (
    <select className="w-select" name="party_id" defaultValue="" aria-label={label} style={{ width: "auto", height: 26 }}>
      <option value="">No party</option>
      {parties.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** Who holds release for a party, by name; "Nobody" with the way to grant it. */
function Holders({ grants }: { grants: GrantView[] }) {
  const people = [...new Map(grants.filter((g) => g.account).map((g) => [g.account!.id, g.account!.display_name])).values()];
  const groups = [...new Set(grants.filter((g) => g.group !== null).map((g) => g.group!))];
  if (people.length === 0 && groups.length === 0) {
    return (
      <span className="w-row" style={{ gap: 8 }}>
        <Pill tone="warn">Nobody</Pill>
        <Link href="/admin/people?drawer=grant" className="w-small">
          Grant
        </Link>
      </span>
    );
  }
  return (
    <span className="w-row" style={{ gap: 12 }}>
      {people.map((name) => (
        <span key={name} className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
          <span className="w-avatar w-sm" aria-hidden>
            {initials(name)}
          </span>
          {name}
        </span>
      ))}
      {groups.map((g) => (
        <span key={g} className="w-chip" title="A group">
          {g}
        </span>
      ))}
    </span>
  );
}
