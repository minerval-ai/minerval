import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import { Empty, Tabs, Tip, WorkHead, WorkPage, shortDay } from "@/components/work/ui";
import { fetchMyLabels, type MyLabel, type MyLabels } from "@/lib/admin-api";
import { british, fetchPublicRequests, type PublicRequest } from "@/lib/outside-api";
import { adoptRequestAction, declineRequestAction, passOnRequestAction, putBackRequestAction, takeUpRequestAction } from "../actions";
import { HeadSub, Note, loadAccount, tryRead } from "../parts";

export const metadata: Metadata = { title: "Requests · Minerval" };
export const dynamic = "force-dynamic";

// The public graph's requests, read from the mirror (docs/outward-acts.md).
// Nearly all of them are asked of anyone, so the page opens on the few that
// are this deployment's in particular: addressed to a mandate it published,
// or bearing on a node it has work of its own on. A person who directs the
// graph can adopt one, which makes it an ordinary request here and says
// nothing outside, or pass on it, which sets it aside here and says nothing
// outside either. Once adopted, they can say in public, in the
// organisation's name, that this graph is taking it up, or later that the
// work will not be done, with a reason from a fixed list.

const REASONS: Array<[string, string]> = [
  ["cannot_be_shown", "It can't be released outside this graph"],
  ["not_held", "We don't hold the evidence it asks about"],
  ["asks_for_a_result", "It asks for a particular result"],
  ["moot", "It no longer bears on anything"],
  ["intrusion", "It could be met only by intrusion"],
  ["no_reason", "No reason given"],
];

const LIVE = ["open", "addressed", "in_progress"];
// A request's state on the public graph, in words. It is said in the line
// under the request and not as a pill beside its buttons, where it read as
// one more thing to press.
const STATE_WORDS: Record<string, string> = {
  open: "open",
  addressed: "open",
  in_progress: "someone has said they are working on it",
  met: "met",
  declined: "declined",
  withdrawn: "withdrawn",
  moot: "no longer bears on anything",
};

type Tab = "concerns" | "anyone" | "adopted" | "passed" | "closed";
const TABS: Tab[] = ["concerns", "anyone", "adopted", "passed", "closed"];
const hrefOf = (tab: Tab) => (tab === "concerns" ? "/admin/outside/requests" : `/admin/outside/requests?tab=${tab}`);

/** The labels a public request can be adopted at: the person's own, but for `public` (services/outward-acts-service.ts, adoptRequest). */
type AdoptAt = { kind: "one_label" } | { kind: "choose"; labels: MyLabel[] } | { kind: "none" };
function adoptAt(labels: MyLabels | null): AdoptAt {
  if (!labels || !labels.must_choose) return { kind: "one_label" };
  const own = labels.labels.filter((l) => l.name !== "public");
  return own.length > 0 ? { kind: "choose", labels: own } : { kind: "none" };
}

