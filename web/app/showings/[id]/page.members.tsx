import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { can, viewer, when } from "@/components/admin/access";
import { Hash, WorkNav, day } from "@/components/inside/nav";
import { fetchOutbound, fetchShowing, fetchShowings, type AskedPage } from "@/lib/inside-api";
import { END_REASONS, HOLD_REASONS, removalsInWords, stateOfVersion } from "@/lib/inside-words";
import { endShowingAction, holdPageAction, payForWorkAction } from "../actions";

export const metadata: Metadata = { title: "A showing · Minerval" };
export const dynamic = "force-dynamic";

// One showing (GET /showings/:id, and its row in GET /showings for a reader
// of the label it was asked at): its state, each version of each node's
// page, every act with who did it and what they held, and, for a showing
// outside, where its packages stand. A reader of the label the page is shown
// to sees what that side is told; a reader of the label it was written at
// also sees where the redaction stands and may pay for it, hold the page or
// end the showing, each by the permission the API asks for.

const WORK_WAITING: Record<string, string> = {
  to_redact: "its redaction",
  to_check: "the check of its redaction",
};

export default async function ShowingPage({ params }: { params: Promise<{ id: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { id } = await params;
  const [showing, listed] = await Promise.all([
    fetchShowing(who.externalId, id).catch(() => null),
    fetchShowings(who.externalId).catch(() => ({ shown: [], asked: [] })),
  ]);
  const asked = listed.asked.find((a) => a.showing_id === id) ?? null;
  if (!showing && !asked) notFound();
  const outside = (showing?.shown_to ?? asked?.shown_to) === "outside this deployment";
  const outbound = outside ? await fetchOutbound(who.externalId, id).catch(() => null) : null;
  const form = showing?.form ?? asked!.form;
  const ended = showing?.ended_at ?? asked?.ended_at ?? null;
  const title = showing?.nodes[0]?.text ?? asked?.node ?? "A node you do not read";
  const askedPage = (pageId: string): AskedPage | undefined => asked?.pages.find((p) => p.page_id === pageId);

  return (
    <div className="admin-page">
      <PageHead
        back={{ href: "/showings", label: "showings" }}
        kicker="Showing"
        title={title}
        lede={
          <>
            {outside ? "Shown to people outside this deployment" : `Shown to ${showing?.shown_to ?? `readers at "${asked!.shown_to}"`}`}
            {asked ? (
              <>
                , from the page written at <code>{asked.page_label}</code>
              </>
            ) : null}
            . {form === "standing" ? "A standing showing: each later assessment follows, and one that is not released shows as held." : "Shown once: the page as it stood, with nothing undertaken about later assessments."}{" "}
            It covers {showing?.scope ?? (asked!.scope === "under" ? "the node with what sits under it" : "the node alone")}.
          </>
        }
      />
      <WorkNav who={who} current={`/showings/${id}`} />

      <section className="acct-section admin-first" id="asked">
        <div className="acct-head">
          <h2>Asked for</h2>
        </div>
        <p className="acct-prose acct-measure">
          On {day(showing?.asked_at ?? asked!.asked_at)}
          {showing?.asked_by ? <> by {showing.asked_by}, who then held: {showing.asked_holding.join(", ") || "nothing recorded"}</> : null}.{" "}
          {ended ? (
            <>
              It ended on {day(ended)}
              {showing?.ended_because ? `: ${showing.ended_because}` : ""}. Later assessments no longer follow, and what was shown stays shown.
            </>
          ) : form === "standing" ? (
            "It has not ended."
          ) : null}{" "}
          {showing?.policy && (
            <>
              Pages are redacted under <Link href={`/redaction-policies/${showing.policy.policy_id}`}>version {showing.policy.version} of this boundary&rsquo;s policy</Link>, which everyone the pages are shown to can read in full.
            </>
          )}
        </p>
        {!showing && (
          <p className="acct-prose acct-measure">
            You read the label this page was written at and not the label it is shown to, so what follows is where its redaction stands.
            What the people it is shown to are told about it is on their side, which you do not read.
          </p>
        )}
      </section>

      {showing?.nodes.map((node) => (
        <section className="acct-section" key={node.node_id} id={`node-${node.node_id}`}>
          <div className="acct-head">
            <h2>{showing.nodes.length > 1 ? (node.text ?? "A node you do not read") : "Where it stands"}</h2>
          </div>
          <p className="acct-prose acct-measure">
            {node.text ? <Link href={`/claims/${node.node_id}`}>Open the node.</Link> : "You do not read this node itself: it exists at the label its page was written at."}{" "}
            It has been under this showing since {day(node.covered_from)}, which was {node.showing_began}
            {node.first_assessed_at ? ` (${day(node.first_assessed_at)})` : ""}.
            {node.left_at ? ` It left the showing on ${day(node.left_at)}: ${node.left_because}.` : ""}
          </p>
          {node.versions.length === 0 ? (
            <p className="account-empty">Not yet assessed at the label the page is written at, so there is no page to show. That is not a finding about the node.</p>
          ) : (
            <div className="acct-scroll">
              <table className="account-table acct-table">
                <thead>
                  <tr>
                    <th>assessment of</th>
                    <th>what the people it is shown to see</th>
                    <th>Audit&rsquo;s check of the redaction</th>
                    <th>fingerprint</th>
                  </tr>
                </thead>
                <tbody>
                  {node.versions.map((v) => {
                    const mine = askedPage(v.page_id);
                    const work = mine ? WORK_WAITING[mine.stage] : undefined;
                    const heldByDirector = v.state === "held" && (v.held_because ?? "").startsWith("held by a person who directs");
                    return (
                      <tr key={v.page_id}>
                        <td>
                          {day(v.version_of)}
                          {v.redaction_round > 1 && <span className="acct-detail">redacted {v.redaction_round} times; the check returned an earlier round</span>}
                        </td>
                        <td>
                          {stateOfVersion(v)}.
                          {v.state !== "held" && (
                            <span className="acct-detail">
                              {removalsInWords(v.removals_under_the_policy)} ·{" "}
                              <Link href={`/showings/${id}/pages/${v.page_id}`}>read it as shown, part by part</Link>
                            </span>
                          )}
                          {mine?.cannot_cross && (
                            <span className="acct-detail">
                              The Redactor found that something always shown with a page could not be shown here without giving away what the
                              category &ldquo;{mine.cannot_cross.category}&rdquo; protects. Its note, which stays at the label the page was written
                              at: {mine.cannot_cross.note}
                            </span>
                          )}
                          {mine?.audit_reasons && mine.stage === "to_redact" && (
                            <span className="acct-detail">The check returned the redaction to be done again. Its reasons, which stay at the label the page was written at: {mine.audit_reasons}</span>
                          )}
                          {work && can(who, "fund") && (
                            <ActionForm action={payForWorkAction} submit={`Pay for ${work}`}>
                              <input type="hidden" name="showing_id" value={id} />
                              <input type="hidden" name="page_id" value={v.page_id} />
                              <label>
                                Budget, in owls
                                <input name="owls" type="number" min="0.01" step="0.01" required />
                                <small>
                                  You pay the budget whole and what the run does not spend comes back. It buys the work, not what is removed
                                  or what the check concludes.
                                </small>
                              </label>
                            </ActionForm>
                          )}
                          {work && !can(who, "fund") && <span className="acct-detail">{work.charAt(0).toUpperCase() + work.slice(1)} waits to be paid for, by a mandate or by a person who holds the permission to fund.</span>}
                          {mine && v.state === "held" && can(who, "direct") && !ended && mine.stage !== "overtaken" && (
                            heldByDirector ? (
                              <ActionForm action={holdPageAction} submit="Lift the hold on this page" inline>
                                <input type="hidden" name="showing_id" value={id} />
                                <input type="hidden" name="page_id" value={v.page_id} />
                                <input type="hidden" name="lift" value="true" />
                              </ActionForm>
                            ) : (
                              <details className="admin-args">
                                <summary>hold this page</summary>
                                <ActionForm action={holdPageAction} submit="Hold this page">
                                  <input type="hidden" name="showing_id" value={id} />
                                  <input type="hidden" name="page_id" value={v.page_id} />
                                  <label>
                                    Reason
                                    <select name="reason" required defaultValue="">
                                      <option value="" disabled>
                                        Choose a reason
                                      </option>
                                      {Object.entries(HOLD_REASONS).map(([key, words]) => (
                                        <option key={key} value={key}>
                                          {words}
                                        </option>
                                      ))}
                                    </select>
                                    <small>
                                      A person who directs may hold a page that has not been shown. The hold shows on the other side with
                                      its date and this reason, which nobody checks. It can be lifted and is never deleted. Once a page is
                                      shown it cannot be held: a release is not taken back.
                                    </small>
                                  </label>
                                </ActionForm>
                              </details>
                            )
                          )}
                        </td>
                        <td>{v.audit ?? "Not yet made."}</td>
                        <td>
                          <Hash value={v.fingerprint} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      {!showing && asked && (
        <section className="acct-section" id="pages">
          <div className="acct-head">
            <h2>Where its pages stand</h2>
          </div>
          {asked.pages.length === 0 ? (
            <p className="account-empty">No page has been recorded yet. One is recorded from a finished assessment at the label.</p>
          ) : (
            <div className="acct-scroll">
              <table className="account-table acct-table">
                <thead>
                  <tr>
                    <th>assessment of</th>
                    <th>where it stands</th>
                  </tr>
                </thead>
                <tbody>
                  {asked.pages.map((p) => (
                    <tr key={p.page_id}>
                      <td>{day(p.version_of)}</td>
                      <td>
                        {p.stage_in_words.charAt(0).toUpperCase() + p.stage_in_words.slice(1)}.
                        {WORK_WAITING[p.stage] && can(who, "fund") && (
                          <ActionForm action={payForWorkAction} submit={`Pay for ${WORK_WAITING[p.stage]}`}>
                            <input type="hidden" name="showing_id" value={id} />
                            <input type="hidden" name="page_id" value={p.page_id} />
                            <label>
                              Budget, in owls
                              <input name="owls" type="number" min="0.01" step="0.01" required />
                              <small>You pay the budget whole and what the run does not spend comes back. It buys the work, not what is removed or what the check concludes.</small>
                            </label>
                          </ActionForm>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {outside && (
        <section className="acct-section" id="outside">
          <div className="acct-head">
            <h2>Leaving the deployment</h2>
          </div>
          {!outbound || outbound.nodes.length === 0 ? (
            <p className="account-empty">Nothing under this showing has a package yet. One is built when what the outside would read changes.</p>
          ) : (
            <>
              <p className="acct-prose acct-measure">
                What is released is carried out in signed packages, one each time what the outside would read has changed.{" "}
                {outbound.nodes[0]!.sent === "as_released"
                  ? "The person who asked for this showing chose for each package to be sent as soon as it is built."
                  : "A person who directs the graph sends each package."}{" "}
                <Link href={`/outbound#showing-${id}`}>Sending outside</Link> has each package, whether it was sent and what the public graph
                answered.
              </p>
              <ul className="inside-list">
                {outbound.nodes.map((n) => {
                  const sent = n.packages.filter((p) => p.sends.some((s) => s.result === "admitted")).length;
                  return (
                    <li key={n.node_id}>
                      {n.node ?? "A node you do not read"}: {n.packages.length === 0 ? "no package built" : `${n.packages.length} package${n.packages.length === 1 ? "" : "s"} built, ${sent} sent and taken by the public graph`}
                      {n.waiting ? `. ${n.waiting}` : "."}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}

      {showing && (
        <section className="acct-section" id="acts">
          <div className="acct-head">
            <h2>What was done, and by whom</h2>
          </div>
          <p className="acct-prose acct-measure">
            Every act on this showing, with the permissions the person held when they acted. Where one person holds both direct and release,
            whoever directed the work also released it, and the people the page is shown to can see that here.
          </p>
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>when</th>
                  <th>who</th>
                  <th>holding</th>
                  <th>what</th>
                </tr>
              </thead>
              <tbody>
                {showing.acts.map((a, i) => (
                  <tr key={i}>
                    <td>{when(a.at)}</td>
                    <td>{a.by}</td>
                    <td>{a.holding.join(", ") || <span className="acct-detail">nothing recorded</span>}</td>
                    <td>
                      {a.what.charAt(0).toUpperCase() + a.what.slice(1)}
                      {a.on ? ` ${a.on}` : ""}
                      {a.for_party ? ` for ${a.for_party}` : ""}
                      {a.reason ? `: ${a.reason}` : ""}.
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {asked && form === "standing" && !ended && can(who, "direct") && (
        <section className="acct-section" id="end">
          <div className="acct-head">
            <h2>End this showing</h2>
          </div>
          <p className="acct-prose acct-measure">
            Ending stops later assessments from following. It takes nothing back: what was shown stays shown, and nothing more is released
            from this showing afterwards. The end is recorded with its date and the reason you choose, where the people the page is shown to
            can read it.
          </p>
          <ActionForm action={endShowingAction} submit="End this showing" danger>
            <input type="hidden" name="showing_id" value={id} />
            <label>
              Reason
              <select name="reason" required defaultValue="">
                <option value="" disabled>
                  Choose a reason
                </option>
                {Object.entries(END_REASONS).map(([key, words]) => (
                  <option key={key} value={key}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
