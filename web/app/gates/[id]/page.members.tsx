import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Banner,
  Boundary,
  ButtonLink,
  Card,
  Drawer,
  Empty,
  Kv,
  Lbl,
  Lock,
  Party,
  Pill,
  Section,
  Table,
  Tabs,
  Tip,
  WorkHead,
  WorkPage,
  plural,
  shortDay,
} from "@/components/work/ui";
import type { MandateListRow } from "@/lib/account-api";
import { fetchClaimTexts } from "@/lib/api";
import { fetchPolicy, fetchPolicyVersions, type Gate, type Gates, type GateSetting, type PolicyFull, type PolicySummary } from "@/lib/inside-api";
import { capital } from "@/lib/inside-words";
import { british } from "@/lib/outside-api";
import { addRuleAction, endRuleAction, gateSettingsAction, savePolicyVersionAction } from "../actions";
import {
  KIND_SHORT,
  MODES,
  SCOPE_SHORT,
  hoursShort,
  kindName,
  loadBoundaries,
  oldestHours,
  readableMandates,
  shortHash,
  waitingOn,
  type BoundaryRow,
} from "../boundaries";
import { PolicyEditor } from "./PolicyEditor";
import "../gates.css";

export const metadata: Metadata = { title: "Boundary · Minerval" };
export const dynamic = "force-dynamic";

// One boundary: its gate and its redaction policy (docs/the-gate.md). What
// waits at the gate, in counts; the rules that set how the gate treats each
// kind of thing, and the drawer that adds one; the policy the Redactor works
// under, edited as the next version by an administrator who reads the label
// the pages are written at; and what the gate as a whole is set to. A person
// sees the tabs of what they may see: the backlog only, the policy only, or
// all of it.

type Tab = "waiting" | "rules" | "policy" | "settings";

