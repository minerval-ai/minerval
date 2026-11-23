import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Banner,
  ButtonLink,
  Drawer,
  Empty,
  Lbl,
  Lock,
  Pill,
  Section,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  plural,
  shortDay,
  type Tone,
} from "@/components/work/ui";
import {
  fetchGrants,
  fetchLabels,
  fetchProviderClearance,
  fetchSetupChecklist,
  type GrantView,
  type LabelView,
  type ProviderClearance,
  type ProviderView,
  type SetupChecklist,
  type StandingMandateState,
} from "@/lib/admin-api";
import { capitalised, holdersText, labelClearanceFacts, providerName } from "@/lib/admin-words";
import { addLabelReadAction, defineLabelAction } from "../actions";
import { ClearanceMatrix, type MatrixProvider } from "./ClearanceMatrix";
import { AddRead } from "./AddRead";
import { ReadChip } from "./ReadChip";
import { holdersCount, holdersInWords, readersOf, readsIndirectly, wideningOf } from "@/lib/label-chain";
import { byLayerThenName, clearedByChoice, isOpenLabel, isWorkableLabel, layerLine, layerOf, layersOf, type LabelLayers } from "@/lib/label-layers";
import "./labels.css";

export const metadata: Metadata = { title: "Labels · Minerval" };
export const dynamic = "force-dynamic";

// Labels say who may read a thing. They are the administrators' to define,
// and never removed, because rows carry them. This is one of the few pages
// that names labels: it is where they are managed, with what each reads,
// who reads at it, whether a General mandate pays for its upkeep, and which
// model providers and outside services its text may be sent to. Parties,
// which once shared this page, are on /admin/parties.
//
// Under the labels a deployment defines sit its bottom layers
// (lib/label-layers.ts): the public graph's own material, what the
// organization released outside, and the members' own. Each has a row,
// drawn as what it is: the first two are read by anyone and read by every
// label, nobody is granted them, and nothing here is filed at them.

const PAGE = "/admin/labels";

/**
 * What the page offers to clear: the providers this deployment has set up,
 * and any already cleared, so that a clearance can be taken back after a
 * provider is no longer set up.
 */
function offeredProviders(clearance: ProviderClearance): ProviderView[] {
  const cleared = new Set(clearance.labels.flatMap((l) => l.cleared));
  return clearance.providers.filter((p) => p.configured || cleared.has(p.name));
}

const heading = (name: string) => {
  const known = providerName(name);
  return known !== name ? known : capitalised(name.replace(/_/g, " "));
};

