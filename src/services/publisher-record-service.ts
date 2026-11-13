/**
 * A publisher's record on this graph, and what the public said back about
 * its pages (docs/outward-acts.md, "A publisher's record").
 *
 * The public Steward weighs a published page partly by how its publisher's
 * other pages have held up. This file reads that from what this graph
 * already holds, as counts and dates: pages published and in which form,
 * what is held and for how long, pages released whole and in part,
 * contributions made through its pages and what followed, requests it said
 * it was taking up and what followed, showings ended, and where this
 * graph's own later assessment of a node stands nearer to or further from
 * what a published page said. Nothing here is a score, and nothing says how
 * far a publisher is to be believed: the facts are shown to readers on the
 * publisher's page and given to the Steward with the source, and the
 * weighing is the Steward's.
 *
 * Everything is derived when it is read. Nothing is stored, so nothing can
 * drift from the record it is read from.
 */
import { rawQuery } from "../db/client.js";
import { shapeOfPublishedPage } from "../published-page/shape.js";
import type { PackageSaidBack, PublishedPagePackage } from "../published-page/verify.js";
import { takenUpOn } from "./request-take-up-service.js";

const day = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : "a date not recorded");
const daysSince = (iso: string | Date) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// ---- what the public said back about one page -----------------------------------------------

export type AnswerState =
  | "not_acknowledged"
  | "received"
  | "repeat"
  | "unanswered"
  | "paid_for"
  | "made"
  | "published_since"
  | "held_since";

export interface SaidBackEntry {
  contribution_id: string;
  type: string;
  submitted_at: string;
  review: string;
  state: AnswerState;
  in_words: string;
}

/** What became of one contribution made through a page, from the page's latest package. Fixed words; the dates are the package's. */
export function answerOf(input: {
  publisher: string;
  reviewStatus: string;
  entry: PackageSaidBack | undefined;
  pkg: PublishedPagePackage | undefined;
}): { state: AnswerState; in_words: string } {
  const { publisher, entry, pkg } = input;
  if (!entry) {
    return {
      state: "not_acknowledged",
      in_words:
        input.reviewStatus === "accepted"
          ? `${publisher}'s graph has not said that it received this.`
          : `${publisher}'s graph takes in what this graph's review has admitted, and this has not been admitted.`,
    };
  }
  const received = `Received by ${publisher}'s graph on ${day(entry.received_at)}.`;
  if (entry.repeats) return { state: "repeat", in_words: `${received} Its text is the same as an earlier contribution's, so it is counted with that one.` };
  if (!entry.reassessment) return { state: "received", in_words: `${received} It has not yet been given to the node's Steward there.` };
  if (entry.reassessment === "not paid for") {
    return { state: "unanswered", in_words: `${received} The reassessment it opened there has not been paid for, so it stands unanswered.` };
  }
  if (entry.reassessment === "paid for, and not yet made") {
    return { state: "paid_for", in_words: `${received} A reassessment there has been paid for and has not been made yet.` };
  }
  const madeAt = entry.reassessment_as_of ?? entry.received_at;
  const since = [...(pkg?.record.versions ?? [])]
    .filter((v) => Date.parse(v.version_of) >= Date.parse(madeAt) - 1000)
    .sort((a, b) => Date.parse(b.version_of) - Date.parse(a.version_of))[0];
  if (since && (since.state === "released_whole" || since.state === "released_in_part")) {
    return { state: "published_since", in_words: `${received} A version made since, of ${day(since.version_of)}, is published.` };
  }
  if (since && since.state === "held") {
    return { state: "held_since", in_words: `${received} A version made since, of ${day(since.version_of)}, is held${since.held_because ? `: ${since.held_because}` : ""}.` };
  }
  return {
    state: "made",
    in_words:
      pkg?.showing.form === "once"
        ? `${received} A reassessment was made there on ${day(madeAt)}. The page was shown once, with nothing undertaken about later versions, so it is not published under this showing.`
        : `${received} A reassessment was made there on ${day(madeAt)}. No version of it has been published or held yet.`,
  };
}

/** The contributions made through one published page, each with what became of it. */
export async function saidBackOnPage(publishedPageId: string): Promise<SaidBackEntry[]> {
  const [publication] = await rawQuery<{ publisher: string }>(
    `SELECT c.display_name AS publisher FROM published_pages p JOIN contributors c ON c.id = p.account_id WHERE p.id = $1`,
    [publishedPageId]
  );
  if (!publication) return [];
  const [latest] = await rawQuery<{ package: PublishedPagePackage }>(
    `SELECT package FROM published_page_packages WHERE published_page_id = $1 ORDER BY sequence DESC LIMIT 1`,
    [publishedPageId]
  );
  const rows = await rawQuery<{ id: string; contribution_type: string; submitted_at: Date; review_status: string }>(
    `SELECT id, contribution_type, submitted_at, review_status FROM contributions WHERE about_published_page_id = $1 ORDER BY submitted_at`,
    [publishedPageId]
  );
  const said = latest?.package.record.said_back ?? [];
  return rows.map((r) => ({
    contribution_id: r.id,
    type: r.contribution_type,
    submitted_at: r.submitted_at.toISOString(),
    review: r.review_status === "accepted" ? "admitted" : r.review_status === "rejected" ? "not admitted" : "waiting for review",
    ...answerOf({ publisher: publication.publisher, reviewStatus: r.review_status, entry: said.find((e) => e.contribution === r.id), pkg: latest?.package }),
  }));
}

