import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "../../auth";
import {
  accountApiConfigured,
  fetchMandatesPage,
  type MandateListPage,
  type MandateListRow,
} from "../../lib/account-api";
import { dateish, owls } from "../../lib/account-format";
import {
  MANDATES_PER_PAGE,
  mandatesHref,
  mandatesView,
  orderChoices,
  rowAction,
  rowState,
  stateFilters,
  type MandatesView,
} from "../../lib/mandates-list";
import { PageHead } from "@/components/PageHead";

export const metadata: Metadata = {
  title: "Mandates · Minerval",
  description: "Funded programs of work on the graph, public and open for anyone to back.",
};
export const dynamic = "force-dynamic";

// The list of mandates: the reader's own, the ones Minerval runs, and
// everyone's, each a tab that can hold hundreds. A tab is searched,
// narrowed by state, ordered, and read twenty-five rows at a time.

function funderWords(m: MandateListRow): string {
  if (m.is_platform) return "Run by Minerval";
  if (!m.funder) return `Managed by ${m.manager}`;
  const who = m.funder.shown_as.charAt(0).toUpperCase() + m.funder.shown_as.slice(1);
  if (!m.funder.declared) return who;
  return m.funder.stake ? `${who}, who declared a stake: ${m.funder.stake}` : `${who}, no stake declared`;
}

