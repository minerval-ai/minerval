import Link from "next/link";
import type { MandateDetailView } from "@/lib/account-api";
import { fetchClaimTexts, type MandateAllocationView } from "@/lib/api";
import { clip, owls } from "@/lib/account-format";
import {
  PLAN_FIRST,
  STANDING_LABEL,
  isStandingOrder,
  mandateHref,
  orderTerms,
  planRows,
  planTabOf,
  planTarget,
  standingOf,
  windowWords,
  type MandatePageView,
  type PlanTab,
} from "@/lib/mandate-page";

// The plan: the actions its Grantmaker has written down, under three heads
// (waiting or running, done, cancelled). An action that orders a pass is a
// standing order, and each one that has not finished says how it stands and
// why, in the ledger's own words.

const ACTION_LABEL: Record<string, string> = {
  assess: "assess",
  reassess: "reassess",
  deepen: "deepen",
  ingest: "read",
  sweep: "consistency sweep",
  propose: "propose",
  formalize: "formalize",
  attempt_proof: "attempt proof",
};

const TABS: Array<[PlanTab, string]> = [
  ["open", "Waiting or running"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

export async function PlanSection({
  mandate,
  view,
  budget,
}: {
  mandate: MandateDetailView;
  view: MandatePageView;
  budget: MandateAllocationView["budget"] | null;
}) {
  const id = mandate.id;
  const items = mandate.plan_items;
  const counts: Record<PlanTab, number> = { open: 0, done: 0, cancelled: 0 };
  for (const item of items) counts[planTabOf(item)] += 1;
  const rows = planRows(items, view.plan);
  const shown = view.planAll ? rows : rows.slice(0, PLAN_FIRST);
  // An action on a node names it by its wording, read for the rows shown.
  const texts = await fetchClaimTexts([
    ...new Set(shown.map((r) => r.item.claim_id).filter((c): c is string => !!c)),
  ]).catch(() => new Map<string, string>());
  const hasOrders = items.some((i) => planTabOf(i) === "open" && isStandingOrder(i));
  const pace = budget?.pace.kind === "steady" ? budget.pace : null;
  const used = budget?.pace_window_used_owls ?? 0;

  return (
    <section className="acct-section" id="plan">
      <div className="acct-head">
        <h2>Plan</h2>
        <span className="acct-note">
          {items.length.toLocaleString("en-US")} action{items.length === 1 ? "" : "s"}, written by its Grantmaker
        </span>
      </div>

      {items.length === 0 ? (
        <p className="acct-note">Its Grantmaker has written no actions yet.</p>
      ) : (
        <>
          <nav className="mnd-kinds" aria-label="Which actions">
            {TABS.map(([key, label]) => (
              <Link
                key={key}
                href={mandateHref(id, view, { plan: key }, "plan")}
                aria-current={view.plan === key ? "true" : undefined}
                scroll={false}
              >
                {label} <span className="acct-num">{counts[key]}</span>
              </Link>
            ))}
          </nav>

          {view.plan === "open" && hasOrders && (
            <div className="mnd-orders">
              <p>
                Each action that orders a pass is a <strong>standing order</strong>: placed as soon as the pace,
                and the money outside the reserve, has room for it whole. One that does not fit waits without
                holding up those after it.
              </p>
              {pace && (
                <div className="mnd-pace">
                  <div className="mnd-pace-line">
                    <span>Pace, {windowWords(pace.period_hours)}</span>
                    <span className="acct-num">
                      <strong>{owls(used)}</strong> of {owls(pace.owls)} owls committed
                    </span>
                  </div>
                  <div
                    className="mnd-bar"
                    role="img"
                    aria-label={`${owls(used)} of ${owls(pace.owls)} owls committed in ${windowWords(pace.period_hours)}`}
                  >
                    <span style={{ width: `${Math.min(100, pace.owls > 0 ? (used / pace.owls) * 100 : 0)}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {rows.length === 0 && (
            <p className="acct-note">
              {view.plan === "open"
                ? "No actions are waiting or running."
                : view.plan === "done"
                  ? "No action has finished yet."
                  : "No action has been cancelled."}
            </p>
          )}

          {shown.map(({ item, count }, i) => {
            const target = planTarget(item);
            const standing = standingOf(item);
            const terms = orderTerms(item);
            const reason = item.ledger?.reason;
            return (
              <div className="mnd-action" key={i} data-state={planTabOf(item)}>
                <span className="tag">{ACTION_LABEL[item.action] ?? item.action}</span>
                <div className="mnd-action-what">
                  {target.url ? (
                    <a href={target.url} rel="nofollow noopener">
                      {target.text}
                    </a>
                  ) : target.claimId && !target.text ? (
                    <Link href={`/claims/${target.claimId}`}>
                      {clip(texts.get(target.claimId) ?? "the node", 160)}
                    </Link>
                  ) : (
                    <span>{target.text}</span>
                  )}
                  {target.claimId && target.text && (
                    <>
                      {" "}
                      (<Link href={`/claims/${target.claimId}`}>the node it became</Link>)
                    </>
                  )}
                  {count > 1 && <span className="mnd-count">× {count}</span>}{" "}
                  <span className="acct-note">{item.rationale}</span>
                </div>
                {terms && <span className="acct-detail acct-num">{terms}</span>}
                {(standing || (planTabOf(item) === "cancelled" && reason)) && (
                  <div className="mnd-standing">
                    {standing && (
                      <span className="mnd-chip" data-standing={standing}>
                        {STANDING_LABEL[standing]}
                      </span>
                    )}
                    {reason && standing !== "running" && <span>{reason}</span>}
                    {standing === "running" && isStandingOrder(item) && (
                      <span>
                        Placed and running. Its budget is held until it finishes, then what it did not use returns.
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {rows.length > shown.length && (
            <div className="acct-pager mnd-foot">
              <span className="acct-num">
                {shown.length} of {rows.length}
              </span>
              <Link className="mnd-button" href={mandateHref(id, view, { planAll: true }, "plan")} scroll={false}>
                Show all {rows.length}
              </Link>
            </div>
          )}
        </>
      )}
    </section>
  );
}