/** What became of one contribution, where it was made through a published page; null where it was not. */
export async function answerToContribution(contributionId: string): Promise<{ published_page_id: string; publisher: string; node_id: string; state: AnswerState; in_words: string } | null> {
  const [c] = await rawQuery<{ about: string | null }>(`SELECT about_published_page_id AS about FROM contributions WHERE id = $1`, [contributionId]);
  if (!c?.about) return null;
  const [publication] = await rawQuery<{ publisher: string; node_id: string }>(
    `SELECT c.display_name AS publisher, p.node_id FROM published_pages p JOIN contributors c ON c.id = p.account_id WHERE p.id = $1`,
    [c.about]
  );
  const entry = (await saidBackOnPage(c.about)).find((e) => e.contribution_id === contributionId);
  if (!publication || !entry) return null;
  return { published_page_id: c.about, publisher: publication.publisher, node_id: publication.node_id, state: entry.state, in_words: entry.in_words };
}

// ---- the publisher's record ------------------------------------------------------------------

export interface PublisherFacts {
  pages: { published: number; standing: number; shown_once: number; with_what_sits_under: number };
  now: { released_whole: number; released_in_part: number; held: number; not_yet_assessed: number };
  holds: { held_now_for_days: number[]; versions_ever_held: number };
  showings_ended: number;
  said_back: { admitted: number; received: number; published_since: number; held_since: number; unanswered: number; other: number };
  requests_taken_up: { total: number; a_page_followed: number; declined: number; nothing_yet: number; nothing_yet_for_days: number[] };
  later_assessments: { toward: number; away: number; unchanged: number; none_yet: number };
}

const credenceOf = (pkg: PublishedPagePackage): number | null => {
  const v = shapeOfPublishedPage(pkg)?.verdict as { credence?: unknown } | null | undefined;
  return typeof v?.credence === "number" ? v.credence : null;
};

/**
 * The facts of a publisher's record here. `except` leaves one publication
 * out, so that a page is read beside its publisher's other pages.
 */
export async function publisherFacts(accountId: string, opts: { except?: string } = {}): Promise<PublisherFacts> {
  const publications = await rawQuery<{ id: string; node_id: string }>(
    `SELECT id, node_id FROM published_pages WHERE account_id = $1 AND ($2::uuid IS NULL OR id <> $2) ORDER BY first_received_at`,
    [accountId, opts.except ?? null]
  );
  const facts: PublisherFacts = {
    pages: { published: publications.length, standing: 0, shown_once: 0, with_what_sits_under: 0 },
    now: { released_whole: 0, released_in_part: 0, held: 0, not_yet_assessed: 0 },
    holds: { held_now_for_days: [], versions_ever_held: 0 },
    showings_ended: 0,
    said_back: { admitted: 0, received: 0, published_since: 0, held_since: 0, unanswered: 0, other: 0 },
    requests_taken_up: { total: 0, a_page_followed: 0, declined: 0, nothing_yet: 0, nothing_yet_for_days: [] },
    later_assessments: { toward: 0, away: 0, unchanged: 0, none_yet: 0 },
  };
  for (const p of publications) {
    const packages = await rawQuery<{ sequence: number; package: PublishedPagePackage; received_at: Date }>(
      `SELECT sequence, package, received_at FROM published_page_packages WHERE published_page_id = $1 ORDER BY sequence`,
      [p.id]
    );
    const latest = packages[packages.length - 1]?.package;
    if (!latest) continue;
    if (latest.showing.form === "standing") facts.pages.standing++;
    else facts.pages.shown_once++;
    if (latest.showing.scope === "under") facts.pages.with_what_sits_under++;
    if (latest.showing.ended) facts.showings_ended++;
    facts.now[latest.state]++;
    const versions = latest.record.versions;
    facts.holds.versions_ever_held += versions.filter((v) => v.state === "held").length;
    if (latest.state === "held") {
      const held = [...versions].filter((v) => v.state === "held").sort((a, b) => Date.parse(b.version_of) - Date.parse(a.version_of))[0];
      facts.holds.held_now_for_days.push(daysSince(held?.held_since ?? latest.built_at));
    }
    for (const entry of await saidBackOnPage(p.id)) {
      if (entry.review !== "admitted") continue;
      facts.said_back.admitted++;
      if (entry.state !== "not_acknowledged") facts.said_back.received++;
      if (entry.state === "published_since") facts.said_back.published_since++;
      else if (entry.state === "held_since") facts.said_back.held_since++;
      else if (entry.state === "unanswered" || entry.state === "not_acknowledged") facts.said_back.unanswered++;
      else facts.said_back.other++;
    }
    // Where this graph assessed the node again after the page first arrived with a verdict: nearer to it, or further.
    const firstShown = packages.find((k) => credenceOf(k.package) !== null);
    if (firstShown) {
      const page = credenceOf(firstShown.package)!;
      const history = await rawQuery<{ credence: number | null; at: Date }>(
        `SELECT claim_credence AS credence, assessed_at AS at FROM assessments WHERE claim_id = $1 AND claim_credence IS NOT NULL ORDER BY assessed_at`,
        [p.node_id]
      );
      const before = [...history].filter((h) => h.at.getTime() < firstShown.received_at.getTime()).pop();
      const after = [...history].filter((h) => h.at.getTime() >= firstShown.received_at.getTime()).pop();
      if (!after || !before) facts.later_assessments.none_yet++;
      else {
        const moved = Math.abs(Number(before.credence) - page) - Math.abs(Number(after.credence) - page);
        if (moved > 0.005) facts.later_assessments.toward++;
        else if (moved < -0.005) facts.later_assessments.away++;
        else facts.later_assessments.unchanged++;
      }
    }
  }
  const requests = await rawQuery<{ request_id: string }>(`SELECT DISTINCT request_id FROM request_work WHERE contributor_id = $1 AND taken_up`, [accountId]);
  const taken = await takenUpOn(requests.map((r) => r.request_id));
  for (const list of taken.values()) {
    for (const t of list.filter((x) => x.account_id === accountId)) {
      facts.requests_taken_up.total++;
      if (t.followed === "a_page_shown") facts.requests_taken_up.a_page_followed++;
      else if (t.followed === "declined") facts.requests_taken_up.declined++;
      else {
        facts.requests_taken_up.nothing_yet++;
        facts.requests_taken_up.nothing_yet_for_days.push(daysSince(t.at));
      }
    }
  }
  return facts;
}

