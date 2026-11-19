import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Banner,
  ButtonLink,
  Card,
  Drawer,
  Empty,
  Kv,
  Lbl,
  Pill,
  Section,
  Stat,
  Stats,
  Table,
  Tabs,
  Tip,
  WorkHead,
  WorkPage,
  owls,
  plural,
  shortDay,
  shortWhen,
  type Tone,
} from "@/components/work/ui";
import { fetchAccount, listMandates, type MandateSummaryView } from "@/lib/account-api";
import {
  fetchAccounts,
  fetchCreatedOwls,
  fetchLabels,
  fetchStandingMandates,
  fetchUsageReports,
  type AccountView,
  type CreatedOwls,
  type LabelView,
  type OutgoingUsageReports,
  type StandingMandate,
  type StandingMandateState,
  type UsageReport,
} from "@/lib/admin-api";
import { words } from "@/lib/account-format";
import { createOwlsAction, sendUsageReportsAction, setUpStandingMandateAction } from "../actions";
import "./budget.css";

export const metadata: Metadata = { title: "Budget · Minerval" };
export const dynamic = "force-dynamic";

// Owls in a private deployment, on one page: what one is here, how many its
// administrators have created and where they went, what its agents' runs
// have spent, the General mandate at each label that pays for upkeep, the
// prices an owl is counted at, and what is reported to Minerval for billing.
// Every member may read all but the usage reports, because there is no
// ceiling on what an administrator may create and this page is what stands
// in a ceiling's place. Creating owls, setting up a mandate and the usage
// reports are for holders of the permission to administer.
//
// It replaces /admin/owls and /admin/usage-report, which redirect here.

const PAGE = "/admin/budget";
type TabKey = "overview" | "ledger" | "prices" | "usage";

const owlWord = (n: number) => (n === 1 ? "owl" : "owls");

// A mandate as the menu of where created owls go names it. A deployment holds
// a General mandate at each label, all titled alike, and creating owls cannot
// be taken back, so each is named with its label and its budget. The API
// lists only the mandates at labels the reader reads.
function mandateChoice(m: MandateSummaryView): string {
  const name = m.label ? `${m.title} (${m.label})` : m.title;
  return `${name}, budget ${owls(m.budget_owls)}, ${owls(m.spent_owls)} spent`;
}

/** One General mandate's row: at a label the reader reads, or one counted and not shown. */
interface GeneralRow {
  standing: StandingMandate;
  label: string;
  /** Whether the set-up form names the label: only where the deployment holds more than one. */
  namesLabel: boolean;
  mandate: StandingMandateState | null;
  shown: boolean;
}

function generalRows(standing: StandingMandate[], labels: LabelView[]): GeneralRow[] {
  const rows: GeneralRow[] = [];
  for (const s of standing) {
    if (!s.by_label) {
      rows.push({ standing: s, label: "public", namesLabel: false, mandate: s.mandate, shown: true });
      continue;
    }
    for (const at of s.by_label) rows.push({ standing: s, label: at.label, namesLabel: true, mandate: at.mandate, shown: true });
    // Labels the reader does not read are listed by name only, where the reader may list labels.
    for (const l of labels) {
      if (!s.by_label.some((at) => at.label === l.name)) {
        rows.push({ standing: s, label: l.name, namesLabel: true, mandate: null, shown: false });
      }
    }
  }
  const order = (r: GeneralRow) => (r.label === "public" ? "" : r.label);
  return rows.sort((a, b) => order(a).localeCompare(order(b)));
}

