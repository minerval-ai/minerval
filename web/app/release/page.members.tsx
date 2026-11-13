import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { NeedsPermission, Notice, can, viewer, when } from "@/components/admin/access";
import { WorkNav, day, waited } from "@/components/inside/nav";
import { fetchMyLabels } from "@/lib/admin-api";
import { fetchReleaseQueue, fetchReleaseRules, type QueueItem } from "@/lib/inside-api";
import { HOLD_REASONS, capital } from "@/lib/inside-words";
import { decideAction, endRuleAction, setRuleAction } from "../showings/actions";
import { QueueForm } from "./QueueForm";

export const metadata: Metadata = { title: "Release queue · Minerval" };
export const dynamic = "force-dynamic";

// The release queue (GET /release/queue; docs/showing-a-page.md, "The
// gate"): for a person who holds release for a party, the parts of redacted
// pages that rest on that party's material and wait on them, oldest page
// first. Each part is shown as it would go, with the Redactor's removals as
// a difference against what the Steward wrote, where the person reads at
// the label the page was written at. Where they do not, the API withholds
// the text and says so; the page shows what the API gives and its sentence.

/** A part as it would be shown, with each removed passage struck through in front of the mark that replaces it. */
function Difference({ item }: { item: QueueItem }) {
  const shown = item.as_it_would_be_shown ?? "";
  const removals = item.removals ?? [];
  const out: React.ReactNode[] = [];
  let at = 0;
  removals.forEach((r, i) => {
    const mark = `[redacted: ${r.category}]`;
    const found = shown.indexOf(mark, at);
    if (found === -1) return;
    out.push(shown.slice(at, found));
    out.push(
      <del key={`d${i}`} className="queue-removed" title={`The Redactor's note: ${r.redactor_note}`}>
        {r.passage}
      </del>
    );
    out.push(
      <ins key={`i${i}`} className="redaction">
        {mark}
      </ins>
    );
    at = found + mark.length;
  });
  out.push(shown.slice(at));
  return <div className="queue-text">{out}</div>;
}

function alwaysShown(header: Record<string, unknown>): string {
  const v = (header.verdict ?? {}) as Record<string, unknown>;
  const verdict =
    "status" in v
      ? `${capital(String(v.status))}, with confidence ${String(v.confidence)}${v.credence !== null && v.credence !== undefined ? ` and credence ${String(v.credence)}` : ""}`
      : "estimate" in v
        ? `Estimate ${JSON.stringify(v.estimate)}`
        : `Standing: ${String(v.standing).replace(/_/g, " ")}`;
  const sources = ((header.sources ?? []) as unknown[]).length;
  const removals = Object.values((header.removals ?? {}) as Record<string, number>).reduce((n, c) => n + c, 0);
  return `${verdict}. ${sources} source${sources === 1 ? "" : "s"} listed by kind and fingerprint, without content. ${removals} removal${removals === 1 ? "" : "s"} counted by category.`;
}