export default async function BoundaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    drawer?: string;
    policy?: string;
    version?: string;
    saved?: string;
  }>;
}) {
  const who = await viewer();
  if (!who) return null;
  const { id } = await params;
  const sp = await searchParams;
  const { rows, gates, backlog } = await loadBoundaries(who.externalId);
  const row = rows.find((r) => r.id === id);
  if (!row) notFound();
  const gate = row.gate;

  const available: Tab[] = [
    ...(row.backlog || gate ? (["waiting"] as const) : []),
    ...(gate ? (["rules"] as const) : []),
    ...(row.policy ? (["policy"] as const) : []),
    ...(gate ? (["settings"] as const) : []),
  ];
  const fallback: Tab = gate ? "rules" : row.backlog ? "waiting" : "policy";
  const tab: Tab = available.includes(sp.tab as Tab) ? (sp.tab as Tab) : fallback;
  const base = `/gates/${id}`;
  const maySet = !!gate && (gate.you_may_set.the_gate_as_a_whole || gate.you_may_set.for_parties.length > 0);
  const drawer = tab === "rules" && sp.drawer === "rule" && maySet;

  const lines = row.backlog?.waiting ?? [];
  const forPeople = waitingOn(lines, "people");

  // Names for what the rules point at, and the mandates a rule or the gate may be set to.
  const needsMandates = !!gate && (tab === "rules" || tab === "settings");
  const mandates = needsMandates ? await readableMandates(who.externalId) : [];
  const nodeIds =
    tab === "rules" && gate ? [...new Set(gate.settings.filter((s) => s.scope === "under" && s.scope_ref).map((s) => s.scope_ref!))] : [];
  const nodes = nodeIds.length > 0 ? await fetchClaimTexts(nodeIds).catch(() => new Map<string, string>()) : new Map<string, string>();

  return (
    <WorkPage wide>
      <WorkHead
        crumbs={[{ href: "/gates", label: "Boundaries" }]}
        title={
          <span className="w-gates-title">
            <Boundary from={row.from} to={row.to} />
          </span>
        }
        sub={[
          gate ? (gate.flow === "everything" ? "Everything" : "Asked for") : null,
          row.backlog ? `${row.backlog.items_waiting} waiting` : null,
          lines.length > 0 ? `oldest ${hoursShort(oldestHours(lines))}` : null,
          row.policy ? `policy v${row.policy.version}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            {forPeople > 0 && <ButtonLink href="/gate">{`Review ${forPeople}`}</ButtonLink>}
            {maySet && tab !== "policy" && tab !== "settings" && (
              <ButtonLink href={`${base}?tab=rules&drawer=rule`} primary icon="plus">
                Add rule
              </ButtonLink>
            )}
          </>
        }
      />

      {available.length > 1 && (
        <Tabs
          current={tab}
          tabs={available.map((t) => ({
            key: t,
            href: `${base}?tab=${t}`,
            label: t === "waiting" ? "Waiting" : t === "rules" ? "Rules" : t === "policy" ? `Policy v${row.policy!.version}` : "Settings",
            count: t === "waiting" ? (row.backlog?.items_waiting ?? 0) : t === "rules" ? gate!.settings.length : undefined,
          }))}
        />
      )}

      {tab === "waiting" && <Waiting row={row} note={backlog?.note} />}
      {tab === "rules" && gate && gates && <Rules gate={gate} gates={gates} mandates={mandates} nodes={nodes} />}
      {tab === "policy" && (
        <PolicyTab row={row} administers={can(who, "administer")} externalId={who.externalId} asked={sp.policy} version={sp.version} saved={sp.saved === "1"} />
      )}
      {tab === "settings" && gate && gates && <Settings gate={gate} gates={gates} mandates={mandates} />}

      {drawer && gate && gates && (
        <Drawer title="Add rule" close={`${base}?tab=rules`}>
          <RuleForm gate={gate} gates={gates} mandates={mandates} from={row.from} />
        </Drawer>
      )}
    </WorkPage>
  );
}

// ---- waiting -------------------------------------------------------------

function Waiting({ row, note }: { row: BoundaryRow; note?: string }) {
  const lines = row.backlog?.waiting ?? [];
  return (
    <Section
      title="Waiting"
      aside={
        <>
          {note && <Tip>{note}</Tip>} {plural(row.backlog?.items_waiting ?? 0, "item")}
        </>
      }
    >
      {!row.gate && (
        <div className="w-help">
          {row.from ? "" : "From a label you do not read. "}You are shown how much waits and on whom, and nothing of what it says.
        </div>
      )}
      {lines.length === 0 ? (
        <Card>
          <Empty>Nothing waits at this boundary.</Empty>
        </Card>
      ) : (
        <Table label="Waiting">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Waiting on</th>
              <th>Party</th>
              <th className="w-num">Items</th>
              <th className="w-num">Parts</th>
              <th className="w-num">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td title={capital(l.kind_in_words)}>{kindName(l.kind)}</td>
                <td>{capital(l.in_words)}</td>
                <td>{l.party ? <Party name={l.party} /> : <span className="w-faint">—</span>}</td>
                <td className="w-num">{l.items}</td>
                <td className="w-num">{l.parts ?? <span className="w-faint">—</span>}</td>
                <td className="w-num">{hoursShort(l.oldest_waiting_hours)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

// ---- rules ---------------------------------------------------------------

function ModePill({ mode, modes }: { mode: string; modes?: Record<string, string> }) {
  const m = MODES[mode];
  return (
    <Pill tone={m?.tone ?? "neu"} title={modes?.[mode]}>
      {m?.label ?? capital(mode)}
    </Pill>
  );
}

function mayEnd(gate: Gate, s: GateSetting): boolean {
  return s.party ? gate.you_may_set.for_parties.some((p) => p.id === s.party!.id) : gate.you_may_set.the_gate_as_a_whole;
}

function Rules({ gate, gates, mandates, nodes }: { gate: Gate; gates: Gates; mandates: MandateListRow[]; nodes: Map<string, string> }) {
  const kinds = Object.keys(gate.starting_positions);
  const half = Math.ceil(kinds.length / 2);
  const tally = Object.entries(
    Object.values(gate.starting_positions).reduce<Record<string, number>>((t, m) => ({ ...t, [m]: (t[m] ?? 0) + 1 }), {})
  )
    .map(([m, n]) => `${n} ${MODES[m]?.label ?? m}`)
    .join(" · ");
  const ruleNumbers = (kind: string) => gate.settings.map((s, i) => (s.kind === kind ? i + 1 : 0)).filter((n) => n > 0);

  const positions = (part: string[]) => (
    <table className="w-t">
      <thead>
        <tr>
          <th>Kind</th>
          <th>Starting position</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {part.map((k) => {
          const ns = ruleNumbers(k);
          return (
            <tr key={k}>
              <td title={capital(gates.kinds[k] ?? k)}>{kindName(k, gates.kinds)}</td>
              <td>
                <ModePill mode={gate.starting_positions[k]} modes={gates.modes} />
              </td>
              <td className="w-faint w-small">{ns.length > 0 ? `rule ${ns.join(", ")}` : ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <>
      <section className="w-card">
        <div className="w-card-h">
          <span className="w-row" style={{ gap: 6 }}>
            Starting positions <Tip>How the gate treats each kind of thing until a rule says otherwise. The same at every boundary.</Tip>
          </span>
          <span className="w-spacer w-muted w-small" style={{ fontWeight: 400 }}>
            {tally}
          </span>
        </div>
        <div className="w-gates-split">
          {positions(kinds.slice(0, half))}
          {positions(kinds.slice(half))}
        </div>
      </section>

      <Section
        title="Rules"
        aside={gate.settings.length === 0 ? "none: every kind at its starting position" : `${gate.settings.length} in force`}
        actions={
          <span className="w-muted w-small w-row" style={{ gap: 6 }}>
            <Tip>
              Precedence, in order: a rule for one party&apos;s material beats a boundary-wide one; the narrowest scope that covers an item
              wins (request, then a node and what is under it, then mandate, then the whole boundary); a rule for one kind beats one for
              Everything.
            </Tip>
            Party rules beat boundary-wide ones; narrower scope wins; a specific kind beats Everything.
          </span>
        }
      >
        {gate.settings.length > 0 && (
          <Table label="Rules">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>For</th>
                <th>Scope</th>
                <th>Party</th>
                <th>Mode</th>
                <th>Timing</th>
                <th>Set by</th>
                <th className="w-act" />
              </tr>
            </thead>
            <tbody>
              {gate.settings.map((s, i) => (
                <tr key={s.setting_id}>
                  <td className="w-faint">{i + 1}</td>
                  <td title={s.kind === "*" ? "Every kind of thing" : capital(gates.kinds[s.kind] ?? s.kind)}>
                    {kindName(s.kind, gates.kinds)}
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    <Scope setting={s} mandates={mandates} nodes={nodes} />
                  </td>
                  <td>{s.party ? <Party name={s.party.name} /> : <span className="w-muted">Any party</span>}</td>
                  <td>
                    <ModePill mode={s.mode} modes={gates.modes} />
                  </td>
                  <td>
                    {[(s.delay_hours ?? 0) > 0 && `Held ${s.delay_hours}h`, (s.batch_hours ?? 0) > 0 && `batched every ${s.batch_hours}h`]
                      .filter(Boolean)
                      .join(", ")
                      .replace(/^b/, "B") || <span className="w-faint">—</span>}
                  </td>
                  <td>
                    {s.set_by ? (
                      <span title={s.set_holding.length > 0 ? `holding ${s.set_holding.join(", ")}` : undefined}>{s.set_by}</span>
                    ) : s.made_from_release_rule ? (
                      <span className="w-chip" title={s.made_from_release_rule}>
                        Release rule
                      </span>
                    ) : (
                      <span className="w-muted">The deployment</span>
                    )}{" "}
                    <span className="w-faint">· {shortDay(s.set_at)}</span>
                  </td>
                  <td className="w-act">
                    {mayEnd(gate, s) && (
                      <WorkForm action={endRuleAction} submit="End rule" inline danger>
                        <input type="hidden" name="setting_id" value={s.setting_id} />
                      </WorkForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );
}

function Scope({ setting: s, mandates, nodes }: { setting: GateSetting; mandates: MandateListRow[]; nodes: Map<string, string> }) {
  if (s.scope === "boundary" || !s.scope_ref) return <span className="w-muted">{SCOPE_SHORT[s.scope] ?? capital(s.scope_in_words)}</span>;
  const ref = s.scope_ref;
  let named = <span className="w-mono w-small">{ref.slice(0, 8)}</span>;
  if (s.scope === "mandate") {
    const m = mandates.find((x) => x.id === ref);
    named = <Link href={`/mandates/${ref}`}>{m ? m.title : <span className="w-mono w-small">{ref.slice(0, 8)}</span>}</Link>;
  } else if (s.scope === "under") {
    const text = nodes.get(ref);
    named = (
      <Link href={`/claims/${ref}`}>
        {text ? <span className="w-node w-sm">{text}</span> : <span className="w-mono w-small">{ref.slice(0, 8)}</span>}
      </Link>
    );
  }
  return (
    <span title={`${capital(s.scope_in_words)} (${ref})`}>
      <span className="w-muted w-small">{SCOPE_SHORT[s.scope] ?? capital(s.scope)}</span> {named}
    </span>
  );
}

function RuleForm({ gate, gates, mandates, from }: { gate: Gate; gates: Gates; mandates: MandateListRow[]; from: string | null }) {
  const atFrom = mandates.filter((m) => !m.label || m.label === gate.from);
  const whole = gate.you_may_set.the_gate_as_a_whole;
  const only = !whole && gate.you_may_set.for_parties.length === 1 ? gate.you_may_set.for_parties[0] : null;
  return (
    <WorkForm
      action={addRuleAction}
      submit="Add rule"
      primary
      extra={
        <Link className="w-btn w-ghost" href={`/gates/${gate.gate_id}?tab=rules`} scroll={false}>
          Cancel
        </Link>
      }
    >
      <input type="hidden" name="gate_id" value={gate.gate_id} />
      <div className="w-row w-muted w-small" style={{ marginTop: -6 }}>
        <Boundary from={from} to={gate.to_outside ? "outside" : gate.to} />
      </div>
      <fieldset className="w-field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend
          className="w-label"
          style={{
            fontWeight: 500,
            fontSize: 12.5,
            marginBottom: 6,
            padding: 0,
          }}
        >
          Mode
        </legend>
        <div className="w-options">
          {Object.keys(gates.modes).map((mode) => (
            <label className="w-option" key={mode} title={gates.modes[mode]}>
              <input type="radio" name="mode" value={mode} required />
              <span style={{ fontSize: "inherit", color: "inherit" }}>
                <b>{MODES[mode]?.label ?? capital(mode)}</b>
                <span>{MODES[mode]?.line ?? gates.modes[mode]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="w-gates-pair">
        <div className="w-field">
          <label htmlFor="r-kind">Applies to</label>
          <select id="r-kind" className="w-select" name="kind" defaultValue="*">
            <option value="*">Everything</option>
            {Object.keys(gates.kinds).map((k) => (
              <option key={k} value={k}>
                {KIND_SHORT[k] ?? capital(gates.kinds[k])}
              </option>
            ))}
          </select>
        </div>
        <div className="w-field">
          <label htmlFor="r-party">Party</label>
          <select id="r-party" className="w-select" name="party_id" defaultValue={whole ? "" : (gate.you_may_set.for_parties[0]?.id ?? "")}>
            {whole && <option value="">Any party</option>}
            {gate.you_may_set.for_parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="w-field">
        <span className="w-label">Scope</span>
        <div className="w-seg w-gates-seg" role="radiogroup" aria-label="Scope">
          {(["boundary", "mandate", "under", "request"] as const).map((sc) => (
            <label key={sc} title={capital(gates.scopes[sc] ?? sc)}>
              <input type="radio" name="scope" value={sc} defaultChecked={sc === "boundary"} />
              {SCOPE_SHORT[sc]}
            </label>
          ))}
        </div>
      </div>
      <div className="w-field w-gates-ref w-gates-ref-mandate">
        <label htmlFor="r-mandate">Mandate</label>
        {atFrom.length > 0 ? (
          <select id="r-mandate" className="w-select" name="scope_ref_mandate" defaultValue="">
            <option value="" disabled>
              Choose a mandate
            </option>
            {atFrom.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.label ? ` · ${m.label}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <input id="r-mandate" className="w-input w-mono" name="scope_ref_mandate" placeholder="The mandate's id" />
        )}
        <span className="w-help">Everything this mandate&apos;s work produced.</span>
      </div>
      <div className="w-field w-gates-ref w-gates-ref-under">
        <label htmlFor="r-node">Node</label>
        <input id="r-node" className="w-input w-mono" name="scope_ref_node" placeholder="The node's id" />
        <span className="w-help">The id from the node&apos;s address; the rule covers it and everything under it.</span>
      </div>
      <div className="w-field w-gates-ref w-gates-ref-request">
        <label htmlFor="r-request">Request</label>
        <input id="r-request" className="w-input w-mono" name="scope_ref_request" placeholder="The request's id" />
        <span className="w-help">The id of one request taken up here.</span>
      </div>
      <div className="w-gates-pair">
        <div className="w-field">
          <label htmlFor="r-hold">Hold for (hours)</label>
          <input id="r-hold" className="w-input" type="number" name="delay_hours" min="0" max="2160" step="1" placeholder="0" />
        </div>
        <div className="w-field">
          <label htmlFor="r-batch">Batch every (hours)</label>
          <input id="r-batch" className="w-input" type="number" name="batch_hours" min="0" max="2160" step="1" placeholder="0" />
        </div>
      </div>
      <div className="w-help" style={{ marginTop: -8 }}>
        So arrival time does not tell when a thing was made{" "}
        <Tip>
          Hold keeps each item back for a time; batching then sends what is ready together, every so many hours. Left empty, neither.
        </Tip>
      </div>
      {only && <div className="w-help">You hold release for {only.name}: a rule you add is for its material.</div>}
      {gate.to_outside && <Lock>Changes show publicly, with their date, on each mandate your organisation has published</Lock>}
    </WorkForm>
  );
}

