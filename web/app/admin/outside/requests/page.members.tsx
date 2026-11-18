import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import { Empty, Pill, Tabs, Tip, WorkHead, WorkPage, shortDay, type Tone } from "@/components/work/ui";
import { fetchMyLabels, type MyLabels } from "@/lib/admin-api";
import { british, fetchPublicRequests, type PublicRequest } from "@/lib/outside-api";
import { adoptRequestAction, declineRequestAction, takeUpRequestAction } from "../actions";
import { HeadSub, Note, loadAccount, tryRead } from "../parts";

export const metadata: Metadata = { title: "Requests · Minerval" };
export const dynamic = "force-dynamic";

// The public graph's requests, read from the mirror (docs/outward-acts.md).
// A request can be adopted, which makes it an ordinary request here and says
// nothing outside; and a person who directs the graph can say in public, in
// the organisation's name, that this graph is taking it up, or later that the
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
const STATE_TONE: Record<string, Tone> = { open: "neu", addressed: "info", in_progress: "warn", met: "ok", declined: "bad", withdrawn: "neu", moot: "neu" };

type Tab = "open" | "adopted" | "closed";

export default async function PublicRequestsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { tab } = await searchParams;
  const [{ data: account, problem: accountProblem }, { data: listed, problem }, { data: labels }] = await Promise.all([
    loadAccount(who.externalId),
    tryRead(() => fetchPublicRequests(who.externalId), "The public graph's requests could not be read"),
    tryRead(() => fetchMyLabels(who.externalId), "Your labels could not be read"),
  ]);
  const direct = can(who, "direct");
  const all = listed?.requests ?? [];
  const groups: Record<Tab, PublicRequest[]> = {
    open: all.filter((r) => r.here.length === 0 && LIVE.includes(r.state_on_the_public_graph)),
    adopted: all.filter((r) => r.here.length > 0),
    closed: all.filter((r) => r.here.length === 0 && !LIVE.includes(r.state_on_the_public_graph)),
  };
  const current: Tab = tab === "adopted" || (tab === "closed" && groups.closed.length > 0) ? tab : "open";
  const shown = groups[current];
  const asOf = listed?.as_of ? british(listed.as_of) : null;

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

      <Tabs
        current={current}
        tabs={[
          { key: "open", label: "Open", href: "/admin/outside/requests", count: groups.open.length },
          { key: "adopted", label: "Adopted", href: "/admin/outside/requests?tab=adopted", count: groups.adopted.length },
          ...(groups.closed.length > 0
            ? [{ key: "closed", label: "Closed", href: "/admin/outside/requests?tab=closed", count: groups.closed.length }]
            : []),
        ]}
      />

      {listed && (
        <div className="w-toolbar">
          <span className="w-faint w-small">
            Adopting files a private request · taking up in public goes through the gate{" "}
            <Tip>{`${british(listed.adopting)} ${british(listed.taking_up_in_public)}`}</Tip>
          </span>
        </div>
      )}

      <div className="w-feed">
        {shown.length === 0 ? (
          <Empty>
            {current === "open"
              ? "The mirror holds no open request that is not adopted here."
              : current === "adopted"
                ? "No request is adopted here at a label you read."
                : "No closed request."}
          </Empty>
        ) : (
          shown.map((r) => <Request key={r.public_request_id} r={r} direct={direct} labels={labels} />)
        )}
      </div>
    </WorkPage>
  );
}

function Request({ r, direct, labels }: { r: PublicRequest; direct: boolean; labels: MyLabels | null }) {
  const state = r.state_on_the_public_graph;
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
              <Link key={b.id} className="w-node w-sm" href={`/claims/${b.id}`}>
                {b.text}
              </Link>
            ))}
            {r.bears_on_text && <span className="w-node w-sm">{r.bears_on_text}</span>}
          </div>
        )}
        <div className="w-pub-req-meta">
          <span>Who could: {r.who_could ?? "anyone"}</span>
          <span>·</span>
          <span>To: {r.addressed_to ?? "anyone"}</span>
          <span>·</span>
          <span>Filed {shortDay(r.filed_at)}</span>
          <span>·</span>
          <span className="w-mono w-faint" title="Its id on the public graph">
            {r.public_request_id.slice(0, 8)}
          </span>
        </div>
        {r.here.map((h) => (
          <Adopted key={h.adoption_id} h={h} state={state} direct={direct} />
        ))}
      </div>
      <div className="w-pub-req-r">
        <Pill tone={STATE_TONE[state] ?? "neu"}>{cap(state.replace(/_/g, " "))}</Pill>
        {direct && r.here.length === 0 && LIVE.includes(state) && (
          <details className="w-pub-pop">
            <summary className="w-btn w-sm">Adopt…</summary>
            <div className="w-pop">
              <WorkForm action={adoptRequestAction} submit="Adopt privately" primary small>
                <input type="hidden" name="public_request_id" value={r.public_request_id} />
                {labels?.must_choose && (
                  <div className="w-field">
                    <label htmlFor={`lbl-${r.public_request_id}`}>Label</label>
                    <select id={`lbl-${r.public_request_id}`} className="w-select" name="label" required defaultValue="">
                      <option value="" disabled>
                        Choose a label
                      </option>
                      {labels.labels.map((l) => (
                        <option key={l.name} value={l.name} title={l.who_reads}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <span className="w-help">The work is done and read at that label. Says nothing outside.</span>
              </WorkForm>
            </div>
          </details>
        )}
      </div>
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
          <b>Adopted</b> {shortDay(h.adopted_at)} as <Link href={`/requests/${h.request_id}`}>a request here</Link>
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

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