function statusOf(row: GeneralRow, spent: number | undefined): { tone: Tone; text: string } {
  if (!row.shown) return { tone: "neu", text: "Not shown" };
  const m = row.mandate;
  if (!m) return { tone: "warn", text: "Not set up" };
  if (m.running) return { tone: "ok", text: "Running" };
  if (m.budget_owls <= 0) return { tone: "warn", text: "No budget" };
  if (spent !== undefined && spent >= m.budget_owls) return { tone: "warn", text: "Budget spent" };
  return { tone: "warn", text: "Not running" };
}

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; drawer?: string; label?: string; into?: string }>;
}) {
  const who = await viewer();
  if (!who) return null;
  const administers = can(who, "administer");
  const params = await searchParams;

  const [account, standing, mandates, labels] = await Promise.all([
    fetchAccount(who.externalId),
    fetchStandingMandates(who.externalId).catch(() => [] as StandingMandate[]),
    // For what each General mandate has spent, and where created owls may go.
    listMandates().catch(() => [] as MandateSummaryView[]),
    // For the labels the reader does not read, named and not shown. Administrators only.
    administers ? fetchLabels(who.externalId).catch(() => [] as LabelView[]) : ([] as LabelView[]),
  ]);
  const createdHere = account.entitlement.owls_created_here === true;
  const [created, accounts, outgoing] = await Promise.all([
    createdHere ? fetchCreatedOwls(who.externalId).catch(() => null as CreatedOwls | null) : null,
    administers && createdHere
      ? fetchAccounts(who.externalId)
          .then((all) => all.filter((a) => !a.external_id?.startsWith("platform:")))
          .catch(() => [] as AccountView[])
      : ([] as AccountView[]),
    administers ? fetchUsageReports(who.externalId).catch(() => null as OutgoingUsageReports | null) : null,
  ]);
  const creates = administers && createdHere;
  const byId = new Map(mandates.map((m) => [m.id, m]));
  const rows = generalRows(standing, labels);

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: "overview", label: "Overview" },
    ...(created ? [{ key: "ledger" as const, label: "Ledger" }, { key: "prices" as const, label: "Model prices" }] : []),
    ...(outgoing ? [{ key: "usage" as const, label: "Usage reports", count: outgoing.reports.length }] : []),
  ];
  const tab: TabKey = tabs.some((t) => t.key === params.tab) ? (params.tab as TabKey) : "overview";
  const here = tab === "overview" ? PAGE : `${PAGE}?tab=${tab}`;
  const withDrawer = (q: string) => `${here}${here.includes("?") ? "&" : "?"}${q}`;
  const statement = created?.statement ?? account.entitlement.owls_statement ?? "";
  const unpriced = created?.prices.unpriced_models ?? [];

  return (
    <WorkPage>
      <WorkHead
        title="Budget"
        sub={
          <span className="w-row" style={{ gap: 6 }}>
            {createdHere ? "Private owls · 1 owl = $1 of metered cost" : "Owls are bought here · 1 owl = $1 of metered cost"}
            <Tip>
              {createdHere
                ? `${statement} These are separate from the organisation's public owls. There is no ceiling on what an administrator may create: every act is listed here with who made it, and every member may read it.`
                : "Owls here are bought, as on the public graph, and nobody creates them. A person adds to their balance from their account page."}
            </Tip>
          </span>
        }
        actions={
          creates && (
            <ButtonLink href={withDrawer("drawer=create")} primary icon="plus">
              Create owls
            </ButtonLink>
          )
        }
      />

      {unpriced.length > 0 && (
        <Banner tone="warn">
          <span>
            {plural(unpriced.length, "model")} {unpriced.length === 1 ? "has" : "have"} no price:{" "}
            {unpriced.map((m, i) => (
              <span key={m.setting}>
                {i > 0 && ", "}
                <code className="w-mono">{m.model}</code> ({m.setting})
              </span>
            ))}{" "}
            — calls to {unpriced.length === 1 ? "it" : "them"} are refused before anything is sent
          </span>
          <Pill tone="neu" title="Whoever runs the deployment states prices in its MODEL_PRICES setting">
            Operator
          </Pill>
          {tab !== "prices" && (
            <Link className="w-spacer w-small" href={`${PAGE}?tab=prices`}>
              Model prices
            </Link>
          )}
        </Banner>
      )}

      {tabs.length > 1 && (
        <Tabs
          current={tab}
          tabs={tabs.map((t) => ({ ...t, href: t.key === "overview" ? PAGE : `${PAGE}?tab=${t.key}` }))}
        />
      )}

      {tab === "overview" && (
        <Overview
          created={created}
          createdHere={createdHere}
          administers={administers}
          rows={rows}
          byId={byId}
          outgoing={outgoing}
          withDrawer={withDrawer}
        />
      )}
      {tab === "ledger" && created && <Ledger created={created} />}
      {tab === "prices" && created && <Prices created={created} />}
      {tab === "usage" && outgoing && <Usage outgoing={outgoing} />}

      {params.drawer === "create" && creates && (
        <Drawer title="Create owls" close={here}>
          <WorkForm
            action={createOwlsAction}
            submit="Create owls"
            primary
            lock="Can't be taken back"
            extra={
              <Link href={here} className="w-btn w-ghost">
                Cancel
              </Link>
            }
          >
            <div className="w-field">
              <label htmlFor="owls-amount">Amount</label>
              <input id="owls-amount" className="w-input w-narrow" name="amount_owls" type="number" min="0.01" step="any" required />
            </div>
            <div className="w-field">
              <label htmlFor="owls-into">
                Into{" "}
                <Tip>
                  Owls created into a mandate grow its budget at once. Owls created into a person's balance are theirs to put behind mandates, if they hold the permission to fund work. If a mandate closes with owls unspent, the created share returns to the deployment's own account.
                </Tip>
              </label>
              <select
                id="owls-into"
                className="w-select"
                name="recipient"
                required
                defaultValue={params.into && /^(mandate|account):[0-9a-f-]+$/i.test(params.into) ? params.into : ""}
              >
                <option value="" disabled>
                  Choose where they go
                </option>
                <optgroup label="A mandate's budget">
                  {mandates
                    .filter((m) => m.status === "active")
                    .map((m) => (
                      <option key={m.id} value={`mandate:${m.id}`}>
                        {mandateChoice(m)}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="A person's balance">
                  {accounts.map((a) => (
                    <option key={a.id} value={`account:${a.id}`}>
                      {a.display_name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="w-field">
              <label htmlFor="owls-note">Note</label>
              <input id="owls-note" className="w-input" name="note" maxLength={500} autoComplete="off" />
              <span className="w-help">What they are for. Shown with the act, in the ledger and in the log.</span>
            </div>
          </WorkForm>
        </Drawer>
      )}

      {params.drawer === "general" && administers && (
        <SetUpDrawer row={rows.find((r) => r.label === (params.label ?? "public")) ?? null} createdHere={createdHere} close={here} />
      )}
    </WorkPage>
  );
}

// ---- overview -------------------------------------------------------------

function Overview({
  created,
  createdHere,
  administers,
  rows,
  byId,
  outgoing,
  withDrawer,
}: {
  created: CreatedOwls | null;
  createdHere: boolean;
  administers: boolean;
  rows: GeneralRow[];
  byId: Map<string, MandateSummaryView>;
  outgoing: OutgoingUsageReports | null;
  withDrawer: (q: string) => string;
}) {
  const notSetUp = rows.filter((r) => r.shown && !r.mandate).length;
  const acts = created?.created.by_administrator.reduce((n, a) => n + a.acts, 0) ?? 0;
  const standing = rows[0]?.standing;
  return (
    <>
      {created && (
        <Stats>
          <Stat k="Created" v={owls(created.created.total_owls)} s={plural(acts, "act")} />
          <Stat k="Into mandates" v={owls(created.created.into_mandates_owls)} s="straight to budgets" />
          <Stat
            k={
              <>
                Into balances <Tip>For a person who holds the permission to fund work, to put behind mandates.</Tip>
              </>
            }
            v={owls(created.created.into_accounts_owls)}
            s="for funders"
          />
          <Stat
            k="Spent"
            v={owls(created.spent.total_owls)}
            s={created.spent.since ? `since ${shortDay(created.spent.since)}` : "no run metered yet"}
          />
          <Stat
            k={
              <>
                Returned <Tip>Owls that came back unspent from mandates that closed, to the deployment&apos;s own account.</Tip>
              </>
            }
            v={owls(created.returned_owls)}
            s="back unspent"
          />
        </Stats>
      )}
      {!createdHere && (
        <Banner>
          <span>
            Owls here are bought, as on the public graph. One owl covers one dollar of the agents&rsquo; metered work. A person adds to their
            balance from <Link href="/account">their account page</Link>.
          </span>
        </Banner>
      )}

      <div className={created || outgoing ? "w-grid2" : undefined}>
        <div className="w-col">
          <Section
            title="General mandates"
            id="general"
            aside={
              <span className="w-row" style={{ gap: 8 }}>
                {standing && <Tip>{`${standing.objective} No agent work runs unless a mandate pays for it, and a mandate's work runs at its label, so each label has its own, set up by an administrator who reads it.`}</Tip>}
                {notSetUp > 0 && <Pill tone="warn">{notSetUp} not set up</Pill>}
              </span>
            }
          >
            {rows.length === 0 ? (
              <div className="w-card">
                <Empty>The standing mandates could not be read just now.</Empty>
              </div>
            ) : (
              <Table label="General mandates">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Status</th>
                    <th className="w-num">Budget</th>
                    <th className="w-num">Spent</th>
                    <th className="w-num">
                      Daily cap <Tip>The most it may commit in any rolling day. As needed: the budget is the only bound. Its Grantmaker may change the pace.</Tip>
                    </th>
                    <th className="w-act" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <GeneralRowView
                      key={`${r.standing.name}:${r.label}`}
                      row={r}
                      summary={r.mandate ? byId.get(r.mandate.id) : undefined}
                      createdHere={createdHere}
                      administers={administers}
                      withDrawer={withDrawer}
                    />
                  ))}
                </tbody>
              </Table>
            )}
          </Section>

          {created && (
            <Section title="Recent" actions={<Link className="w-small" href={`${PAGE}?tab=ledger`}>View ledger</Link>}>
              {created.recent.length === 0 ? (
                <div className="w-card">
                  <Empty>No owls have been created yet. Until some are, no mandate has a budget and no agent work can be paid for.</Empty>
                </div>
              ) : (
                <ActsTable acts={created.recent.slice(0, 5)} />
              )}
            </Section>
          )}
        </div>

        {(created || outgoing) && (
          <aside className="w-col">
            {outgoing && <UsageCard outgoing={outgoing} />}
            {created && created.created.by_administrator.length > 0 && <ByAdministrator created={created} />}
          </aside>
        )}
      </div>
    </>
  );
}

function GeneralRowView({
  row,
  summary,
  createdHere,
  administers,
  withDrawer,
}: {
  row: GeneralRow;
  summary: MandateSummaryView | undefined;
  createdHere: boolean;
  administers: boolean;
  withDrawer: (q: string) => string;
}) {
  const m = row.mandate;
  const status = statusOf(row, summary?.spent_owls);
  if (!row.shown) {
    return (
      <tr className="w-muted-row" id={`general-${row.label}`}>
        <td>
          <Lbl name={row.label} />
        </td>
        <td colSpan={5}>
          <span className="w-row" style={{ gap: 6 }}>
            <span className="w-faint w-small">You don&rsquo;t read this label</span>
            <Tip>{`An administrator who reads ${row.label} sees its General mandate here, and sets it up.`}</Tip>
          </span>
        </td>
      </tr>
    );
  }
  const pct = m && summary && m.budget_owls > 0 ? Math.round((summary.spent_owls / m.budget_owls) * 100) : null;
  let act: ReactNode = null;
  if (!m) {
    act = administers ? (
      <ButtonLink href={withDrawer(`drawer=general&label=${encodeURIComponent(row.label)}`)} small primary>
        Set up
      </ButtonLink>
    ) : (
      <span className="w-faint w-small">An administrator sets it up</span>
    );
  } else if (createdHere && administers && (summary?.status ?? m.status) === "active") {
    act = (
      <ButtonLink href={withDrawer(`drawer=create&into=mandate:${m.id}`)} small>
        Add owls
      </ButtonLink>
    );
  } else {
    act = (
      <Link className="w-small" href={`/mandates/${m.id}`} title="More is added by anyone who holds the permission to fund work backing it from their balance">
        Open
      </Link>
    );
  }
  return (
    <tr id={`general-${row.label}`}>
      <td>
        {m ? (
          <Link href={`/mandates/${m.id}`} title={`${row.standing.title} at ${row.label}`} style={{ textDecoration: "none" }}>
            <Lbl name={row.label} />
          </Link>
        ) : (
          <Lbl name={row.label} />
        )}
      </td>
      <td>
        <Pill tone={status.tone}>{status.text}</Pill>
      </td>
      <td className="w-num">{m ? owls(m.budget_owls) : <span className="w-faint">—</span>}</td>
      <td className="w-num">
        {summary ? (
          <>
            {owls(summary.spent_owls)}
            {pct !== null && <span className="w-faint w-small"> {pct}%</span>}
          </>
        ) : (
          <span className="w-faint">—</span>
        )}
      </td>
      <td className="w-num">
        {m ? m.daily_owls > 0 ? `${owls(m.daily_owls)} / day` : <span className="w-muted">As needed</span> : <span className="w-faint">—</span>}
      </td>
      <td className="w-act">{act}</td>
    </tr>
  );
}

function UsageCard({ outgoing }: { outgoing: OutgoingUsageReports }) {
  const sent = outgoing.reports.filter((r) => r.sent_at).map((r) => r.sent_at!).sort();
  const unsent = outgoing.reports.filter((r) => r.sent_at === null).length;
  return (
    <Card
      title={
        <span className="w-row" style={{ gap: 6 }}>
          Usage reports <Tip>What this deployment reports privately to Minerval of its owl spend, for billing. On the flat price nothing is reported.</Tip>
        </span>
      }
      link={{ href: `${PAGE}?tab=usage`, label: "View" }}
    >
      <Kv
        rows={[
          ["Price", outgoing.price === "metered" ? "Metered" : "Flat"],
          outgoing.reporting && ["Sent to", <DestinationShort key="d" destination={outgoing.destination} />],
          outgoing.reporting && ["Last sent", sent.length > 0 ? shortWhen(sent[sent.length - 1]) : <span className="w-faint">Never</span>],
          outgoing.reporting && ["Unsent", unsent > 0 ? <Pill tone="warn">{unsent}</Pill> : "0"],
          !outgoing.reporting && ["Reports", <span key="n" className="w-muted">None: nothing is reported</span>],
        ]}
      />
    </Card>
  );
}

function DestinationShort({ destination }: { destination: OutgoingUsageReports["destination"] }) {
  if (destination.kind === "online") {
    let host = destination.url;
    try {
      host = new URL(destination.url).host;
    } catch {}
    return destination.ready ? <span>{host}</span> : <Pill tone="warn">{host}: no key</Pill>;
  }
  if (destination.kind === "file") return <span>A file to hand over</span>;
  return <Pill tone="warn">Nowhere set</Pill>;
}

function ByAdministrator({ created }: { created: CreatedOwls }) {
  return (
    <Card title="By administrator" flush>
      <table className="w-t">
        <tbody>
          {created.created.by_administrator.map((a) => (
            <tr key={a.administrator}>
              <td>
                {a.administrator} <span className="w-faint w-small">· {plural(a.acts, "act")}</span>
              </td>
              <td className="w-num">{owls(a.owls)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---- the ledger ----------------------------------------------------------

function ActsTable({ acts }: { acts: CreatedOwls["recent"] }) {
  return (
    <Table label="Owls created">
      <thead>
        <tr>
          <th>When</th>
          <th>Who</th>
          <th>Into</th>
          <th className="w-num">Owls</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {acts.map((act, i) => (
          <tr key={`${act.at}-${i}`}>
            <td className="w-muted" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
              {shortWhen(act.at)}
            </td>
            <td>{act.by ?? <span className="w-faint">—</span>}</td>
            <td>
              {act.mandate ? (
                act.mandate.withheld ? (
                  <span className="w-faint">A mandate at a label you don&rsquo;t read</span>
                ) : (
                  <>
                    <Link href={`/mandates/${act.mandate.id}`}>{act.mandate.title}</Link>
                    {act.standing_mandate && <span className="w-faint w-small"> · at set-up</span>}
                  </>
                )
              ) : (
                <>{act.account}&rsquo;s balance</>
              )}
            </td>
            <td className="w-num">{owls(act.amount_owls)}</td>
            <td className="w-muted">{act.note ?? <span className="w-faint">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Ledger({ created }: { created: CreatedOwls }) {
  return (
    <div className="w-grid2">
      <Section
        title="Who created what"
        aside={
          <span className="w-row" style={{ gap: 6 }}>
            {plural(created.recent.length, "act")}
            <Tip>Every act of creating owls, with who made it. There is no ceiling on what an administrator may create; this list, which every member may read, stands in its place.</Tip>
          </span>
        }
      >
        {created.recent.length === 0 ? (
          <div className="w-card">
            <Empty>No owls have been created yet. Until an administrator creates some, no mandate has a budget and no agent work can be paid for.</Empty>
          </div>
        ) : (
          <ActsTable acts={created.recent} />
        )}
      </Section>
      <aside className="w-col">
        {created.created.by_administrator.length > 0 && <ByAdministrator created={created} />}
        {created.entered_by_setting.length > 0 && (
          <Card
            title={
              <span className="w-row" style={{ gap: 6 }}>
                Entered by a setting <Tip>Owls that reached a balance because the deployment is set to grant them, not by an administrator&apos;s act.</Tip>
              </span>
            }
            flush
          >
            <table className="w-t">
              <tbody>
                {created.entered_by_setting.map((row) => (
                  <tr key={row.reason}>
                    <td>{words(row.reason)}</td>
                    <td className="w-num">{owls(row.owls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </aside>
    </div>
  );
}

// ---- model prices --------------------------------------------------------

const PRICED_BY: Record<string, { text: string; tone: Tone; title: string }> = {
  catalog: { text: "List price", tone: "neu", title: "The vendor's list price, read from the public price lists" },
  stated: { text: "Stated", tone: "neu", title: "A price this deployment states in MODEL_PRICES" },
  provider: { text: "Provider reports", tone: "neu", title: "The provider reports the cost of each call itself" },
  none: { text: "No price", tone: "warn", title: "Calls to it are refused before anything is sent" },
};

const LIST_NAMES: Record<string, string> = { openrouter: "OpenRouter", litellm: "LiteLLM" };

function PricesInUse({ prices }: { prices: CreatedOwls["prices"] }) {
  const inUse = prices.in_use;
  if (!inUse) return null;
  const checked = prices.list_prices_checked_at;
  const unread = (prices.lists ?? []).filter((l) => !l.ok).map((l) => LIST_NAMES[l.source] ?? l.source);
  return (
    <Section
      title="Prices in use"
      aside={
        <span className="w-row" style={{ gap: 6 }}>
          {checked ? `List prices read ${shortWhen(checked)}` : "List prices not read yet"}
          <Tip>
            Anthropic's and OpenAI's prices are read every few hours from two public lists, OpenRouter's model list and LiteLLM's price file. A price in force changes only when both state the new one; a new model is priced from either. Until the lists are first read, calls are priced at the prices this release carries. A call already made keeps the cost it was metered at.
          </Tip>
          {unread.length > 0 && <Pill tone="warn">{unread.join(" and ")} not reached last time</Pill>}
        </span>
      }
    >
      <Table label="Prices in use">
        <thead>
          <tr>
            <th>Setting</th>
            <th>Model</th>
            <th>Priced by</th>
            <th className="w-num">In</th>
            <th className="w-num">Out</th>
          </tr>
        </thead>
        <tbody>
          {inUse.map((p) => {
            const by = PRICED_BY[p.priced_by] ?? PRICED_BY.none!;
            return (
              <tr key={p.setting}>
                <td className="w-mono">{p.setting}</td>
                <td className="w-mono">{p.model}</td>
                <td>
                  <Pill tone={by.tone} title={by.title}>
                    {by.text}
                  </Pill>
                </td>
                <td className="w-num">{p.input_usd_per_mtok ?? "—"}</td>
                <td className="w-num">{p.output_usd_per_mtok ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Section>
  );
}

function Prices({ created }: { created: CreatedOwls }) {
  return (
    <>
      <PricesInUse prices={created.prices} />
      <Section
        title="Stated prices"
        aside={
          <span className="w-row" style={{ gap: 6 }}>
            Dollars per million tokens
            <Tip>
              One owl covers one dollar of metered cost. A call is priced by the vendors' list prices, which this deployment reads every few hours, by a provider that reports the cost of each call itself, or by a price this deployment states for a model in its MODEL_PRICES setting. A model with no price is refused before anything is sent, because a guessed rate would be a number nobody chose.
            </Tip>
          </span>
        }
      >
        {created.prices.stated.length === 0 ? (
          <div className="w-card">
            <Empty>This deployment states no price of its own: every model it runs is priced by the vendors' list prices or by its provider.</Empty>
          </div>
        ) : (
          <Table label="Stated prices">
            <thead>
              <tr>
                <th>Model</th>
                <th className="w-num">In</th>
                <th className="w-num">Out</th>
              </tr>
            </thead>
            <tbody>
              {created.prices.stated.map((p) => (
                <tr key={p.model}>
                  <td className="w-mono">{p.model}</td>
                  <td className="w-num">{p.input_usd_per_mtok}</td>
                  <td className="w-num">{p.output_usd_per_mtok}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );
}

// ---- usage reports -------------------------------------------------------

function Usage({ outgoing }: { outgoing: OutgoingUsageReports }) {
  const unsent = outgoing.reports.filter((r) => r.sent_at === null).length;
  return (
    <>
      <Section
        title="What is reported"
        aside={<Pill tone={outgoing.price === "metered" ? "info" : "neu"}>{outgoing.price === "metered" ? "Metered price" : "Flat price"}</Pill>}
      >
        <div className="w-tbox">
          <Said k="What is sent" text={outgoing.what_is_sent} />
          {outgoing.what_is_never_sent && <Said k="What is never sent" text={outgoing.what_is_never_sent} />}
          {outgoing.corrections && <Said k="Corrections" text={outgoing.corrections} />}
        </div>
      </Section>

      {outgoing.reporting && (
        <>
          <Section title="Where reports go">
            <Destination destination={outgoing.destination} billedTo={outgoing.billed_to ?? null} />
            {outgoing.allowance && (
              <p className="w-muted" style={{ margin: "6px 0 10px", fontSize: 12.5 }}>
                What this deployment may spend of {outgoing.billed_to ?? "the organisation"}&rsquo;s public owls:{" "}
                <b>{(outgoing.allowance.left_micro_usd / 1_000_000).toLocaleString("en-GB", { maximumFractionDigits: 2 })}</b> left of{" "}
                {(outgoing.allowance.allowance_micro_usd / 1_000_000).toLocaleString("en-GB", { maximumFractionDigits: 2 })}, set by an admin of
                the organisation on minerval.ai. A public act that would pass it is refused there.
              </p>
            )}
            <div className="w-card">
              <div className="w-card-b">
                <WorkForm action={sendUsageReportsAction} submit="Prepare and send now" inline>
                  <label className="w-muted w-small" htmlFor="recount-from">
                    Count again from{" "}
                    <Tip>Leave empty unless a day&apos;s figure may be wrong. Each day from this one on is counted again, and a day whose count has changed gets a correction as a new report. The deployment does all this by itself on a schedule; this does it now.</Tip>
                  </label>
                  <input id="recount-from" className="w-input" name="recount_from" type="date" style={{ width: 160, height: 26 }} />
                </WorkForm>
              </div>
            </div>
          </Section>

          <Section
            title="Reports"
            aside={
              <span>
                {plural(outgoing.reports.length, "report")}
                {unsent > 0 && ` · ${unsent} not yet sent`}
              </span>
            }
          >
            {outgoing.reports.length === 0 ? (
              <div className="w-card">
                <Empty>No report has been prepared yet. A report is made only of a day that has ended.</Empty>
              </div>
            ) : (
              <div className="w-tbox">
                {outgoing.reports.map((report) => (
                  <Report key={report.id} report={report} />
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

function Said({ k, text }: { k: string; text: string }) {
  return (
    <details className="w-budget-said">
      <summary>
        <span>{k}</span>
        <span>{text}</span>
      </summary>
    </details>
  );
}

function Destination({ destination, billedTo }: { destination: OutgoingUsageReports["destination"]; billedTo: string | null }) {
  if (destination.kind === "online" && destination.signed) {
    return (
      <Banner>
        <span>
          Billed to <b>{billedTo ?? "the organisation"}</b>. Sent privately to <code className="w-mono">{destination.url}</code>, signed with this
          deployment&rsquo;s own key. Admins of {billedTo ?? "the organisation"} can read what Minerval recorded, on minerval.ai.
        </span>
      </Banner>
    );
  }
  if (destination.kind === "online") {
    return (
      <Banner tone={destination.ready ? "neu" : "warn"}>
        <span>
          Sent privately to <code className="w-mono">{destination.url}</code>, under the organisation&rsquo;s account with Minerval.{" "}
          {destination.ready
            ? "The key is set."
            : billedTo
              ? `This deployment is connected for ${billedTo} and does not hold report_usage, so nothing can be sent yet. An admin of ${billedTo} grants it on minerval.ai.`
              : "This deployment is not connected to minerval.ai, so nothing can be sent yet. Connect it on the public graph's Overview."}
        </span>
      </Banner>
    );
  }
  if (destination.kind === "file") {
    return (
      <Banner>
        <span>
          Each report is written as a file in <code className="w-mono">{destination.directory}</code>, to be handed over under the organisation&rsquo;s account
          with Minerval.
        </span>
      </Banner>
    );
  }
  return (
    <Banner tone="warn">
      <span>
        Nowhere is set for reports to go, so they are prepared and wait. An administrator connects the deployment to minerval.ai on the
        public graph&rsquo;s Overview, and they are sent over its connection; or whoever runs the deployment sets{" "}
        <code className="w-mono">USAGE_REPORT_DIR</code> to write them as files for an admin to upload.
      </span>
    </Banner>
  );
}

function Report({ report }: { report: UsageReport }) {
  return (
    <details className="w-budget-report">
      <summary>
        <span className="w-row" style={{ gap: 6 }}>
          <span className="w-mono">{report.period}</span>
          {report.revision > 0 && <Pill tone="info">correction {report.revision}</Pill>}
        </span>
        <span>
          {report.sent_at ? (
            <span className="w-muted w-small">
              Sent {shortWhen(report.sent_at)}
              {report.sent_via === "file" ? ", as a file" : ""}
            </span>
          ) : report.last_error ? (
            <Pill tone="bad" title={report.last_error}>
              Not sent
            </Pill>
          ) : (
            <Pill tone="warn">Not yet sent</Pill>
          )}
        </span>
        <span className="w-faint w-small">Prepared {shortWhen(report.prepared_at)}</span>
        <span className="w-mono w-faint" title={report.body_hash}>
          {report.body_hash.slice(0, 12)}…
        </span>
      </summary>
      <div className="w-budget-report-b">
        <pre className="w-code">{report.body}</pre>
        {report.last_error && !report.sent_at && (
          <span className="w-said w-error">
            Last tried {shortWhen(report.last_attempt_at)}: {report.last_error}
          </span>
        )}
        {report.receipt !== null && report.receipt !== undefined && (
          <>
            <span className="w-small w-muted">
              {report.sent_via === "online" ? "What Minerval's server answered" : "The record of how it left"}
            </span>
            <pre className="w-code">{JSON.stringify(report.receipt, null, 2)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

// ---- setting up a General mandate -----------------------------------------

function SetUpDrawer({ row, createdHere, close }: { row: GeneralRow | null; createdHere: boolean; close: string }) {
  if (!row || !row.shown || row.mandate) {
    return (
      <Drawer title="Set up a General mandate" close={close}>
        <Empty>
          {!row
            ? "There is no such label among those you read."
            : !row.shown
              ? "You don't read this label. An administrator who reads it sets up its General mandate."
              : "It is set up already."}
        </Empty>
      </Drawer>
    );
  }
  return (
    <Drawer
      title={
        <span className="w-row" style={{ gap: 8 }}>
          Set up General at <Lbl name={row.label} />
        </span>
      }
      close={close}
    >
      <span className="w-muted w-row" style={{ gap: 6 }}>
        It pays for upkeep and audits at {row.label}, and its Grantmaker stewards it from then on. <Tip>{row.standing.objective}</Tip>
      </span>
      <WorkForm
        action={setUpStandingMandateAction}
        submit="Set up"
        primary
        extra={
          <Link href={close} className="w-btn w-ghost">
            Cancel
          </Link>
        }
      >
        <input type="hidden" name="name" value={row.standing.name} />
        {row.namesLabel && <input type="hidden" name="label" value={row.label} />}
        {createdHere && (
          <div className="w-field">
            <label htmlFor="general-budget">Budget, in owls</label>
            <input id="general-budget" className="w-input w-narrow" name="budget_owls" type="number" min="0" step="any" />
            <span className="w-help">Created with the mandate, and logged. Empty for none yet.</span>
          </div>
        )}
        <div className="w-field">
          <label htmlFor="general-daily">Daily cap, in owls</label>
          <input id="general-daily" className="w-input w-narrow" name="daily_owls" type="number" min="0" step="any" placeholder="30" />
          <span className="w-help">The most it may commit in a rolling day. Empty for 30; 0 for as needed. Its Grantmaker may change it later.</span>
        </div>
        {!createdHere && <span className="w-help">Owls are bought here, so it is set up with no budget and funded from a balance like any mandate.</span>}
      </WorkForm>
    </Drawer>
  );
}