export default async function ReleaseQueuePage() {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "release")) return <NeedsPermission title="Release queue" permission="release" />;
  const [queue, rules, labels] = await Promise.all([
    fetchReleaseQueue(who.externalId),
    fetchReleaseRules(who.externalId).catch(() => ({ rules: [], conditions: {} as Record<string, string> })),
    fetchMyLabels(who.externalId).catch(() => null),
  ]);
  const parties = who.mine.grants.filter((g) => g.permission === "release" && g.party).map((g) => g.party!);
  const uniqueParties = [...new Map(parties.map((p) => [p.id, p])).values()];
  const now = Date.now();
  // The API says on every item whose text it withholds why it does. The page gives its sentence in full once, on the first.
  const firstUnread = queue.items.find((i) => i.text_withheld);
  const ruleLabels = (labels?.labels ?? []).filter((l) => l.name !== "public");

  return (
    <div className="admin-page">
      <PageHead
        title="Release queue"
        lede="Parts of redacted pages that wait on you. A page written at one label is being shown to people who do not read that label, and each part of it that rests on a party's material is released or held by the people who hold release for that party. You hold it for the parties named below."
      />
      <WorkNav who={who} current="/release" />
      <Notice>{queue.note}</Notice>

      <section className="acct-section admin-first" id="limits">
        <div className="acct-head">
          <h2>What cannot be done here, and why</h2>
        </div>
        <ul className="inside-list acct-measure">
          <li>
            <strong>No text is edited.</strong> Each part was hashed when the redaction finished, and the people it is shown to check what
            they read against that hash. An edited part would no longer match, so a part is released as written or held whole.
          </li>
          <li>
            <strong>A release is not taken back.</strong> Once a part is shown, people have read it. A hold can be lifted later; a release
            cannot be undone.
          </li>
          <li>
            <strong>Nothing is released by time passing.</strong> An item nobody acts on stays held. The people the page is shown to see
            that it is held and for how long, so the age beside each page below is what they see too.
          </li>
          <li>
            <strong>A hold gives a reason from a fixed list.</strong> It is all the other side is told, beside who holds the part and
            since when. Nobody checks it.
          </li>
          <li>
            <strong>You decide for your own parties only.</strong> A part that rests on two parties&rsquo; material needs both, and is shown
            once both have released it.
          </li>
        </ul>
        {queue.deciding_without_reading && <p className="acct-prose acct-measure queue-unread">{queue.deciding_without_reading}</p>}
      </section>

      {uniqueParties.map((party) => {
        const items = queue.items.filter((i) => i.decide_for.some((p) => p.id === party.id));
        const pages = [...new Set(items.map((i) => i.page_id))];
        const anyHeld = items.some((i) => i.rests_on.some((r) => r.party.id === party.id && r.standing === "held"));
        return (
          <section className="acct-section" key={party.id} id={`party-${party.id}`}>
            <div className="acct-head">
              <h2>Waiting on you for {party.name}</h2>
            </div>
            {items.length === 0 ? (
              <p className="account-empty">Nothing waits on you for {party.name}.</p>
            ) : (
              <QueueForm action={decideAction} partyId={party.id} reasons={HOLD_REASONS} anyHeld={anyHeld}>
                {pages.map((pageId) => {
                  const ofPage = items.filter((i) => i.page_id === pageId);
                  const first = ofPage[0]!;
                  return (
                    <div className="queue-page" key={pageId}>
                      <p className="queue-page-head">
                        <strong>A page waiting {waited(first.waiting_since, now)}</strong>, since its redaction was checked on{" "}
                        {day(first.waiting_since)}. Audit&rsquo;s check of the redaction: {first.audit ?? "not recorded."}{" "}
                        <Link href={`/showings/${first.showing_id}`}>The showing it belongs to</Link> says who asked and who it is shown to.
                      </p>
                      {ofPage.map((item) => {
                        const mine = item.rests_on.find((r) => r.party.id === party.id);
                        const others = item.rests_on.filter((r) => r.party.id !== party.id);
                        const removed = Object.entries(item.removals_by_category ?? {});
                        return (
                          <div className="queue-item" key={`${item.page_id}:${item.part ?? "page"}`}>
                            <label className="queue-item-head">
                              <input type="checkbox" name="item" value={`${item.page_id}:${item.part ?? "page"}`} />
                              <span>
                                <span className="sc">{item.part === null ? "The page" : `Part ${item.part}`}</span> {capital(item.kind)}
                                {item.redactor_least_sure && <span className="tag">the Redactor was least sure here</span>}
                                {mine?.standing === "held" && <span className="tag">held for {party.name}</span>}
                              </span>
                            </label>
                            {item.part === null && (
                              <p className="queue-fact">
                                Releasing this releases the verdict and everything that is shown whenever the page is shown. Holding it
                                holds the whole page, whatever is decided about its parts.
                              </p>
                            )}
                            {item.text_withheld ? (
                              <p className="queue-fact queue-unread">
                                {item === firstUnread ? item.text_withheld : "Its text is not shown to you, for the reason given on the first item above: you are deciding this without reading it."}
                              </p>
                            ) : item.part === null ? (
                              <p className="queue-text">{alwaysShown(item.always_shown ?? {})}</p>
                            ) : (
                              <Difference item={item} />
                            )}
                            {item.part !== null && (
                              <p className="queue-fact">
                                {removed.length === 0
                                  ? "The Redactor removed nothing from this part."
                                  : `Removed under the policy: ${removed.map(([c, n]) => `${c} (${n})`).join(", ")}.`}{" "}
                                {!item.text_withheld && removed.length > 0 && "Each removed passage is struck through above, in front of the mark that will stand in its place; the people it is shown to see only the mark."}
                              </p>
                            )}
                            {!item.text_withheld &&
                              (item.removals ?? []).map((r, i) => (
                                <p className="queue-fact" key={i}>
                                  The Redactor&rsquo;s note on &ldquo;{r.passage}&rdquo; ({r.category}): {r.redactor_note}
                                </p>
                              ))}
                            {(item.why_least_sure ?? []).map((why, i) => (
                              <p className="queue-fact" key={i}>
                                Why the Redactor was least sure: {why}
                              </p>
                            ))}
                            {others.length > 0 && (
                              <p className="queue-fact">
                                It also rests on the material of{" "}
                                {others.map((o) => `${o.party.name} (${o.standing === "released" ? "released" : o.standing === "held" ? "holding it" : "not yet decided"})`).join(", ")}, and is shown once every
                                party it rests on has released it.
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </QueueForm>
            )}
          </section>
        );
      })}
      {queue.more_waiting && <p className="acct-prose acct-measure">More items wait than are listed here. They appear as these are decided.</p>}

      <section className="acct-section" id="rules">
        <div className="acct-head">
          <h2>Standing rules</h2>
        </div>
        <p className="acct-prose acct-measure">
          A rule releases parts for one party at one boundary without a person deciding each. It is a condition the system tests from the
          record, with no judgement in it. It applies to pages that reach this queue after it is set, and every release it makes is recorded
          as made under it, where the people the page is shown to can read that. A standing showing does not flow unless a rule covers the
          page itself: without one, each later assessment waits here.
        </p>
        {rules.rules.length === 0 ? (
          <p className="account-empty">No standing rule is set for a party you release for.</p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>party</th>
                  <th>rule</th>
                  <th>set</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.rules.map((r) => (
                  <tr key={r.rule_id}>
                    <td>{r.party.name}</td>
                    <td>
                      {r.in_words}
                      <span className="acct-detail">{r.covers_verdict ? "It also releases the page itself, with its verdict." : "It does not release the page itself: a person does that."}</span>
                    </td>
                    <td>
                      {when(r.set_at)}
                      <span className="acct-detail">by {r.set_by ?? "someone not on record"}, holding {r.set_holding.join(", ")}</span>
                      {r.ended_at && <span className="acct-detail">ended {when(r.ended_at)}</span>}
                    </td>
                    <td>
                      {!r.ended_at && (
                        <ActionForm action={endRuleAction} submit="end" inline danger>
                          <input type="hidden" name="rule_id" value={r.rule_id} />
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {labels && uniqueParties.length > 0 && ruleLabels.length === 0 && (
          <p className="acct-prose acct-measure">
            A rule is set for pages written at one label, and this page offers the labels you read, because the name of a label is not
            shown to people who may not read it. You read at no label besides public, so a rule cannot be set from this page.
          </p>
        )}
        {labels && uniqueParties.length > 0 && ruleLabels.length > 0 && (
          <details className="admin-args">
            <summary>set a rule</summary>
            <ActionForm action={setRuleAction} submit="Set this rule">
              <label>
                Party
                <select name="party_id" required defaultValue={uniqueParties.length === 1 ? uniqueParties[0]!.id : ""}>
                  <option value="" disabled>
                    Choose a party
                  </option>
                  {uniqueParties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="admin-form-row">
                <label>
                  Pages written at
                  <select name="page_label" required defaultValue="">
                    <option value="" disabled>
                      Choose a label
                    </option>
                    {ruleLabels.map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Shown to
                  <select name="to" required defaultValue="">
                    <option value="" disabled>
                      Choose
                    </option>
                    {labels.labels.map((l) => (
                      <option key={l.name} value={`label:${l.name}`}>
                        people who read at {l.name}
                      </option>
                    ))}
                    <option value="outside">people outside this deployment</option>
                  </select>
                </label>
              </div>
              <label>
                Condition
                <select name="condition" required defaultValue="">
                  <option value="" disabled>
                    Choose a condition
                  </option>
                  {Object.entries(rules.conditions).map(([key, words]) => (
                    <option key={key} value={key}>
                      {words}
                    </option>
                  ))}
                </select>
                <small>
                  The labels offered are the ones you read, because the name of a label is not shown to people who may not read it. So a
                  rule for pages written at a label you do not read cannot be set from this page.
                </small>
              </label>
              <label className="admin-check">
                <input type="checkbox" name="covers_verdict" />
                <span>Also release the page itself, with its verdict, for this party. Without this a person releases each page.</span>
              </label>
            </ActionForm>
          </details>
        )}
      </section>
    </div>
  );
}
