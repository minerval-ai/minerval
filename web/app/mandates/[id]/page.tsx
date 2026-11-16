import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "../../../auth";
import { accountApiConfigured, fetchMandateView, type MandateDetailView } from "../../../lib/account-api";
import { fetchMandateAllocation, type MandateAllocationView } from "../../../lib/api";
import { dateish, owlParts, owls } from "../../../lib/account-format";
import { mandatePageView, paceWords, windowWords } from "../../../lib/mandate-page";
import { loadFeatures } from "../../../lib/data";
import { featureOn, type Features } from "../../../lib/features";
import { OwlMark } from "../../../components/OwlMark";
import { MandateRecord } from "../../../components/MandateRecord";
import { MastheadHeight } from "../../../components/MastheadHeight";
import { AskBox } from "../../../components/AskBox";
import { PageBack, PageHead } from "@/components/PageHead";
import { Sheet, Prose, FoldedNote } from "../../../components/mandate/Sheet";
import { CompletedWork } from "../../../components/mandate/CompletedWork";
import { PlanSection } from "../../../components/mandate/PlanSection";
import { AgentsSection } from "../../../components/mandate/AgentsSection";
import { SpendingSection } from "../../../components/mandate/SpendingSection";
import { AttemptsTable, PrizesSection } from "../../../components/mandate/Prizes";
import { approveGrantAction, cancelGrantAction } from "../../account/actions";
import { TopUpGrant } from "../../../components/mandate/TopUpGrant";
import { ContributeBox } from "./ContributeBox";
import { OfferMandateOutside } from "@/components/outside/OfferMandateOutside";

export const metadata: Metadata = { title: "Mandate · Minerval" };
export const dynamic = "force-dynamic";

// A mandate's page. It opens on the title and the figures, so a reader sees
// where the mandate stands before anything else; what only its manager sees
// follows in one row. Then, in sections that stay reachable from a bar that
// follows the reader down: what is happening now, the mandate itself (its
// objective and, folded, its strategy), its plan, its agents, its spending,
// its completed work, and its history. Text an agent wrote always carries a
// byline; everything else is the page.

const STATE_LABEL: Record<string, string> = {
  planning: "Being drafted",
  pending_approval: "Plan awaiting approval",
  active: "Working",
  completed: "Finished",
  cancelled: "Withdrawn",
};

const KIND_OPEN_LABEL: Record<string, string> = {
  assess: "Assessments",
  reassess: "Reassessments",
  ingest: "Sources being read",
  consistency_sweep: "Consistency sweeps",
  lookout_run: "Lookout runs",
  correspondent_run: "Correspondent runs",
  mandate_review: "Its Grantmaker's sitting",
  officer_run: "Officers' sittings",
  request: "Work on requests",
  formalize: "Formal statements",
  attempt_proof: "Proof attempts",
  research: "Research",
};

function OwlFigure({ value }: { value: number }) {
  const { whole, fraction } = owlParts(value);
  return (
    <>
      {whole}
      {fraction && <span className="acct-fraction">{fraction}</span>}
    </>
  );
}

/**
 * Who funds the mandate, in one short line under its title. A declared stake
 * is the funder's own words and can run long, so it is one click away rather
 * than in the line.
 */
function FunderLine({ mandate: m }: { mandate: MandateDetailView }) {
  if (m.is_platform) return <p className="acct-note mnd-funder">Run by Minerval.</p>;
  if (!m.funder) return <p className="acct-note mnd-funder">Managed by {m.manager}.</p>;
  if (!m.funder.declared) {
    return (
      <p className="acct-note mnd-funder">
        Funded by {m.funder.shown_as}, before funders were asked to declare a stake.
      </p>
    );
  }
  if (!m.funder.stake) {
    return <p className="acct-note mnd-funder">Funded by {m.funder.shown_as}, who declared no stake in its subject.</p>;
  }
  return (
    <details className="acct-note mnd-funder">
      <summary>
        Funded by {m.funder.shown_as} · <span className="mnd-funder-open">what the funder declared about its stake</span>
      </summary>
      <p>Its declared stake in the subject: {m.funder.stake}</p>
    </details>
  );
}