export default async function PublicRequestsPage({ searchParams }: { searchParams: Promise<{ tab?: string; done?: string; id?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { tab, done, id: doneId } = await searchParams;
  const [{ data: account, problem: accountProblem }, { data: listed, problem }, { data: labels }] = await Promise.all([
    loadAccount(who.externalId),
    tryRead(() => fetchPublicRequests(who.externalId), "The public graph's requests could not be read"),
    tryRead(() => fetchMyLabels(who.externalId), "Your labels could not be read"),
  ]);
  const direct = can(who, "direct");
  const all = listed?.requests ?? [];
  const waiting = all.filter((r) => r.here.length === 0 && !r.passed_on && LIVE.includes(r.state_on_the_public_graph));
  const groups: Record<Tab, PublicRequest[]> = {
    concerns: waiting.filter((r) => r.concerns_this_graph),
    anyone: waiting.filter((r) => !r.concerns_this_graph),
    adopted: all.filter((r) => r.here.length > 0),
    passed: all.filter((r) => r.here.length === 0 && !!r.passed_on),
    closed: all.filter((r) => r.here.length === 0 && !r.passed_on && !LIVE.includes(r.state_on_the_public_graph)),
  };
  const current: Tab = TABS.includes(tab as Tab) ? (tab as Tab) : "concerns";
  const shown = groups[current];
  const asOf = listed?.as_of ? british(listed.as_of) : null;
  const choices = adoptAt(labels);
  const moved = doneId ? all.find((r) => r.public_request_id === doneId) : undefined;

  return (
    <WorkPage>
      <WorkHead
        title="Requests"
        sub={
          <HeadSub account={account} problem={accountProblem}>
            From the public graph&apos;s mirror · reading them tells the public graph nothing{" "}
            <Tip>{asOf ?? "These are the public graph's requests as the mirror last brought them."}</Tip>
          </HeadSub>
        }
      />

      {accountProblem && <Note tone="bad">{accountProblem}</Note>}
      {problem && <Note tone="bad">{problem}</Note>}
      {moved && <Done done={done} r={moved} />}

      <Tabs
        current={current}
        tabs={[
          { key: "concerns", label: "Concern this graph", href: hrefOf("concerns"), count: groups.concerns.length },
          { key: "anyone", label: "Open to anyone", href: hrefOf("anyone"), count: groups.anyone.length },
          { key: "adopted", label: "Adopted", href: hrefOf("adopted"), count: groups.adopted.length },
          ...(["passed", "closed"] as Tab[])
            .filter((t) => groups[t].length > 0 || current === t)
            .map((t) => ({ key: t, label: t === "passed" ? "Passed on" : "Closed", href: hrefOf(t), count: groups[t].length })),
        ]}
      />

      {listed && (
        <div className="w-toolbar">
          <span className="w-faint w-small">{BLURB[current]}</span>
          {direct && (current === "concerns" || current === "anyone") && shown.length > 0 && (
            <span className="w-faint w-small">
              {" "}
              · Adopt one to work on it here, or pass to set it aside. Neither is told to the public graph{" "}
              <Tip>{`${british(listed.adopting)} ${british(listed.passing ?? "")}`.trim()}</Tip>
            </span>
          )}
        </div>
      )}

      <div className="w-feed">
        {shown.length === 0 ? (
          <Empty>
            {current === "concerns" ? (
              <>
                No open public request is addressed to this graph or bears on a node it has worked on.
                {groups.anyone.length > 0 && (
                  <>
                    {" "}
                    <Link href={hrefOf("anyone")}>{groups.anyone.length === 1 ? "1 is" : `${groups.anyone.length} are`} open to anyone</Link>.
                  </>
                )}
              </>
            ) : (
              EMPTY[current]
            )}
          </Empty>
        ) : (
          shown.map((r) => <Request key={r.public_request_id} r={r} tab={current} direct={direct} choices={choices} />)
        )}
      </div>
    </WorkPage>
  );
}

const BLURB: Record<Tab, string> = {
  concerns: "Addressed to a mandate this graph published, or bearing on a node it has worked on.",
  anyone: "Asked of whoever can do them. Nothing here waits on this graph.",
  adopted: "Requests of this graph's own now, each linked to the public one it came from.",
  passed: "Set aside here. Each is still open on the public graph for whoever else can do it.",
  closed: "No longer open on the public graph.",
};

const EMPTY: Record<Exclude<Tab, "concerns">, string> = {
  anyone: "The mirror holds no other open request.",
  adopted: "No request is adopted here at a label you read.",
  passed: "No request has been passed on here.",
  closed: "No closed request.",
};

/** What was just done to a request, said where the request went. */
function Done({ done, r }: { done?: string; r: PublicRequest }) {
  const here = r.here[0];
  if (done === "adopted" && here) {
    return (
      <Note tone="ok">
        Adopted{here.label ? ` at ${here.label}` : ""}. It is <Link href={`/requests/${here.request_id}`}>a request of this graph&apos;s own</Link> now, and
        its work runs when it is funded here. Nothing was said on the public graph.
      </Note>
    );
  }
  if (done === "passed" && r.passed_on) {
    return (
      <Note tone="ok">
        Passed on: &ldquo;{short(r.ask)}&rdquo; It is under <Link href={hrefOf("passed")}>Passed on</Link>, where it can be put back. Nothing was said on
        the public graph.
      </Note>
    );
  }
  if (done === "put-back" && !r.passed_on) {
    return <Note tone="ok">Put back among the open requests: &ldquo;{short(r.ask)}&rdquo;</Note>;
  }
  return null;
}

function Request({ r, tab, direct, choices }: { r: PublicRequest; tab: Tab; direct: boolean; choices: AdoptAt }) {
  const state = r.state_on_the_public_graph;
  const live = LIVE.includes(state);
  return (
    <div className="w-pub-req">
      <div style={{ minWidth: 0 }}>
        <div className="w-pub-req-ask">{r.ask}</div>
        <div className="w-pub-req-line">{r.why}</div>
        <div className="w-pub-req-line w-muted">Satisfied by: {r.satisfied_by}</div>
        {(r.bears_on.length > 0 || r.bears_on_text) && (
          <div className="w-pub-req-meta">
            <span>Bears on</span>
            {r.bears_on.map((b) => (
              <span key={b.id}>
                <Link className="w-node w-sm" href={`/claims/${b.id}`}>
                  {b.text}
                </Link>
                {b.worked_on_here && <span className="w-pub-why"> · this graph has worked on it</span>}
              </span>
            ))}
            {r.bears_on_text && <span className="w-node w-sm">{r.bears_on_text}</span>}
          </div>
        )}
        <div className="w-pub-req-meta">
          {r.asked_of_this_graph && (
            <>
              <span className="w-pub-why">Addressed to a mandate this graph published</span>
              <span>·</span>
            </>
          )}
          <span>Who could: {r.who_could ?? "anyone"}</span>
          <span>·</span>
          <span>To: {r.addressed_to ?? "anyone"}</span>
          <span>·</span>
          <span>Filed {shortDay(r.filed_at)}</span>
          <span>·</span>
          <span>On the public graph: {STATE_WORDS[state] ?? state.replace(/_/g, " ")}</span>
          <span>·</span>
          <span className="w-mono w-faint" title="Its id on the public graph">
            {r.public_request_id.slice(0, 8)}
          </span>
        </div>
        {r.passed_on && r.here.length === 0 && (
          <div className="w-pub-req-meta">
            Passed on {shortDay(r.passed_on.at)}
            {r.passed_on.by ? ` by ${r.passed_on.by}` : ""}
          </div>
        )}
        {r.here.map((h) => (
          <Adopted key={h.adoption_id} h={h} state={state} direct={direct} />
        ))}
      </div>
      {direct && r.here.length === 0 && (
        <div className="w-pub-req-r">
          {r.passed_on ? (
            <WorkForm action={putBackRequestAction} submit="Put back" inline>
              <input type="hidden" name="public_request_id" value={r.public_request_id} />
            </WorkForm>
          ) : (
            live && (
              <>
                <details className="w-pub-pop">
                  <summary className="w-btn w-sm">Adopt</summary>
                  <div className="w-pop">
                    <div className="w-pub-pop-h">Adopt this request</div>
                    <p className="w-pub-pop-p">
                      Files a copy as a request of this graph&apos;s own, which its agents work on once it is funded here. Nothing is said on the public
                      graph.
                    </p>
                    {choices.kind === "none" ? (
                      <p className="w-pub-pop-p">
                        A public request is adopted at one of this deployment&apos;s labels other than public, and you read none of them. An
                        administrator grants reading at a label.
                      </p>
                    ) : (
                      <WorkForm action={adoptRequestAction} submit="Adopt" primary small>
                        <input type="hidden" name="public_request_id" value={r.public_request_id} />
                        {choices.kind === "choose" && (
                          <fieldset className="w-pub-labels">
                            <input type="hidden" name="must_choose" value="yes" />
                            <legend>Label the work is done at</legend>
                            <div className="w-options">
                              {choices.labels.map((l) => (
                                <label key={l.name} className="w-option" title={l.who_reads}>
                                  {/* One label to choose from is no choice: it is the one the work is done at. */}
                                  <input type="radio" name="label" value={l.name} required defaultChecked={choices.labels.length === 1} />
                                  <div>
                                    <b>{l.name}</b>
                                    {l.description && <span>{l.description}</span>}
                                  </div>
                                </label>
                              ))}
                            </div>
                            <span className="w-help">
                              The request, the work and what it finds are read at that label. Public is not offered: work at public on the public
                              graph&apos;s nodes is the public graph&apos;s to do.
                            </span>
                          </fieldset>
                        )}
                      </WorkForm>
                    )}
                  </div>
                </details>
                <WorkForm action={passOnRequestAction} submit="Pass" inline>
                  <input type="hidden" name="public_request_id" value={r.public_request_id} />
                  <input type="hidden" name="tab" value={tab} />
                </WorkForm>
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}

function Adopted({ h, state, direct }: { h: PublicRequest["here"][number]; state: string; direct: boolean }) {
  const takenUp = !!h.taken_up_in_public_at;
  const declined = h.declined_in_public;
  const met = state === "met";
  return (
    <div>
      <div className="w-pub-track">
        <span className="w-pub-step">
          <span className="w-dot w-ok" aria-hidden />
          <b>Adopted</b> {shortDay(h.adopted_at)}
          {h.label ? ` at ${h.label}` : ""} as <Link href={`/requests/${h.request_id}`}>a request here</Link>
          <span className="w-faint">({h.state_here.replace(/_/g, " ")})</span>
        </span>
        <span className="w-pub-step-ln" aria-hidden />
        <span className="w-pub-step">
          <span className={takenUp ? "w-dot w-ok" : "w-dot"} aria-hidden />
          <b>Taken up in public</b> {takenUp ? shortDay(h.taken_up_in_public_at) : <span className="w-faint">not said outside</span>}
        </span>
        <span className="w-pub-step-ln" aria-hidden />
        <span className="w-pub-step">
          <span className={declined ? "w-dot w-bad" : met ? "w-dot w-ok" : "w-dot"} aria-hidden />
          {declined ? (
            <>
              <b>Declined</b> {shortDay(declined.at)}: {declined.because}
            </>
          ) : met ? (
            <b>Met</b>
          ) : (
            <span className="w-faint">Met / declined</span>
          )}
        </span>
      </div>
      {direct && !takenUp && (
        <details className="w-pub-more" style={{ marginTop: 8 }}>
          <summary>Take up in public…</summary>
          <div className="w-pub-sub">
            <WorkForm action={takeUpRequestAction} submit="Take up in public" primary small lock="Said in the organisation's name · not taken back">
              <input type="hidden" name="adoption_id" value={h.adoption_id} />
              <label className="w-check">
                <input type="checkbox" name="understood" value="yes" required /> I have read what this shows outside
              </label>
            </WorkForm>
          </div>
        </details>
      )}
      {direct && takenUp && !declined && !met && (
        <details className="w-pub-more" style={{ marginTop: 8 }}>
          <summary>Decline in public…</summary>
          <div className="w-pub-sub">
            <WorkForm action={declineRequestAction} submit="Decline in public" danger small lock="Public as the organisation's own · not taken back">
              <input type="hidden" name="adoption_id" value={h.adoption_id} />
              <div className="w-row" style={{ alignItems: "flex-start" }}>
                <div className="w-field" style={{ flex: "1 1 220px" }}>
                  <label htmlFor={`why-${h.adoption_id}`}>Reason</label>
                  <select id={`why-${h.adoption_id}`} className="w-select" name="reason" required defaultValue="">
                    <option value="" disabled>
                      Choose a reason
                    </option>
                    {REASONS.map(([value, words]) => (
                      <option key={value} value={value}>
                        {words}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-field" style={{ flex: "1 1 220px" }}>
                  <label htmlFor={`note-${h.adoption_id}`}>
                    Note <span className="w-faint">optional</span>
                  </label>
                  <input id={`note-${h.adoption_id}`} className="w-input" name="note" maxLength={1000} placeholder="Shown on the request's public record" />
                </div>
              </div>
              <span className="w-help">The reason is shown on the request&apos;s public record as the organisation&apos;s own. Nobody checks it.</span>
            </WorkForm>
          </div>
        </details>
      )}
    </div>
  );
}

function short(s: string): string {
  return s.length > 110 ? `${s.slice(0, 107).trimEnd()}…` : s;
}