function rowLine(m: MandateListRow, mine: boolean): string {
  if (mine) {
    if (m.status === "pending_approval") {
      return "Its Grantmaker has proposed a plan. Nothing more is spent until you approve it.";
    }
    if (m.status === "planning") return "You and its Grantmaker are still drafting it.";
    if (m.status === "active" && m.budget_status === "paused_budget") {
      return "Its budget is spent, and the work has stopped until it is topped up.";
    }
    const done = m.status === "completed" || m.status === "cancelled";
    return [
      done ? "The unspent part returned to its backers" : m.updated_at ? `Last changed ${dateish(m.updated_at)}` : null,
      `${m.assessments.toLocaleString("en-US")} assessment${m.assessments === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    funderWords(m),
    `${m.assessments.toLocaleString("en-US")} assessment${m.assessments === 1 ? "" : "s"}`,
    `${m.contributor_count} backer${m.contributor_count === 1 ? "" : "s"}`,
  ].join(" · ");
}

function Row({ m, mine }: { m: MandateListRow; mine: boolean }) {
  const state = rowState(m);
  const action = rowAction(m, mine);
  const share = m.budget_owls > 0 ? Math.min(100, (m.spent_owls / m.budget_owls) * 100) : 0;
  return (
    <div className="mnds-row" data-urgent={action.urgent ? "" : undefined}>
      <div className="mnds-what">
        <Link href={`/mandates/${m.id}`} className="mnds-title">
          {m.title}
        </Link>
        <div className="acct-note">{rowLine(m, mine)}</div>
      </div>
      <span className="mnd-chip" data-state={state.key}>
        {state.label}
      </span>
      <div className="mnds-money">
        <div className="acct-num">
          <strong>{owls(m.spent_owls)}</strong> <span className="acct-detail">of {owls(m.budget_owls)} owls</span>
        </div>
        <div className="mnd-bar" aria-hidden>
          <span style={{ width: `${share}%` }} />
        </div>
      </div>
      <Link href={action.href} className="mnds-action">
        {action.label}
      </Link>
    </div>
  );
}

export default async function MandatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!accountApiConfigured()) {
    return (
      <div className="col">
        <PageHead title="Mandates" />
        <p>The frontend is not connected to a Minerval API.</p>
      </div>
    );
  }
  const session = await auth();
  const viewer = session?.externalId ?? null;
  const query = await searchParams;

  // Which tab opens when none is named depends on whether the reader has
  // mandates of their own, which only the list itself says.
  let view: MandatesView = mandatesView(query, !!viewer);
  let page: MandateListPage | null = null;
  const load = (v: MandatesView) =>
    fetchMandatesPage(
      {
        scope: v.scope,
        state: v.state,
        q: v.q || undefined,
        order: v.order ?? undefined,
        offset: (v.page - 1) * MANDATES_PER_PAGE,
        limit: MANDATES_PER_PAGE,
      },
      viewer
    );
  try {
    page = await load(view);
    const settled = mandatesView(query, !!viewer, page.scopes.mine);
    if (settled.scope !== view.scope) {
      view = settled;
      page = await load(view);
    }
  } catch {
    // fall through to the empty state
  }

  const mine = view.scope === "mine";
  const total = page?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / MANDATES_PER_PAGE));
  const tabs: Array<[MandatesView["scope"], string, number | null]> = [
    ...(viewer ? [["mine", "Yours", page?.scopes.mine ?? 0] as [MandatesView["scope"], string, number]] : []),
    ["platform", "Run by Minerval", page?.scopes.platform ?? null],
    ["all", "Everyone’s", page?.scopes.all ?? null],
  ];
  const orders = orderChoices(view.scope);
  const order = view.order ?? orders[0]![0];
  const from = (view.page - 1) * MANDATES_PER_PAGE + 1;

  return (
    <div className="mnd mnds">
      <PageHead
        title="Mandates"
        actions={
          <Link href="/ask/mandates/new" className="mnd-button mnd-button-main">
            Start a mandate
          </Link>
        }
        lede={
          <>
            A mandate is a funded program of work on the graph. Each is managed by its own{" "}
            <Link href="/docs/agents/grantmaker">Grantmaker agent</Link>, which drafts a plan for allocating owls
            to the agent work that best fulfills the mandate, and then oversees its execution. Mandates are
            public, and can be backed by anyone. A mandate decides which work gets done, not how it comes out.
          </>
        }
      />

      <nav className="mnds-tabs" aria-label="Which mandates">
        {tabs.map(([scope, label, n]) => (
          <Link key={scope} href={mandatesHref(view, { scope })} aria-current={view.scope === scope ? "true" : undefined}>
            {label} {n != null && <span className="acct-num">{n.toLocaleString("en-US")}</span>}
          </Link>
        ))}
      </nav>

      <div className="mnds-bar">
        <form action="/mandates" method="get" role="search" className="fnd-search">
          <input type="hidden" name="show" value={view.scope} />
          {view.state !== "any" && <input type="hidden" name="state" value={view.state} />}
          {view.order && <input type="hidden" name="order" value={view.order} />}
          <label htmlFor="mnds-q" className="visually-hidden">
            Search mandates
          </label>
          <input
            id="mnds-q"
            type="search"
            name="q"
            defaultValue={view.q}
            placeholder={
              mine
                ? "Search your mandates"
                : view.scope === "platform"
                  ? "Search Minerval’s mandates"
                  : "Search all mandates by title or objective"
            }
          />
          <button type="submit">Search</button>
        </form>
        <nav className="mnd-kinds mnds-states" aria-label="Narrow by state">
          {stateFilters(view.scope).map(([state, label]) => (
            <Link
              key={state}
              href={mandatesHref(view, { state })}
              aria-current={view.state === state ? "true" : undefined}
            >
              {label} <span className="acct-num">{(page?.states[state] ?? 0).toLocaleString("en-US")}</span>
            </Link>
          ))}
        </nav>
      </div>
      <div className="mnd-controls mnds-order">
        <span className="acct-note">
          {total === 0
            ? "No mandates"
            : total <= MANDATES_PER_PAGE
              ? `${total.toLocaleString("en-US")} mandate${total === 1 ? "" : "s"}`
              : `${from.toLocaleString("en-US")}–${(from + (page?.mandates.length ?? 0) - 1).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} mandates`}
          {view.q && (
            <>
              {" "}
              matching “{view.q}” · <Link href={mandatesHref(view, { q: "" })}>clear</Link>
            </>
          )}
        </span>
        <nav className="mnd-quiet" aria-label="Order">
          {orders.map(([key, label]) => (
            <Link key={key} href={mandatesHref(view, { order: key })} aria-current={order === key ? "true" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
      </div>

      {page?.mandates.map((m) => <Row key={m.id} m={m} mine={mine} />)}

      {total === 0 && (
        <p className="acct-note mnds-empty">
          {!page
            ? "The mandates could not be read just now."
            : view.q || view.state !== "any"
              ? "No mandate matches. "
              : mine
                ? "You have not started a mandate yet. "
                : "No mandates have started yet. "}
          {page && (view.q || view.state !== "any") && (
            <Link href={mandatesHref(view, { q: "", state: "any" })}>Show all of them</Link>
          )}
        </p>
      )}

      {pages > 1 && (
        <div className="acct-pager">
          <span className="acct-num">
            Page {view.page} of {pages}
          </span>
          <nav className="mnd-pages" aria-label="Pages of mandates">
            {view.page > 1 && <Link href={mandatesHref(view, { page: view.page - 1 })}>← Previous</Link>}
            {view.page < pages && (
              <Link href={mandatesHref(view, { page: view.page + 1 })}>
                Next {Math.min(MANDATES_PER_PAGE, total - view.page * MANDATES_PER_PAGE)} →
              </Link>
            )}
          </nav>
        </div>
      )}
    </div>
  );
}