/**
 * The start of a note, to stand in one line: its first sentence, or as much
 * of it as fits. The whole note is one click away.
 */
function noteOpening(text: string, max = 180): { head: string; cut: boolean } {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  if (sentence.length <= max) return { head: sentence, cut: sentence.length < flat.length };
  const at = flat.lastIndexOf(" ", max);
  return { head: `${flat.slice(0, at > 0 ? at : max)}…`, cut: true };
}

/** The mandate's longer sections, each shown only where it has one. */
function mandateSections(m: MandateDetailView, features: Features): Array<[string, string]> {
  const t = m.text;
  if (!t) return [];
  const all: Array<[string, string | null]> = [
    ["Scope", t.scope],
    ["Prizes", featureOn(features, "prizes") ? t.prize_policy : null],
    ["Attempts", featureOn(features, "mathematics") ? t.attempt_policy : null],
    ["What this mandate declines", t.refusals],
    ["What every funded claim says", t.disclosure],
  ];
  return all.filter((e): e is [string, string] => !!e[1]);
}

/** Its Grantmaker's latest note to the manager: its opening, and the rest folded. */
function ManagerNote({ at, text }: { at: string; text: string }) {
  const { head, cut } = noteOpening(text);
  if (!cut) {
    return (
      <p className="acct-note">
        {dateish(at)}: {text}
      </p>
    );
  }
  return (
    <details className="acct-note mnd-strip-note">
      <summary>
        {dateish(at)}: <span className="mnd-strip-head">{head}</span>{" "}
        <span className="mnd-strip-more" data-closed="Read the note" data-open="Hide" />
      </summary>
      <p>{text}</p>
    </details>
  );
}

