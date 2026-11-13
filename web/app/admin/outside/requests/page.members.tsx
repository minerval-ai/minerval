import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { LabelChoice } from "@/components/admin/LabelChoice";
import { AdminNav, Notice, can, viewer, when } from "@/components/admin/access";
import { fetchMyLabels } from "@/lib/admin-api";
import { british, fetchPublicRequests, type PublicRequest } from "@/lib/outside-api";
import { adoptRequestAction, declineRequestAction, takeUpRequestAction } from "../actions";

export const metadata: Metadata = { title: "Public requests · Minerval" };
export const dynamic = "force-dynamic";

// The public graph's requests, read from the mirror (docs/outward-acts.md).
// A request can be adopted, which makes it an ordinary request here and
// says nothing outside; and a person who directs the graph can say in
// public, in the organisation's name, that this graph is taking it up.

const REASONS: Array<[string, string]> = [
  ["cannot_be_shown", "What the request asks for could not be shown outside this graph"],
  ["not_held", "This graph does not hold the evidence the request asks about"],
  ["asks_for_a_result", "The request asks for a particular result"],
  ["moot", "The request no longer bears on anything"],
  ["intrusion", "The request could be met only by intrusion"],
  ["no_reason", "No reason given"],
];

export default async function PublicRequestsPage() {
  const who = await viewer();
  if (!who) return null;
  const [listed, labels] = await Promise.all([fetchPublicRequests(who.externalId), fetchMyLabels(who.externalId).catch(() => null)]);
  const direct = can(who, "direct");
  const live = listed.requests.filter((r) => ["open", "addressed", "in_progress"].includes(r.state_on_the_public_graph));
  const mine = listed.requests.filter((r) => r.here.length > 0);

  const Request = ({ r }: { r: PublicRequest }) => (
    <div className="admin-report">
      <div className="acct-sub">
        <h3>{r.ask}</h3>
        <span className="acct-note">
          {r.state_on_the_public_graph.replace(/_/g, " ")} on the public graph · filed {when(r.filed_at)}
          {r.addressed_to ? ` · addressed to ${r.addressed_to}` : ""}
        </span>
      </div>
      <p className="acct-prose acct-measure">
        <strong>Why:</strong> {r.why} <strong>What would satisfy it:</strong> {r.satisfied_by}
      </p>
      {r.bears_on.length > 0 && (
        <p className="acct-note">
          Bears on{" "}
          {r.bears_on.map((b, i) => (
            <span key={b.id}>
              {i > 0 && "; "}
              <Link href={`/claims/${b.id}`}>{b.text}</Link>
            </span>
          ))}
        </p>
      )}
      {r.here.map((h) => (
        <div key={h.adoption_id} className="admin-item-body">
          <p>
            Adopted here on {when(h.adopted_at)} as <Link href={`/requests/${h.request_id}`}>an ordinary request</Link>, which stands as{" "}
            {h.state_here.replace(/_/g, " ")}.{" "}
            {h.taken_up_in_public_at
              ? `This graph said in public on ${when(h.taken_up_in_public_at)} that it is taking it up.`
              : "Nothing has been said outside."}{" "}
            {h.declined_in_public && `On ${when(h.declined_in_public.at)} it said in public that it will not do the work: ${h.declined_in_public.because}.`}
          </p>
          {direct && !h.taken_up_in_public_at && (
            <ActionForm action={takeUpRequestAction} submit="Say in public that this graph is taking it up">
              <input type="hidden" name="adoption_id" value={h.adoption_id} />
              <label className="admin-check">
                <input type="checkbox" name="understood" value="yes" /> I have read what this shows outside, above.
              </label>
            </ActionForm>
          )}
          {direct && h.taken_up_in_public_at && !h.declined_in_public && (
            <ActionForm action={declineRequestAction} submit="Say in public that the work will not be done">
              <input type="hidden" name="adoption_id" value={h.adoption_id} />
              <label>
                Reason, from a fixed list
                <select name="reason" defaultValue="cannot_be_shown">
                  {REASONS.map(([value, words]) => (
                    <option key={value} value={value}>
                      {words}
                    </option>
                  ))}
                </select>
                <small>The reason is shown on the request&rsquo;s public record as the organisation&rsquo;s own. Nobody checks it.</small>
              </label>
            </ActionForm>
          )}
        </div>
      ))}
      {direct && r.here.length === 0 && (
        <ActionForm action={adoptRequestAction} submit="Adopt it here">
          <input type="hidden" name="public_request_id" value={r.public_request_id} />
          {labels && <LabelChoice mine={labels} what="The label the work on this request is done at. The request is then read by the readers of that label." />}
        </ActionForm>
      )}
    </div>
  );

  return (
    <div className="admin-page">
      <PageHead
        kicker="The public graph"
        title="Public requests"
        lede="A request on the public graph records something someone could do that would improve what the graph knows, and can be addressed to whoever holds the evidence. These are read from the mirror, so reading them tells the public graph nothing."
      />
      <AdminNav current="/admin/outside/requests" />

      <section className="acct-section admin-first" id="how">
        <div className="acct-head">
          <h2>Adopting, and taking up in public</h2>
        </div>
        <p className="acct-prose acct-measure">{british(listed.adopting)}</p>
        <Notice>{british(listed.taking_up_in_public)}</Notice>
      </section>

      {mine.length > 0 && (
        <section className="acct-section" id="adopted">
          <div className="acct-head">
            <h2>Adopted here</h2>
            <span className="acct-note">at labels you read</span>
          </div>
          {mine.map((r) => (
            <Request key={r.public_request_id} r={r} />
          ))}
        </section>
      )}

      <section className="acct-section" id="open">
        <div className="acct-head">
          <h2>Open on the public graph</h2>
          <span className="acct-note">{british(listed.as_of)}</span>
        </div>
        {live.filter((r) => r.here.length === 0).length === 0 ? (
          <p className="account-empty">The mirror holds no other open request.</p>
        ) : (
          live.filter((r) => r.here.length === 0).map((r) => <Request key={r.public_request_id} r={r} />)
        )}
      </section>
    </div>
  );
}