/**
 * The facts as sentences, for a reader of the publisher's page and for the
 * Steward reading a page's source. Counts and dates and nothing else: no
 * sentence here says what to make of them.
 */
export function publisherFactsLines(facts: PublisherFacts, of: "its pages" | "its other pages" = "its pages"): string[] {
  if (facts.pages.published === 0 && facts.requests_taken_up.total === 0) {
    return [of === "its other pages" ? "The publisher has no other page on this graph and has taken up no request here." : "No page of its graph is on this graph, and it has taken up no request here."];
  }
  const lines: string[] = [];
  const p = facts.pages;
  if (p.published > 0) {
    lines.push(
      `${of === "its other pages" ? "Other pages it has published here" : "Pages it has published here"}: ${p.published} (${p.standing} kept published so that each later version follows, ${p.shown_once} shown once` +
        (p.with_what_sits_under > 0 ? `; ${p.with_what_sits_under} with what sits under the node` : "") +
        ")."
    );
    const now = facts.now;
    const held = facts.holds.held_now_for_days;
    lines.push(
      `As they stand: ${now.released_whole} released whole, ${now.released_in_part} released in part, ${now.held} held` +
        (held.length > 0 ? ` (for ${held.map((d) => n(d, "day", "days")).join(", ")})` : "") +
        `, ${now.not_yet_assessed} not yet assessed. Versions held at some time: ${facts.holds.versions_ever_held}. Showings ended: ${facts.showings_ended}.`
    );
    const s = facts.said_back;
    lines.push(
      s.admitted === 0
        ? "Contributions made through them and admitted here: none."
        : `Contributions made through them and admitted here: ${s.admitted}. Its graph has said it received ${s.received}. A version made since is published for ${s.published_since} and held for ${s.held_since}; ${s.unanswered} ${s.unanswered === 1 ? "stands" : "stand"} unanswered.`
    );
    const l = facts.later_assessments;
    lines.push(
      l.toward + l.away + l.unchanged === 0
        ? "This graph has not yet assessed a node again after one of them arrived with a credence."
        : `Where this graph assessed a node again after one of them arrived, the node's credence here moved toward the page's for ${l.toward}, away from it for ${l.away}, and neither way for ${l.unchanged}.`
    );
  }
  const r = facts.requests_taken_up;
  lines.push(
    r.total === 0
      ? "Requests it said it was taking up: none."
      : `Requests it said it was taking up: ${r.total}. A page followed for ${r.a_page_followed}; it said it would not do the work for ${r.declined}; nothing yet for ${r.nothing_yet}` +
          (r.nothing_yet_for_days.length > 0 ? ` (after ${r.nothing_yet_for_days.map((d) => n(d, "day", "days")).join(", ")})` : "") +
          "."
  );
  return lines;
}