/** What only the mandate's manager sees: what waits on them, and what they can do. */
function ManagerStrip({ mandate }: { mandate: MandateDetailView }) {
  const paused = mandate.budget_status === "paused_budget";
  const open = mandate.status === "active" || mandate.status === "pending_approval" || mandate.status === "planning";
  const note = mandate.funder_notes?.[0];
  const head =
    mandate.status === "pending_approval"
      ? "Its plan is ready for you to approve."
      : mandate.status === "planning"
        ? "You and its Grantmaker are still drafting it."
        : paused
          ? "Its budget is spent, and the work has stopped until it is topped up."
          : mandate.status === "active"
            ? note
              ? "Its Grantmaker left you a note."
              : "Nothing is waiting on your decision."
            : mandate.status === "completed"
              ? "It has finished. What it did not spend has returned to its backers."
              : "It was withdrawn. What it did not spend has returned to its backers.";
  return (
    <section className="mnd-strip" aria-label="For you, the manager">
      <div className="mnd-strip-say">
        <p>
          <span className="sc mnd-strip-who">You manage this</span>
          {head}
        </p>
        {note && mandate.status === "active" && <ManagerNote at={note.at} text={note.note} />}
      </div>
      {open && (
        <div className="mnd-strip-do">
          {mandate.status === "pending_approval" && (
            <form action={approveGrantAction}>
              <input type="hidden" name="grant_id" value={mandate.id} />
              <button type="submit" className="mnd-button mnd-button-main">
                Approve the plan and start
              </button>
            </form>
          )}
          {mandate.conversation_id && (
            <Link className="mnd-button" href={`/ask/mandates/${mandate.id}`}>
              Talk to its Grantmaker
            </Link>
          )}
          {mandate.status === "active" && (
            <details className="mnd-do">
              <summary className="mnd-button">{paused ? "Top up and resume" : "Top up"}</summary>
              <div className="mnd-do-body">
                <TopUpGrant grantId={mandate.id} paused={paused} />
              </div>
            </details>
          )}
          <details className="mnd-do">
            <summary className="mnd-button">Withdraw</summary>
            <div className="mnd-do-body">
              <p className="acct-note">
                Withdrawing stops the mandate. Work already running finishes; everything not spent returns to
                its backers. It cannot be restarted.
              </p>
              <form action={cancelGrantAction}>
                <input type="hidden" name="grant_id" value={mandate.id} />
                <button type="submit" className="mnd-button">
                  Withdraw this mandate
                </button>
              </form>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function Figures({
  mandate,
  budget,
  running,
}: {
  mandate: MandateDetailView;
  budget: MandateAllocationView["budget"] | null;
  running: number;
}) {
  const total = Math.max(mandate.budget_owls, 0.000001);
  const held = budget?.held_owls ?? 0;
  const reserve = budget?.reserve_owls ?? 0;
  const free = Math.max(0, mandate.budget_owls - mandate.spent_owls - held - reserve);
  const share = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  const counts = mandate.work_counts;
  const pace = budget?.pace ?? null;
  const waiting = mandate.grantmaker?.state === "waiting";
  return (
    <section className="acct-figures mnd-figures" aria-label="Summary">
      <div className="acct-figure">
        <div className="sc">Budget</div>
        <p className="acct-balance">
          <OwlMark size={26} />
          <strong>
            <OwlFigure value={mandate.spent_owls} />
          </strong>
          <span className="acct-unit">of {owls(mandate.budget_owls)} owls spent</span>
        </p>
        <div
          className="mnd-budget"
          role="img"
          aria-label={`Of ${owls(mandate.budget_owls)} owls: ${owls(mandate.spent_owls)} spent, ${owls(held)} held by running work, ${owls(reserve)} in reserve, ${owls(free)} free`}
        >
          <span data-part="spent" style={{ width: share(mandate.spent_owls) }} />
          <span data-part="held" style={{ width: share(held) }} />
          <span data-part="reserve" style={{ width: share(reserve) }} />
        </div>
        <p className="acct-figure-note mnd-budget-key">
          <span data-part="spent">spent</span>
          {held > 0 && <span data-part="held">{owls(held)} held by running work</span>}
          {reserve > 0 && <span data-part="reserve">{owls(reserve)} in reserve</span>}
          <span data-part="free">{owls(free)} free</span>
        </p>
      </div>
      <div className="acct-figure">
        <div className="sc">Completed</div>
        <p className="acct-figure-value">
          {(counts?.assessments.nodes ?? mandate.funded_assessments.length).toLocaleString("en-US")}{" "}
          <span className="acct-unit">assessment{counts?.assessments.nodes === 1 ? "" : "s"}</span>
        </p>
        <p className="acct-figure-note">
          {counts
            ? [
                `${counts.sources.toLocaleString("en-US")} source${counts.sources === 1 ? "" : "s"} read`,
                `${counts.findings} finding${counts.findings === 1 ? "" : "s"}`,
              ].join(" · ")
            : "counted by kind below"}
        </p>
      </div>
      <div className="acct-figure">
        <div className="sc">Open</div>
        <p className="acct-figure-value">
          {running.toLocaleString("en-US")} <span className="acct-unit">run{running === 1 ? "" : "s"}</span>
        </p>
        <p className="acct-figure-note">
          {mandate.status !== "active"
            ? (STATE_LABEL[mandate.status] ?? mandate.status).toLowerCase()
            : running > 0 && waiting
              ? "its Grantmaker is waiting on them"
              : running > 0
                ? "under way now"
                : "nothing is running now"}
        </p>
      </div>
      <div className="acct-figure">
        <div className="sc">Pace</div>
        {pace?.kind === "steady" ? (
          <>
            <p className="acct-figure-value">
              <OwlFigure value={budget?.pace_window_used_owls ?? 0} />{" "}
              <span className="acct-unit">of {owls(pace.owls)} owls</span>
            </p>
            <p className="acct-figure-note">
              committed in {windowWords(pace.period_hours)}; a steady pace of {paceWords(pace.owls, pace.period_hours)},
              agreed with the funder
            </p>
          </>
        ) : pace ? (
          <>
            <p className="acct-figure-value">
              <span className="acct-unit">as needed</span>
            </p>
            <p className="acct-figure-note">the budget is the only bound on how fast it is committed</p>
          </>
        ) : (
          <>
            <p className="acct-figure-value">
              <span className="acct-unit">not running</span>
            </p>
            <p className="acct-figure-note">a pace applies only while the mandate is live</p>
          </>
        )}
      </div>
    </section>
  );
}

function NowSection({
  mandate,
  allocation,
}: {
  mandate: MandateDetailView;
  allocation: MandateAllocationView | null;
}) {
  const g = mandate.grantmaker;
  const open = (allocation?.kinds ?? []).filter((k) => k.running > 0);
  const openByKind = new Map<string, number>();
  for (const k of open) openByKind.set(k.kind, (openByKind.get(k.kind) ?? 0) + k.running);
  const faults = (mandate.platform_faults ?? []).filter((f) => f.waiting_rows > 0);
  const live = mandate.status === "active";
  const updates = mandate.updates_total ?? (mandate.last_review ? 1 : 0);
  const sittings = mandate.sittings ?? [];
  return (
    <section className="acct-section" id="now">
      <div className="acct-head">
        <h2>Now</h2>
        {updates > 1 && (
          <span className="acct-note">
            <Link href={`/mandates/${mandate.id}/updates`}>All {updates} of its updates →</Link>
          </span>
        )}
      </div>
      <div className="acct-cols">
        <div className="acct-main mnd-sheets">
          {mandate.direction && (
            <Sheet
              label="Current direction"
              by={`written by its Grantmaker${mandate.direction.at ? ` · ${dateish(mandate.direction.at)}` : ""} · the first part of its operating policy`}
            >
              <FoldedNote text={mandate.direction.text} />
            </Sheet>
          )}
          {mandate.last_review ? (
            <Sheet label="Latest update" by={`written by its Grantmaker · ${dateish(mandate.last_review.at)}`}>
              <FoldedNote text={mandate.last_review.note} />
            </Sheet>
          ) : (
            !mandate.direction && (
              <p className="acct-note">
                {live
                  ? "Its Grantmaker has not written an update yet. It leaves one at the end of each sitting."
                  : "Its Grantmaker left no update."}
              </p>
            )
          )}
        </div>
        <aside className="acct-side acct-side-wide">
          {live && g && g.state !== "none" && (
            <>
              <h3 className="mnd-h3">
                {g.state === "working" ? "Its Grantmaker is at work" : "Its Grantmaker is waiting"}
              </h3>
              <p className="acct-note">
                It works in one long session: it commissions work, ends its turn, and is woken by what it asked
                to be told of.
              </p>
              <div className="sc mnd-sub">Woken by</div>
              {g.runs_awaited > 0 && (
                <div className="acct-line">
                  <span>
                    {g.runs_awaited === 1 ? "A run it commissioned" : `The ${g.runs_awaited} runs it commissioned`}{" "}
                    settling
                  </span>
                </div>
              )}
              {g.nodes_watched > 0 && (
                <div className="acct-line">
                  <span>
                    A change on {g.nodes_watched === 1 ? "a node" : `any of ${g.nodes_watched} nodes`} it is
                    watching
                  </span>
                </div>
              )}
              {g.spend_threshold && (
                <div className="acct-line">
                  <span>Its commitments passing an amount it set</span>
                </div>
              )}
              {g.check_in_at && (
                <div className="acct-line">
                  <span>A check-in</span>
                  <span className="acct-detail acct-num">{g.check_in_at.slice(0, 16).replace("T", " ")} UTC</span>
                </div>
              )}
              <div className="acct-line">
                <span>Anything its officers send up</span>
                <span className="acct-detail">always</span>
              </div>
              <div className="acct-line">
                <span>A note from its funder</span>
                <span className="acct-detail">always</span>
              </div>
            </>
          )}
          {sittings.length > 0 && (
            <>
              <h3 className={`mnd-h3${live && g && g.state !== "none" ? " mnd-h3-gap" : ""}`}>Watch it work</h3>
              <p className="acct-note">
                Each sitting is on the run log, step by step: what it was told, what it read, what it
                commissioned and why.
              </p>
              {sittings.map((s) => (
                <div className="acct-line" key={s.run_id}>
                  <span>
                    <Link href={`/runs/${s.run_id}`}>
                      {s.finished_at ? `Sitting of ${s.started_at.slice(0, 16).replace("T", " ")} UTC` : "At work now: watch →"}
                    </Link>
                    {!s.public && <span className="acct-detail">not public</span>}
                  </span>
                  <span className="acct-detail acct-num">
                    {s.steps} step{s.steps === 1 ? "" : "s"}
                    {s.finished_at ? "" : " so far"}
                  </span>
                </div>
              ))}
            </>
          )}
          <h3 className={`mnd-h3${(live && g && g.state !== "none") || sittings.length > 0 ? " mnd-h3-gap" : ""}`}>
            Open work
          </h3>
          {openByKind.size === 0 ? (
            <p className="acct-note">{live ? "Nothing is running now." : "None: the mandate is not live."}</p>
          ) : (
            [...openByKind].map(([kind, n]) => (
              <div className="acct-line" key={kind}>
                <span>{KIND_OPEN_LABEL[kind] ?? kind.replace(/_/g, " ")}</span>
                <span className="acct-num">{n}</span>
              </div>
            ))
          )}
          {live &&
            faults.map((f) => (
              <p className="acct-note mnd-fault" key={f.reason}>
                A platform fault is open since {dateish(f.since)}: {f.reason}. Work it stops stays funded and is
                retried automatically.
              </p>
            ))}
        </aside>
      </div>
    </section>
  );
}

/**
 * The mandate itself: its objective at reading width, the rest of its text
 * folded under it, and its strategy folded below that. It sits under "Now"
 * because a reader coming back wants where it stands; the objective is one
 * click up the bar.
 */
function MandateSection({ mandate, sections }: { mandate: MandateDetailView; sections: Array<[string, string]> }) {
  return (
    <section className="acct-section mnd-mandate" id="mandate">
      <div className="acct-head">
        <h2>Mandate</h2>
        <span className="mnd-by">
          {mandate.platform_approval ? (
            <>
              Drafted by its Grantmaker and funded under a{" "}
              <a href={mandate.platform_approval.approval_url}>public approval</a>
            </>
          ) : (
            "Drafted by its Grantmaker in conversation with the funder, who approved it by funding it"
          )}
        </span>
      </div>
      <div className="mnd-objective">
        {mandate.objective ? <Prose text={mandate.objective} /> : <p className="acct-note">No objective is written yet.</p>}
      </div>
      <p className="acct-note mnd-tagline">A mandate decides which work gets done, not how it comes out.</p>
      {sections.length > 0 && (
        <details className="mnd-fold">
          <summary>
            <span>
              <strong>The rest of the mandate</strong>{" "}
              <span className="mnd-fold-what">{sections.map(([h]) => h.toLowerCase()).join(", ")}</span>
            </span>
          </summary>
          <div className="mnd-fold-body">
            {sections.map(([heading, body]) => (
              <div key={heading}>
                <div className="sc mnd-sub">{heading}</div>
                <Prose text={body} />
              </div>
            ))}
          </div>
        </details>
      )}
      {mandate.strategy && (
        <details className="mnd-fold">
          <summary>
            <span>
              <strong>Strategy</strong> <span className="mnd-fold-what">how its Grantmaker goes about it</span>
            </span>
          </summary>
          <div className="mnd-fold-body">
            <Prose text={mandate.strategy} />
          </div>
        </details>
      )}
    </section>
  );
}

function HistorySection({ mandate }: { mandate: MandateDetailView }) {
  const started = ["active", "completed", "cancelled"].includes(mandate.status);
  const updates = mandate.updates_total ?? 0;
  const steps: Array<{ title: string; body: React.ReactNode; done: boolean }> = [
    {
      title: "Drafted",
      body: mandate.is_platform
        ? `Its Grantmaker drafted it for Minerval${mandate.created_at ? `, beginning ${dateish(mandate.created_at)}` : ""}.`
        : `Its funder and a Grantmaker drafted it in conversation${mandate.created_at ? `, beginning ${dateish(mandate.created_at)}` : ""}.`,
      done: true,
    },
    {
      title: "Approved and funded",
      body: mandate.platform_approval ? (
        <>
          Funded {dateish(mandate.platform_approval.funded_at)} with {owls(mandate.platform_approval.budget_owls)}{" "}
          owls under a <a href={mandate.platform_approval.approval_url}>public approval</a> merged by{" "}
          {mandate.platform_approval.approved_by}.
        </>
      ) : started ? (
        "Its funder approved the plan, and the budget went into escrow."
      ) : mandate.status === "pending_approval" ? (
        "The plan waits for its funder to approve it."
      ) : (
        "Not yet: it is still being drafted."
      ),
      done: started,
    },
    {
      title: "At work",
      body: started
        ? `${owls(mandate.spent_owls)} of ${owls(mandate.budget_owls)} owls spent` +
          (updates > 0 ? `; ${updates} update${updates === 1 ? "" : "s"} from its Grantmaker kept` : "") +
          (mandate.last_review ? `, the latest ${dateish(mandate.last_review.at)}.` : ".")
        : "Starts once it is approved.",
      done: started,
    },
    {
      title: mandate.status === "cancelled" ? "Withdrawn" : "Finished",
      body:
        mandate.status === "completed"
          ? "Its plan ran out or its budget was spent. What was not spent returned to its backers in proportion."
          : mandate.status === "cancelled"
            ? "Its funder withdrew it. What was not spent returned to its backers in proportion."
            : "When its work is done or its budget is spent. What is not spent returns to its backers in proportion.",
      done: mandate.status === "completed" || mandate.status === "cancelled",
    },
  ];
  return (
    <section className="acct-section" id="history">
      <div className="acct-head">
        <h2>History</h2>
      </div>
      <div className="acct-cols">
        <ol className="acct-main mnd-steps">
          {steps.map((s) => (
            <li key={s.title} data-done={s.done ? "" : undefined}>
              <div className="mnd-step-title">{s.title}</div>
              <div className="acct-note">{s.body}</div>
            </li>
          ))}
        </ol>
        <aside className="acct-side acct-side-wide">
          {updates > 0 && (
            <div className="acct-line">
              <Link href={`/mandates/${mandate.id}/updates`}>All its Grantmaker&rsquo;s updates →</Link>
            </div>
          )}
          {mandate.platform_approval && (
            <div className="acct-line">
              <a href={mandate.platform_approval.approval_url}>The public approval →</a>
            </div>
          )}
          <p className="acct-note">
            The title and objective change only when the funder asks or agrees.
          </p>
        </aside>
      </div>
    </section>
  );
}

/**
 * A section that reads more than the mandate holds (its actions' wording, a
 * page of completed work), as it stands while that read is under way: the
 * rest of the page is sent without waiting for it.
 */
function SectionReading({ id, title }: { id: string; title: string }) {
  return (
    <section className="acct-section" id={id} aria-busy="true">
      <div className="acct-head">
        <h2>{title}</h2>
      </div>
      <p className="acct-note">Reading…</p>
    </section>
  );
}

export default async function MandatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!accountApiConfigured()) {
    return (
      <div className="col">
        <PageHead title="Mandate" />
        <p>The frontend is not connected to a Minerval API.</p>
      </div>
    );
  }
  const session = await auth();
  const viewer = session?.externalId ?? null;
  // The mandate, its operations view and the features are read together,
  // not one after another. The operations view answers only for an active
  // mandate (null otherwise), and is dropped below for any other.
  const [read, allocationRead, features, query] = await Promise.all([
    fetchMandateView(id, viewer).then(
      (m) => ({ ok: true as const, mandate: m }),
      () => ({ ok: false as const })
    ),
    fetchMandateAllocation(id),
    loadFeatures(),
    searchParams,
  ]);
  if (!read.ok) notFound();
  const mandate: MandateDetailView = read.mandate;
  const view = mandatePageView(query);
  const live = mandate.status === "active";
  const allocation = live ? allocationRead : null;
  const budget = allocation?.budget ?? null;
  const running = (allocation?.kinds ?? []).reduce((n, k) => n + k.running, 0);
  const prizes = mandate.prizes ?? null;
  // The mandate's own routes keep their prize and attempt fields whatever is
  // switched on; the sections that show them go with their features.
  const prizesOn = featureOn(features, "prizes");
  const mathematicsOn = featureOn(features, "mathematics");
  const attempts = mathematicsOn ? (mandate.attempts ?? []) : [];
  const sections = mandateSections(mandate, features);
  const showPrizes = prizesOn && !!prizes;

  return (
    <div className="mnd">
      <MastheadHeight />
      <div className="mnd-top">
        <PageBack href="/mandates" label="Mandates" />
        <span className="mnd-chip" data-state={mandate.status}>
          {STATE_LABEL[mandate.status] ?? mandate.status}
          {mandate.budget_status === "paused_budget" && live ? " · budget spent" : ""}
        </span>
      </div>
      <div className="mnd-title">
        <PageHead title={mandate.title} variant="statement" />
        <FunderLine mandate={mandate} />
      </div>

      <Figures mandate={mandate} budget={budget} running={running} />

      {mandate.is_manager && <ManagerStrip mandate={mandate} />}

      <nav className="acct-nav" aria-label="On this page">
        <a href="#now">Now</a>
        <a href="#mandate">Mandate</a>
        <a href="#actions">Actions</a>
        <a href="#agents">Agents</a>
        <a href="#spending">Spending</a>
        {showPrizes && <a href="#prizes">Prizes</a>}
        <a href="#completed">Completed work</a>
        <a href="#history">History</a>
      </nav>

      <NowSection mandate={mandate} allocation={allocation} />
      <MandateSection mandate={mandate} sections={sections} />
      <OfferMandateOutside mandateId={mandate.id} live={live} />
      <Suspense fallback={<SectionReading id="actions" title="Actions" />}>
        <PlanSection mandate={mandate} view={view} budget={budget} />
      </Suspense>
      <AgentsSection mandate={mandate} allocation={allocation} />
      <SpendingSection
        mandate={mandate}
        allocation={allocation}
        backing={
          live ? (
            <div className="mnd-back">
              <ContributeBox mandateId={mandate.id} signedIn={!!viewer} />
            </div>
          ) : null
        }
      />

      {/* The prizes section carries the attempts. Where prizes are off and
          mathematics is on, the attempts stand in a section of their own. */}
      {showPrizes
        ? prizes && <PrizesSection prizes={prizes} attempts={attempts} />
        : attempts.length > 0 && (
            <section className="acct-section" id="attempts">
              <div className="acct-head">
                <h2>Attempts</h2>
              </div>
              <AttemptsTable attempts={attempts} />
            </section>
          )}
      {mathematicsOn && mandate.skills?.includes("mathematics") && <MandateRecord grantId={mandate.id} />}

      <Suspense fallback={<SectionReading id="completed" title="Completed work" />}>
        <CompletedWork mandate={mandate} view={view} viewer={viewer} />
      </Suspense>

      <HistorySection mandate={mandate} />

      <section className="acct-section mnd-ask" aria-label="Ask about this mandate">
        <div className="sc">Ask your Assistant about this mandate</div>
        <AskBox
          placeholder="Which of its verdicts changed, and why?"
          about={`the mandate “${mandate.title}” (/mandates/${mandate.id})`}
        />
      </section>

    </div>
  );
}