// ---- policy --------------------------------------------------------------

async function PolicyTab({
  row,
  administers,
  externalId,
  asked,
  version,
  saved,
}: {
  row: BoundaryRow;
  administers: boolean;
  externalId: string;
  /** A version by its id (`?policy=<id>`), as a showing's record links to it. */
  asked?: string;
  /** A version by its number (`?version=N`), as the versions rail links to it. */
  version?: string;
  saved: boolean;
}) {
  const summary = row.policy!;
  const versions: PolicySummary[] = await fetchPolicyVersions(externalId, row.id).catch(() => [summary]);
  const listed = versions.length > 0 ? versions : [summary];
  const inForceRow = listed.find((v) => v.in_force) ?? listed[0];
  const byNumber = version && /^\d+$/.test(version) ? listed.find((v) => v.version === Number(version)) : undefined;
  const askedId = byNumber?.policy_id ?? (asked && !listed.some((v) => v.policy_id === asked && v.in_force) ? asked : undefined);
  const [inForce, older] = await Promise.all([
    fetchPolicy(externalId, inForceRow.policy_id).catch(() => null),
    askedId && askedId !== inForceRow.policy_id ? fetchPolicy(externalId, askedId).catch(() => null) : null,
  ]);
  if (!inForce) return <Banner tone="warn">The policy could not be read just now.</Banner>;
  const viewing: PolicyFull = older && older.boundary_id === row.id && older.version !== inForce.version ? older : inForce;
  const current = viewing === inForce;
  const mayEdit = current && administers && !!summary.from_label;
  const base = `/gates/${row.id}?tab=policy`;
  const savedBy = (v: { saved_by: string | null; starting_text: boolean }) =>
    v.saved_by ?? (v.starting_text ? "Starting text" : "The system");

  return (
    <div className="w-grid2">
      <div className="w-col" style={{ gap: 12, minWidth: 0 }}>
        {saved && current && <Banner tone="ok">Saved as version {inForce.version}. It is in force at this boundary from now.</Banner>}
        {!current && (
          <Banner>
            You are reading version {viewing.version}, an earlier one. <Link href={base}>Version {inForce.version}</Link> is in force.
          </Banner>
        )}
        <div className="w-sec-h">
          <h2>Categories</h2>
          <span className="w-muted">
            {viewing.categories.length}
            {mayEdit ? ` · editing v${viewing.version}` : ""}
          </span>
          <Tip>
            The Redactor removes the passages a category covers and leaves its mark where each stood. Everyone on the other side reads the
            whole policy; Audit reads every removal.
          </Tip>
        </div>
        {mayEdit ? (
          <PolicyEditor
            key={inForce.policy_id}
            action={savePolicyVersionAction}
            gateId={row.id}
            fromLabel={summary.from_label!}
            to={row.outside ? "outside" : row.to}
            version={inForce.version}
            categories={inForce.categories}
          />
        ) : (
          <>
            <div className="w-help">
              {!current
                ? "An earlier version is not changed; the next version is saved from the one in force."
                : !administers
                  ? "A new version is saved by an administrator who reads the label the pages are written at."
                  : "You do not read the label these pages are written at, so you cannot save a version here; an administrator who reads it can."}
            </div>
            {viewing.categories.length === 0 ? (
              <Card>
                <Empty>No categories: nothing is removed at this boundary.</Empty>
              </Card>
            ) : (
              <Table label="Categories">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Covers</th>
                    <th>Examples</th>
                  </tr>
                </thead>
                <tbody>
                  {viewing.categories.map((c, i) => (
                    <tr key={i}>
                      <td className="w-top" style={{ width: "30%" }}>
                        <div>{c.name}</div>
                        <span className="w-mono w-faint w-small">[redacted: {c.name}]</span>
                      </td>
                      <td className="w-top">{c.covers}</td>
                      <td className="w-top w-muted">{c.examples || <span className="w-faint">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
        <div className="w-gates-fixed">
          <Lock>
            <span className="w-muted">
              How removal works and what is always shown are written by the system, the same at every boundary
            </span>
          </Lock>
          <details>
            <summary>Full policy text</summary>
            <pre className="w-code">{viewing.text}</pre>
          </details>
        </div>
      </div>

      <aside className="w-col" style={{ gap: 14 }}>
        <Card
          flush
          title={
            <span className="w-row" style={{ gap: 6 }}>
              Versions <span className="w-faint">{listed.length}</span>{" "}
              <Tip>
                Saving makes a new version, in force from then. Earlier versions stay on record, and a removal keeps the version it was made
                under. A version the system saved is the starting text, or the same categories saved again because the sections every
                version shares were reworded.
              </Tip>
            </span>
          }
        >
          <div className="w-gates-versions">
            {listed.map((v) => (
              <Link
                key={v.policy_id}
                className="w-gates-ver"
                href={v.in_force ? base : `${base}&version=${v.version}`}
                aria-current={v.version === viewing.version ? "page" : undefined}
              >
                <b>v{v.version}</b>
                <span className="w-row" style={{ gap: 8 }}>
                  {v.in_force && <Pill tone="ok">In force</Pill>}
                  <span className="w-small w-muted">{shortDay(v.saved_at)}</span>
                </span>
                <span />
                <span className="w-small w-muted">
                  {savedBy(v)}{" "}
                  <span className="w-mono w-faint" title={v.hash}>
                    · {shortHash(v.hash)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </Card>
        <div className="w-gates-kv">
          <Kv
            rows={[
              [
                "Read by",
                <span className="w-row" style={{ gap: 6 }} key="r">
                  {row.outside ? (
                    "Everyone outside"
                  ) : (
                    <>
                      Everyone at <Lbl name={row.to} />
                    </>
                  )}
                  <Tip>
                    The policy in force is read in full by everyone a page is shown to across this boundary; a page shown outside carries
                    the whole text with it.
                  </Tip>
                </span>,
              ],
              [
                `v${viewing.version} saved by`,
                <span key="b">
                  {savedBy(viewing)} <span className="w-faint">· {shortDay(viewing.saved_at)}</span>
                </span>,
              ],
              [
                "Who saves",
                <span className="w-row" style={{ gap: 6 }} key="s">
                  Administrators who read {row.from ? <Lbl name={row.from} /> : "the label it is written at"}
                </span>,
              ],
              [
                "Fingerprint",
                <span className="w-mono w-small" style={{ wordBreak: "break-all" }} key="h">
                  {viewing.hash}
                </span>,
              ],
            ]}
          />
        </div>
      </aside>
    </div>
  );
}

// ---- settings ------------------------------------------------------------

function Settings({ gate, gates, mandates }: { gate: Gate; gates: Gates; mandates: MandateListRow[] }) {
  const atFrom = mandates.filter((m) => m.label === gate.from);
  const current = gate.keep_current_mandate;
  const named = current ? mandates.find((m) => m.id === current) : undefined;
  const facts = (
    <div className="w-gates-kv">
      <Kv
        rows={[
          ["Flow", <span key="f">{gate.flow_in_words}</span>],
          ["Backlog", gate.backlog_shown_to_the_other_side ? "Shown to the other side, in counts" : "Kept to the gate's authorities"],
          gate.to_outside && ["Sending", gate.send_as_released ? "Automatic, as it is released" : "By a person, package by package"],
          [
            "Keeping current",
            <span key="k">
              {british(gate.keeps_the_other_side_current)}
              {named && (
                <>
                  {" "}
                  <Link href={`/mandates/${named.id}`}>{named.title}</Link>
                </>
              )}
            </span>,
          ],
        ]}
      />
    </div>
  );
  if (!gate.you_may_set.the_gate_as_a_whole) {
    return (
      <Card title="Settings">
        {facts}
        <div className="w-help" style={{ marginTop: 10 }}>
          The gate as a whole is set by an administrator.
        </div>
      </Card>
    );
  }
  return (
    <div className="w-grid2">
      <Card>
        <WorkForm action={gateSettingsAction} submit="Save" primary>
          <input type="hidden" name="gate_id" value={gate.gate_id} />
          {gate.to_outside && <input type="hidden" name="outside" value="yes" />}
          <fieldset className="w-field" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend
              className="w-label"
              style={{
                fontWeight: 500,
                fontSize: 12.5,
                marginBottom: 6,
                padding: 0,
              }}
            >
              Flow
            </legend>
            <div className="w-options">
              <label className="w-option" title={gates.flows.asked}>
                <input type="radio" name="flow" value="asked" defaultChecked={gate.flow === "asked"} />
                <span style={{ fontSize: "inherit", color: "inherit" }}>
                  <b>Asked for</b>
                  <span>Answers, that a request was taken up, and pages set to flow on Showings</span>
                </span>
              </label>
              <label className="w-option" title={gates.flows.everything}>
                <input type="radio" name="flow" value="everything" defaultChecked={gate.flow === "everything"} />
                <span style={{ fontSize: "inherit", color: "inherit" }}>
                  <b>Everything</b>
                  <span>Every finished page at {gate.from} and each mandate&apos;s terms, paid by the work that made them</span>
                </span>
              </label>
            </div>
          </fieldset>
          <label className="w-check">
            <input type="checkbox" name="backlog_shown" defaultChecked={gate.backlog_shown_to_the_other_side} />
            <span>Show the other side how much waits here, in counts</span>
          </label>
          {gate.to_outside && (
            <label className="w-check">
              <input type="checkbox" name="send_as_released" defaultChecked={gate.send_as_released === true} />
              <span>
                Send what is released to the public graph as it is released{" "}
                <Tip>With this off, a person sends each package from the Outbox.</Tip>
              </span>
            </label>
          )}
          <div className="w-field">
            <label htmlFor="g-keep">
              {gate.to_outside ? "Public mandate that keeps the public version current" : "Mandate that keeps the other side current"}{" "}
              <Tip>
                {gate.to_outside
                  ? "When a version here changes on a node the public graph holds, this public mandate, which your organisation funds there, is asked for a fresh public assessment. Each asking goes through this gate as funding, and shows outside which public nodes are worked on here and when."
                  : `When a version here changes on a node the other side has assessed, this mandate at ${gate.from} pays for a fresh assessment of the node there. Each asking goes through this gate as funding.`}
              </Tip>
            </label>
            {gate.to_outside || atFrom.length === 0 ? (
              <input
                id="g-keep"
                className="w-input w-mono"
                type="text"
                name="keep_current_mandate"
                defaultValue={current ?? ""}
                placeholder={gate.to_outside ? "The public mandate's id; empty for none" : "The mandate's id; empty for none"}
              />
            ) : (
              <select id="g-keep" className="w-select" name="keep_current_mandate" defaultValue={current ?? ""}>
                <option value="">None: nothing is asked</option>
                {current && !atFrom.some((m) => m.id === current) && <option value={current}>{named?.title ?? current}</option>}
                {atFrom.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            )}
          </div>
          {!gate.to_outside && (
            <div className="w-field">
              <label htmlFor="g-owls">Pays each time, in owls</label>
              <input
                id="g-owls"
                className="w-input w-narrow"
                type="number"
                name="keep_current_owls"
                min="0"
                step="0.01"
                defaultValue={gate.keep_current_owls ?? 0}
              />
            </div>
          )}
        </WorkForm>
      </Card>
      <aside className="w-col">
        <Card title="Now">{facts}</Card>
      </aside>
    </div>
  );
}
