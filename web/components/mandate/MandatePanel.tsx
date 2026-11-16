import Link from "next/link";
import type { MandateDetailView } from "@/lib/account-api";
import type { MandateAllocationView } from "@/lib/api";
import { cancelGrantAction, approveGrantAction } from "@/app/account/actions";
import { dateish, owls } from "@/lib/account-format";
import { paceWords, windowWords } from "@/lib/mandate-page";
import { TopUpGrant } from "./TopUpGrant";

// The mandate at a glance, beside its manager's conversation with its
// Grantmaker: where the money stands, how fast it may go, what is open, and
// the three things a manager does without asking anyone (approve the plan,
// top up, withdraw). Changing the pace is agreed with the Grantmaker, so
// that control is a sentence put in the composer, not a button here.

const STATE: Record<string, string> = {
  planning: "Being drafted",
  pending_approval: "Plan awaiting your approval",
  active: "Working",
  completed: "Finished",
  cancelled: "Withdrawn",
};

function Fact({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="acct-line">
      <span>{label}</span>
      <span className="acct-num">{value}</span>
      {note && <div className="acct-line-under acct-note">{note}</div>}
    </div>
  );
}

export function MandatePanel({
  mandate,
  allocation,
}: {
  mandate: MandateDetailView;
  allocation: MandateAllocationView | null;
}) {
  const b = allocation?.budget ?? null;
  const paused = mandate.budget_status === "paused_budget";
  const running = (allocation?.kinds ?? []).reduce((n, k) => n + k.running, 0);
  const g = mandate.grantmaker;
  const total = Math.max(mandate.budget_owls, 0.000001);
  const share = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  const open = ["planning", "pending_approval", "active"].includes(mandate.status);
  return (
    <>
      <div>
        <span className="mnd-chip" data-state={mandate.status}>
          {STATE[mandate.status] ?? mandate.status}
          {paused ? " · budget spent" : ""}
        </span>
      </div>
      <h2 className="ask-panel-title">
        <Link href={`/mandates/${mandate.id}`}>{mandate.title}</Link>
      </h2>

      <div>
        <Fact
          label="Budget"
          value={
            <>
              <strong>{owls(mandate.spent_owls)}</strong>{" "}
              <span className="acct-detail">of {owls(mandate.budget_owls)} owls spent</span>
            </>
          }
        />
        <div className="mnd-budget" aria-hidden>
          <span data-part="spent" style={{ width: share(mandate.spent_owls) }} />
          <span data-part="held" style={{ width: share(b?.held_owls ?? 0) }} />
          <span data-part="reserve" style={{ width: share(b?.reserve_owls ?? 0) }} />
        </div>
        {b && (
          <>
            <Fact
              label="Pace"
              value={b.pace.kind === "steady" ? paceWords(b.pace.owls, b.pace.period_hours) : "as needed"}
              note={
                b.pace.kind === "steady"
                  ? `${owls(b.pace_window_used_owls ?? 0)} committed in ${windowWords(b.pace.period_hours)}. Yours to change: tell its Grantmaker.`
                  : "The budget is the only bound. Yours to change: tell its Grantmaker."
              }
            />
            {b.reserve_owls > 0 && (
              <Fact
                label="Reserve"
                value={`${owls(b.reserve_owls)} owls`}
                note={b.reserve_reason ? `Kept back by its Grantmaker: ${b.reserve_reason}` : "Kept back by its Grantmaker."}
              />
            )}
            <Fact label="Held by running work" value={owls(b.held_owls)} />
          </>
        )}
        {mandate.status === "active" && <Fact label="Runs open" value={running} />}
        {mandate.status === "active" && g && g.state !== "none" && (
          <Fact
            label="Its Grantmaker"
            value={g.state === "working" ? "at work" : "waiting"}
            note={
              g.state === "waiting"
                ? [
                    g.runs_awaited > 0 ? `on ${g.runs_awaited} run${g.runs_awaited === 1 ? "" : "s"}` : null,
                    g.check_in_at ? `checks in ${g.check_in_at.slice(0, 16).replace("T", " ")} UTC` : null,
                    "a message from you wakes it",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
          />
        )}
        {mandate.last_review && (
          <Fact
            label="Its latest update"
            value={<Link href={`/mandates/${mandate.id}#now`}>{dateish(mandate.last_review.at)} →</Link>}
          />
        )}
      </div>

      {open && (
        <div className="askm-do">
          {mandate.status === "pending_approval" && (
            <form action={approveGrantAction}>
              <input type="hidden" name="grant_id" value={mandate.id} />
              <button type="submit" className="mnd-button mnd-button-main">
                Approve the plan and start
              </button>
              <p className="acct-note">
                <Link href={`/mandates/${mandate.id}#actions`}>Read its actions first →</Link>
              </p>
            </form>
          )}
          {mandate.status === "active" && (
            <details open={paused}>
              <summary className="mnd-button">{paused ? "Top up and resume" : "Top up"}</summary>
              <TopUpGrant grantId={mandate.id} paused={paused} />
            </details>
          )}
          <details>
            <summary className="mnd-button">Withdraw</summary>
            <p className="acct-note">
              Withdrawing stops the mandate. Work already running finishes; everything not spent returns to its
              backers. It cannot be restarted.
            </p>
            <form action={cancelGrantAction}>
              <input type="hidden" name="grant_id" value={mandate.id} />
              <button type="submit" className="mnd-button">
                Withdraw this mandate
              </button>
            </form>
          </details>
        </div>
      )}
    </>
  );
}
