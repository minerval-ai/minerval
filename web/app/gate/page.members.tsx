import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { NeedsPermission, Notice, can, viewer, when } from "@/components/admin/access";
import { WorkNav, day, waited } from "@/components/inside/nav";
import { fetchGateQueue, type QueueItem } from "@/lib/inside-api";
import { capital } from "@/lib/inside-words";
import { decideAction } from "../showings/actions";
import { QueueForm } from "./QueueForm";

export const metadata: Metadata = { title: "At the gate · Minerval" };
export const dynamic = "force-dynamic";

// What waits on a person at a gate (GET /gate/queue; docs/the-gate.md): for
// a person who holds release for a party, the parts of items that rest on
// that party's material and have not gone through, oldest first. These are
// the items whose gate is set to a person's decision, and those the
// Redactor or a person holds or has delayed; everything else went as the
// Redactor left it. Each part is shown as it would go, with what is always shown of
// its page and the node's wording as they would go: that is the text the
// person's decision releases. Where the person reads at the label the page
// was written at, the Redactor's removals are a difference against what the
// Steward wrote, with its notes. Where they do not, they see the marks and
// not what was removed, except in a part that rests only on the material of
// an outside party they release for, and the API's sentence says so; the
// page shows what the API gives and its sentence.

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
      <del key={`d${i}`} className="queue-removed" title={r.redactor_note ? `The Redactor's note: ${r.redactor_note}` : undefined}>
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
  if (!can(who, "release")) return <NeedsPermission title="At the gate" permission="release" />;
  const queue = await fetchGateQueue(who.externalId);
  const parties = who.mine.grants.filter((g) => g.permission === "release" && g.party).map((g) => g.party!);
  const uniqueParties = [...new Map(parties.map((p) => [p.id, p])).values()];
  const now = Date.now();
  // The API says on every item of a page the person does not read the label of what they are and are not shown. The page gives its sentence in full once, on the first.
  const firstUnread = queue.items.find((i) => i.shown_as_released);

  return (
    <div className="admin-page">
      <PageHead
        title="At the gate"
        lede="What waits on you at a gate. Something written at one label is going to people who do not read that label. Most of it goes as the Redactor left it. What is listed here is what a gate is set to ask a person about, for a party you hold release for, and what the Redactor or a person holds or has delayed."
      />
      <WorkNav who={who} current="/gate" />
      <Notice>{queue.note}</Notice>
      {queue.not_reading_the_label && <p className="acct-prose acct-measure queue-unread">{queue.not_reading_the_label}</p>}

      {uniqueParties.map((party) => {
        const items = queue.items.filter((i) => i.decide_for.some((p) => p.id === party.id));
        const pages = [...new Set(items.map((i) => i.item_id))];
        const anyHeld = items.some((i) => i.held_by_the_redactor || i.delayed_until || i.rests_on.some((r) => r.party.id === party.id && r.standing === "held"));
        return (
          <section className={`acct-section${party.id === uniqueParties[0]!.id ? " admin-first" : ""}`} key={party.id} id={`party-${party.id}`}>
            <div className="acct-head">
              <h2>Waiting on you for {party.name}</h2>
            </div>
            {items.length === 0 ? (
              <p className="account-empty">Nothing waits on you for {party.name}.</p>
            ) : (
              <QueueForm action={decideAction} partyId={party.id} reasons={queue.hold_reasons} anyHeld={anyHeld}>
                {pages.map((pageId) => {
                  const ofPage = items.filter((i) => i.item_id === pageId);
                  const first = ofPage[0]!;
                  return (
                    <div className="queue-page" key={pageId}>
                      <p className="queue-page-head">
                        <strong>
                          {first.node ? (
                            <Link href={`/claims/${first.node_id}`}>{first.node}</Link>
                          ) : first.wording_as_it_would_be_shown ? (
                            <>A page of a node you do not read, whose wording would be shown as: {first.wording_as_it_would_be_shown}</>
                          ) : first.kind_of_thing !== "page" ? (
                            capital(first.kind_of_thing_in_words)
                          ) : (
                            "A page of a node you do not read"
                          )}
                        </strong>
                        . Waiting {waited(first.waiting_since, now)}, since its redaction was checked on{" "}
                        {day(first.waiting_since)}. Audit&rsquo;s check of the redaction: {first.audit ?? "not recorded."}{" "}
                        <Link href={`/showings/${first.showing_id}`}>The showing it belongs to</Link> says who asked and who it is shown to.
                      </p>
                      {ofPage.map((item) => {
                        const mine = item.rests_on.find((r) => r.party.id === party.id);
                        const others = item.rests_on.filter((r) => r.party.id !== party.id);
                        const removed = Object.entries(item.removals_by_category ?? {});
                        return (
                          <div className="queue-item" key={`${item.item_id}:${item.part ?? "page"}`}>
                            <label className="queue-item-head">
                              <input type="checkbox" name="item" value={`${item.item_id}:${item.part ?? "page"}`} />
                              <span>
                                <span className="sc">{item.part === null ? "The item" : `Part ${item.part}`}</span> {capital(item.kind)}
                                <span className="tag">
                                  the Redactor would {item.the_redactor_proposes === "let through" ? "let this through" : `${item.the_redactor_proposes} this`}
                                </span>
                                {item.held_by_the_redactor && <span className="tag">held by the Redactor: {item.held_by_the_redactor.reason}</span>}
                                {item.delayed_until && <span className="tag">delayed until {when(item.delayed_until)}</span>}
                                {item.redactor_least_sure && <span className="tag">the Redactor was least sure here</span>}
                                {mine?.standing === "held" && (
                                  <span className="tag">
                                    held for {party.name}
                                    {(() => {
                                      const hold = item.held?.find((h) => h.party.id === party.id);
                                      return hold ? `${hold.since ? ` since ${day(hold.since)}` : ""}${hold.reason ? `: ${hold.reason}` : ""}` : "";
                                    })()}
                                  </span>
                                )}
                              </span>
                            </label>
                            {item.part === null && (
                              <p className="queue-fact">
                                Releasing this releases everything that is shown whenever the item is shown: for a page, its verdict.
                                Holding it holds the whole item, whatever is decided about its parts.
                              </p>
                            )}
                            {item.shown_as_released && (
                              <p className="queue-fact queue-unread">
                                {item === firstUnread
                                  ? item.shown_as_released
                                  : "You are shown this as it would be released, and not what was removed from it, as said on the first item above."}
                              </p>
                            )}
                            {item.part === null ? (
                              <>
                                <p className="queue-text">{alwaysShown(item.always_shown ?? {})}</p>
                                <details className="admin-args">
                                  <summary>everything that is always shown, as recorded</summary>
                                  <pre className="queue-text">{JSON.stringify(item.always_shown ?? {}, null, 2)}</pre>
                                </details>
                              </>
                            ) : (
                              <>
                                <Difference item={item} />
                                <p className="queue-fact">Shown with it whenever it is shown: {alwaysShown(item.always_shown ?? {})}</p>
                              </>
                            )}
                            {item.part !== null && (
                              <p className="queue-fact">
                                {removed.length === 0
                                  ? "The Redactor removed nothing from this part."
                                  : `Removed under the policy: ${removed.map(([c, n]) => `${c} (${n})`).join(", ")}.`}{" "}
                                {removed.length > 0 &&
                                  ((item.removals ?? []).length > 0
                                    ? "Each removed passage is struck through above, in front of the mark that will stand in its place; the people it is shown to see only the mark."
                                    : "Each mark above stands where a passage was removed; the people it is shown to see the same marks.")}
                              </p>
                            )}
                            {(item.removals ?? [])
                              .filter((r) => r.redactor_note)
                              .map((r, i) => (
                                <p className="queue-fact" key={i}>
                                  The Redactor&rsquo;s note on &ldquo;{r.passage}&rdquo; ({r.category}): {r.redactor_note}
                                </p>
                              ))}
                            {item.redactor_least_sure && (item.why_least_sure ?? []).length === 0 && (
                              <p className="queue-fact">
                                The Redactor flagged this part as one it was least sure of. Why it did is written at the label the page was
                                written at, and is shown to people who read that label.
                              </p>
                            )}
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

      <details className="acct-section queue-limits" id="limits" open={queue.items.length === 0}>
        <summary>
          <h2>What you can do here, and what nobody can</h2>
        </summary>
        <ul className="inside-list acct-measure">
          {Object.entries(queue.acts).map(([act, words]) => (
            <li key={act}>
              <strong>{capital(act)}.</strong> {words}
            </li>
          ))}
          <li>
            <strong>No text is edited.</strong> Each part is hashed as it stands, and the people it is shown to check what they read
            against that hash. A passage can be removed and marked, and a part can be held; no word can be changed.
          </li>
          <li>
            <strong>A release is not taken back.</strong> Once a part is shown, people have read it. A hold or a delay can be lifted
            later; a release cannot be undone.
          </li>
          <li>
            <strong>A hold gives a reason from a fixed list.</strong> It is all the other side is told, beside who holds the part and
            since when. Nobody checks it.
          </li>
          <li>
            <strong>The other side sees how much waits.</strong> Not what it says: how many items, of what kinds, for how long, and
            whether on the Redactor or on a person. How this gate is set is on <Link href="/gates">Gates</Link>.
          </li>
        </ul>
      </details>
    </div>
  );
}