export default async function LabelsPage({ searchParams }: { searchParams: Promise<{ drawer?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Labels" permission="administer" />;
  const { drawer } = await searchParams;

  const [labels, grants, checklist, clearance] = await Promise.all([
    fetchLabels(who.externalId),
    fetchGrants(who.externalId),
    // For the General mandate at each label and what each label leaves
    // unserved. The page reads without it.
    fetchSetupChecklist(who.externalId).catch(() => null as SetupChecklist | null),
    // Which providers each label may be sent to. The page reads without it, offering no change.
    fetchProviderClearance(who.externalId).catch(() => null as ProviderClearance | null),
  ]);
  // Clearing is offered where the settings do not fix it, to a holder of the permission for it.
  const clears = clearance !== null && !clearance.fixed_by_settings && can(who, "clear_providers");
  const offered = clearance ? offeredProviders(clearance) : [];
  const clearedFor = new Map((clearance?.labels ?? []).map((l) => [l.label, l.cleared]));
  const facts = new Map((checklist?.labels ?? []).map((l) => [l.name, l]));
  const layers = layersOf(who.mine);
  // The labels a provider is cleared for by choice: every one but the public graph's.
  const ownLabels = labels.filter((l) => clearedByChoice(l.name, layers));
  // The labels a label can be made to read: not the two every label already reads.
  const readable = labels.filter((l) => !isOpenLabel(l.name, layers));
  const chip = (name: string) => <Lbl name={name} title={layerLine(name, layers)} />;
  const generalAt = generalMandateAt(checklist, layers);
  const readGrants = grants.filter((g) => g.permission === "read" && !g.removed_at);

  return (
    <WorkPage>
      <WorkHead
        title="Labels"
        sub={`${plural(labels.length, "label")} · labels are never removed`}
        actions={
          <ButtonLink href={`${PAGE}?drawer=add`} primary icon="plus">
            Add label
          </ButtonLink>
        }
      />

      <Table label="Labels">
        <thead>
          <tr>
            <th>Label</th>
            <th>Purpose</th>
            <th>
              Also reads{" "}
              <Tip>
                {`Labels are not ranked. A holder reads at the labels granted to them and at whatever those labels read, and nothing else. An agent's run works at one label and reads on the same terms. Every label reads what anyone may read: the public graph${layers.split ? " and what this organization has published" : ""}.`}
              </Tip>
            </th>
            <th className="w-num">Readers</th>
            <th>
              Upkeep{" "}
              <Tip>
                Upkeep and audits at a label are paid by a General mandate at that label, set up on Budget by an administrator who reads it. None is needed at a label that will hold only work someone asks for and pays for.
              </Tip>
            </th>
            <th className="w-num">Defined</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((l) => {
            const candidates = readable.filter((o) => o.name !== l.name && !l.reads.includes(o.name));
            const indirect = readsIndirectly(l.name, labels);
            const layer = layers.split ? layerOf(l.name, layers) : l.name === layers.public_graph ? "public_graph" : null;
            return (
              <tr key={l.name}>
                <td>{chip(l.name)}</td>
                <td className="w-muted">{l.description}</td>
                <td>
                  {layer === "public_graph" ? (
                    <span className="w-faint w-small">Never reads another label</span>
                  ) : layer === "published" ? (
                    <span className="w-row w-faint w-small" style={{ gap: 6 }}>
                      {chip(layers.public_graph)} and nothing else
                    </span>
                  ) : layer === "base" ? (
                    <span className="w-row w-faint w-small" style={{ gap: 6 }}>
                      {chip(layers.public_graph)} {chip(layers.published)} and nothing else
                    </span>
                  ) : (
                    <div className="w-row" style={{ gap: 6 }}>
                      {l.reads.length === 0 && <span className="w-faint w-small">Only itself</span>}
                      {l.reads.map((r) => (
                        <ReadChip key={r} label={l.name} reads={r} chip={chip(r)} />
                      ))}
                      {indirect.map((i) => (
                        <span key={i.label} className="w-row w-faint w-small" style={{ gap: 4 }} title={`Read through ${i.via}`}>
                          via {i.via}: {chip(i.label)}
                        </span>
                      ))}
                      {candidates.length > 0 && (
                        <AddRead
                          label={l.name}
                          candidates={candidates.map((c) => ({ name: c.name, widens: wideningWords(l.name, c.name, labels, readGrants) }))}
                        />
                      )}
                    </div>
                  )}
                </td>
                <td className="w-num">
                  {isOpenLabel(l.name, layers) && layers.split ? (
                    <span className="w-muted" style={{ whiteSpace: "nowrap" }}>Anyone</span>
                  ) : l.name === layers.base ? (
                    <span className="w-muted" style={{ whiteSpace: "nowrap" }}>Every member</span>
                  ) : (
                    <Readers label={l.name} labels={labels} grants={readGrants} />
                  )}
                </td>
                <td>
                  {isWorkableLabel(l.name, layers) || l.name !== layers.public_graph ? (
                    <UpkeepCell label={l.name} state={generalAt(l.name)} />
                  ) : (
                    <span className="w-faint w-small" title="The public graph's material is kept up on the public graph">
                      No work is done here
                    </span>
                  )}
                </td>
                <td className="w-num w-muted" style={{ whiteSpace: "nowrap" }}>{shortDay(l.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {ownLabels.length === 0 ? (
        <Empty>The only label is {layers.base}, so every member can read everything here. Add a label for material that is not for everyone.</Empty>
      ) : (
        <Section
          title="Provider clearance"
          id="providers"
          aside={
            <span className="w-row" style={{ gap: 8 }}>
              <Tip>
                Text at a label reaches a model provider or outside service only if it is cleared for that label. The public graph&apos;s own material is cleared for every provider; a label you add is cleared for none until someone ticks one. Each one ticked is sent the text of every agent run at the label. Each change is logged and in force within seconds, with no restart.
              </Tip>
              {clearance &&
                (clearance.fixed_by_settings ? (
                  <Pill tone="neu" title="PROVIDER_LABELS, or [provider_labels] in the config file">
                    Fixed by PROVIDER_LABELS
                  </Pill>
                ) : (
                  <Pill tone="info">Set on this page</Pill>
                ))}
            </span>
          }
        >
          {clearance === null ? (
            <Empty>What each label may be sent to could not be read just now.</Empty>
          ) : (
            <>
              <ClearanceMatrix
                editable={clears}
                publicRow={{
                  chip: chip(layers.public_graph),
                  cleared: clearance.public_graph?.cleared ?? clearance.providers.map((p) => p.name),
                  worksHere: clearance.public_graph?.works_here ?? true,
                }}
                providers={clearance.providers.map(
                  (p): MatrixProvider => ({
                    name: p.name,
                    heading: heading(p.name),
                    kind: p.kind,
                    description: p.description,
                    configured: p.configured,
                  })
                )}
                rows={ownLabels.map((l) => {
                  const f = facts.get(l.name);
                  return {
                    label: l.name,
                    chip: chip(l.name),
                    cleared: clearedFor.get(l.name) ?? [],
                    problem: f ? problemLine(f) : null,
                  };
                })}
              />
              <div className="w-labels-legend">
                {clears && (
                  <span>
                    <span className="w-labels-swatch" aria-hidden />
                    Changed, not saved
                  </span>
                )}
                <span className="w-faint">A column in grey is not set up in this deployment.</span>
                {clearance.fixed_by_settings ? (
                  <span className="w-spacer">
                    Fixed by the deployment&rsquo;s <code className="w-mono">PROVIDER_LABELS</code> setting: whoever runs it changes it there.
                  </span>
                ) : (
                  !can(who, "clear_providers") && (
                    <span className="w-spacer">Changing it takes the permission to clear providers, which you don&rsquo;t hold.</span>
                  )
                )}
              </div>
            </>
          )}
        </Section>
      )}

      {drawer === "add" && (
        <Drawer title="Add label" close={PAGE}>
          {ownLabels.length === 0 && (
            <Banner tone="warn">
              <span>
                The first label besides public makes the database hold every reader and run to their labels; it takes about ten seconds.{" "}
                <Tip>
                  From then on the deployment is treated as holding private material, and the checks on Health that protect it must pass before agent work starts. Defining it takes about ten seconds while every running process is given time to notice.
                </Tip>
              </span>
            </Banner>
          )}
          <WorkForm action={defineLabelAction} submit="Add label" primary extra={<Link href={PAGE} className="w-btn w-ghost">Cancel</Link>}>
            <div className="w-field">
              <label htmlFor="label-name">Name</label>
              <input id="label-name" className="w-input w-mono" name="name" required pattern="[a-z][a-z0-9_\-]{0,62}" autoComplete="off" />
              <span className="w-row" style={{ gap: 10 }}>
                <span className="w-help">Lower-case letters, digits, - and _, starting with a letter.</span>
                <Lock>Can&rsquo;t be changed</Lock>
              </span>
            </div>
            <div className="w-field">
              <label htmlFor="label-purpose">Purpose</label>
              <input id="label-purpose" className="w-input" name="description" required maxLength={500} autoComplete="off" />
              <span className="w-help">Shown to everyone who reads at it.</span>
            </div>
            {readable.length > 0 && (
              <div className="w-field">
                <span className="w-label">
                  Its holders may also read{" "}
                  {layers.split && (
                    <Tip>
                      {`Every label reads the public graph and what this organization has published. ${layers.base} is what every member reads: it is ticked because a label nearly always builds on it, and can be unticked for a label that should see none of the members' material.`}
                    </Tip>
                  )}
                </span>
                <div className="w-row" style={{ gap: 14 }}>
                  {[...readable]
                    .sort((a, b) => byLayerThenName(layers)(a.name, b.name))
                    .map((l) => (
                      <label key={l.name} className="w-check">
                        <input type="checkbox" name="reads" value={l.name} defaultChecked={layers.split && l.name === layers.base} />
                        {chip(l.name)}
                      </label>
                    ))}
                </div>
              </div>
            )}
            {clears && (
              <div className="w-field">
                <span className="w-label">
                  Its text may be sent to{" "}
                  <Tip>
                    Nothing is ticked: a label is served by no model provider or outside service until one is cleared for it. Each one ticked is sent the text of every agent run at the label. This can be changed later in Provider clearance.
                  </Tip>
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" }}>
                  {offered.map((p) => (
                    <label key={p.name} className="w-check" title={p.description}>
                      <input type="checkbox" name="providers" value={p.name} />
                      <span>
                        {heading(p.name)}
                        {!p.configured && <span className="w-faint"> · not set up</span>}
                      </span>
                      <input type="hidden" name="offered" value={p.name} />
                    </label>
                  ))}
                </div>
                <label className="w-check">
                  <input type="checkbox" name="same_as_public" />
                  <span>
                    Every one above <span className="w-faint">· as the public graph&rsquo;s own material is</span>
                  </span>
                </label>
              </div>
            )}
            <span className="w-help">
              Nobody reads at a new label until it is granted on <Link href="/admin/people">People</Link>.
            </span>
          </WorkForm>
        </Drawer>
      )}
    </WorkPage>
  );
}

/** Who reads at a label, through every label that reads it; how, on hover (lib/label-chain.ts). */
function Readers({ label, labels, grants }: { label: string; labels: LabelView[]; grants: GrantView[] }) {
  const { direct, through, all } = readersOf(label, labels, grants);
  const via = through.filter((t) => holdersCount(t.holders) > 0);
  const tip =
    `${capitalised(holdersText({ accounts: direct.accounts.size, groups: direct.groups.size }))} granted read at ${label}.` +
    (via.length > 0
      ? ` Also reading it, through the labels that read ${label}: ${via.map((t) => `${holdersInWords(t.holders)} (at ${t.label})`).join("; ")}.`
      : "");
  return (
    <span className="w-row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "nowrap" }}>
      <Link href="/admin/people" style={{ color: "var(--w-ink)" }}>
        {holdersCount(all).toLocaleString("en-GB")}
      </Link>
      <Tip>{tip}</Tip>
    </span>
  );
}

/** What adding "label reads candidate" would widen, in one line for the add form. */
function wideningWords(label: string, candidate: string, labels: LabelView[], grants: GrantView[]): string {
  const widened = wideningOf(label, candidate, labels, grants);
  if (widened.length === 0) return `${label} already reads ${candidate} through another label: this adds nobody.`;
  return widened
    .map((w) =>
      holdersCount(w.holders) === 0
        ? `${capitalised(w.label)} becomes readable at ${label}, by nobody granted yet.`
        : `Gives ${holdersInWords(w.holders)} read at ${w.label}.`,
    )
    .join(" ");
}

/**
 * What cannot be served at a label as it is cleared now, in one line: the
 * checklist's facts about it, without the one that only lists what is cleared.
 */
function problemLine(label: SetupChecklist["labels"][number]): string | null {
  const said = labelClearanceFacts(label).filter((f) => !f.startsWith(`${label.name}: cleared for `));
  return said.length > 0 ? said.join(" ") : null;
}

type GeneralState =
  | { kind: "set_up"; mandate: StandingMandateState }
  | { kind: "none" }
  | { kind: "not_read" }
  | { kind: "unknown" };

// Whether a General mandate is set up at each label, as the setup checklist
// says: at the labels the reader reads, where the deployment holds more than
// one. A label the reader does not read is not answered for here.
function generalMandateAt(checklist: SetupChecklist | null, layers: LabelLayers): (label: string) => GeneralState {
  const general = checklist?.standing_mandates.find((m) => m.name === "general");
  return (label) => {
    if (!general) return { kind: "unknown" };
    if (general.by_label) {
      const at = general.by_label.find((l) => l.label === label);
      if (!at) return { kind: "not_read" };
      return at.mandate ? { kind: "set_up", mandate: at.mandate } : { kind: "none" };
    }
    if (label === layers.base) return general.mandate ? { kind: "set_up", mandate: general.mandate } : { kind: "none" };
    return { kind: "not_read" };
  };
}

/** The state of a General mandate, as a pill: also used on Budget. */
function mandatePill(m: StandingMandateState): { tone: Tone; text: string } {
  if (m.running) return { tone: "ok", text: "Running" };
  if (m.budget_owls <= 0) return { tone: "warn", text: "No budget" };
  return { tone: "warn", text: "Not running" };
}

function UpkeepCell({ label, state }: { label: string; state: GeneralState }) {
  const at = `/admin/budget#general-${label}`;
  switch (state.kind) {
    case "set_up": {
      const pill = mandatePill(state.mandate);
      return (
        <Link href={at} style={{ textDecoration: "none" }} title={`The General mandate at ${label}`}>
          <Pill tone={pill.tone}>{pill.text}</Pill>
        </Link>
      );
    }
    case "none":
      return (
        <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
          <Pill tone="warn" title="Nothing pays for upkeep or audits at this label">
            Not set up
          </Pill>
          <ButtonLink href={`/admin/budget?drawer=general&label=${encodeURIComponent(label)}`} small>
            Set up
          </ButtonLink>
        </span>
      );
    case "not_read":
      return (
        <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
          <span className="w-faint w-small">Not shown</span>
          <Tip>{`You don't read ${label}. An administrator who reads it sees its General mandate on Budget.`}</Tip>
        </span>
      );
    default:
      return <span className="w-faint w-small">Could not be read</span>;
  }
}
