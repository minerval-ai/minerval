import "server-only";
import { fetchShowing, fetchShowings, fetchShownPage, type ShownPage, type ShownShowing } from "./inside-api";
import { membersOnly } from "./members";
import type { PublishedPageView } from "./published";
import { shapeOfPublishedPage } from "./published-page/shape";
import type { PublishedPagePackage } from "./published-page/verify";
import { loadStanding } from "./standing";
import { whichToOpen } from "./inside-versions";
import type { ClaimDetail, NodeVersion } from "./types";

export { assessmentOf, byLabelName, detailAt, detailWithoutJudgment } from "./inside-versions";

// A node's page inside a private deployment (docs/architecture.md, "A
// judgment at each label"; docs/showing-a-page.md, "What the destination
// sees"). The page is the ordinary one. What a deployment with more than one
// label adds is that a node can carry a judgment at each label, and that a
// page written at a label the reader does not read can have been shown to
// them with what was removed or held marked. This file works out, for one
// reader, which of those there are and which the page should open on.
//
// On the public graph none of this exists: the API serves no `versions`,
// and nothing here is asked.

/** A page of this node that was shown to a label the reader reads, or outside, and has been released at least in part. */
export interface ShownTab {
  showing_id: string;
  page_id: string;
  outside: boolean;
  /** The label it was shown to, as the API words it: readers at "public". */
  shown_to: string;
  version_of: string;
  /** The label the page was written at, where this reader reads it; absent where they do not, and the API then does not name it. */
  from_label?: string;
}

export interface InsideNode {
  /** The node's own label. */
  nodeLabel: string | null;
  versions: NodeVersion[];
  shown: ShownTab[];
  /** Which the page is open on. */
  open:
    | { kind: "version"; version: NodeVersion }
    // Two or more versions are in force for this reader, at labels that do
    // not read each other. Nothing picks between them.
    | { kind: "several"; versions: NodeVersion[] }
    | { kind: "shown"; tab: ShownTab; view: PublishedPageView }
    | { kind: "none" };
  /** Whether the reader may ask for this node's page to be shown (holds the permission to direct). */
  mayAsk: boolean;
}

/** A shown page in the shape the claim page's second tab takes, built from what the API serves of it. */
function viewOfShownPage(tab: ShownTab, showing: ShownShowing, page: ShownPage): PublishedPageView {
  const pseudo = {
    page: {
      version_of: page.version_of,
      always_shown: page.always_shown_as_hashed ?? { text: JSON.stringify(page.always_shown ?? {}) },
      parts: (page.parts ?? []).map((p) => ({
        part: p.part,
        kind: p.kind,
        descriptor: p.descriptor,
        hash: p.hash,
        ...(typeof p.text === "string"
          ? { text: p.text, marks: p.removals_marked ?? [], salt: p.salt }
          : {
              // "[An argument against, held by Acme]": the API's own words name the holders after "held by".
              held: { by: heldBy(p.held), ...holdOf(showing, tab.page_id, p.part) },
            }),
      })),
    },
  } as unknown as PublishedPagePackage;
  const node = showing.nodes.find((n) => n.versions.some((v) => v.page_id === tab.page_id));
  const latest = node?.versions[0];
  return {
    published_page_id: tab.page_id,
    node_id: node?.node_id ?? "",
    form: showing.form,
    scope: showing.scope === "the node alone" ? "node" : "under",
    showing_began: node?.showing_began ?? null,
    asked_at: showing.asked_at,
    ended: showing.ended_at ? { at: showing.ended_at, because: showing.ended_because ?? "no reason given" } : null,
    // A later version that is not shown is said above the page, as on the public graph.
    state: latest && latest.page_id !== tab.page_id && latest.state === "held" ? "held" : page.state,
    version_of: latest?.version_of ?? page.version_of,
    ...(latest && latest.page_id !== tab.page_id && latest.state === "held"
      ? { held: { because: latest.held_because ?? null, since: null } }
      : {}),
    shown_version_of: page.version_of,
    packages_received: 0,
    first_received_at: page.shown_at ?? "",
    on_the_node: { contribution_id: null, review: "admitted", on_the_nodes_page: true, weighed_in_the_nodes_assessment: null },
    package: 0,
    received_at: page.shown_at ?? "",
    publisher: { account_id: "", name: "", key_id: "", public_key: "", runs_on: "", attested_by: "", declared_interest: null, registered_at: null },
    page: shapeOfPublishedPage(pseudo),
    source_id: page.source_id ?? null,
    audit: page.audit,
    fingerprint: page.fingerprint,
    policy: null,
    record: { made: null, prompt_set_is_this_graphs: null, sent: "", acts: [] },
    versions: [],
    check: { ok: page.verification?.ok ?? false, confirmed: [], failed: page.verification?.problems ?? [], cannot_show: [] } as unknown as PublishedPageView["check"],
    packages: [],
    inside: { tab, showing, page },
  };
}

/** The reason given for the hold on a part and since when, from the showing's acts: the latest hold that stands. */
function holdOf(showing: ShownShowing, pageId: string, part: number): { reasons: string[]; since: string | null } {
  const acts = showing.acts.filter((a) => a.page_id === pageId && a.on === `part ${part}`);
  const held = [...acts].reverse().find((a) => a.what === "held");
  return { reasons: held?.reason ? [held.reason] : [], since: held?.at ?? null };
}

function heldBy(words: string | undefined): string[] {
  const m = /held by (.+?)\]?$/.exec(words ?? "");
  return m ? m[1]!.split(" and ") : [];
}

/**
 * What the node's page needs in a deployment with more than one label, for
 * the person reading it. Null on the public graph, for a visitor the gate is
 * standing in for, and for a node that carries one judgment and no shown
 * page: the page is then exactly the ordinary one.
 */
export async function loadInsideNode(
  detail: ClaimDetail,
  query: { at?: string | null; shown?: string | null }
): Promise<InsideNode | null> {
  if (!membersOnly()) return null;
  const standing = await loadStanding();
  if (standing.state !== "signed_in" || !standing.mine.member) return null;
  const versions = detail.versions ?? [];
  const who = standing.externalId;

  // Pages of this node shown to a label this reader reads, or outside. A
  // failure loses the tabs, never the page.
  const shown: ShownTab[] = [];
  const showings = new Map<string, ShownShowing>();
  const listed = await fetchShowings(who, detail.claim.id).catch(() => ({ shown: [], asked: [] }));
  for (const row of listed.shown) {
    const showing = await fetchShowing(who, row.showing_id).catch(() => null);
    if (!showing) continue;
    showings.set(row.showing_id, showing);
    const node = showing.nodes.find((n) => n.node_id === detail.claim.id);
    const released = node?.versions.find((v) => v.state === "released_whole" || v.state === "released_in_part");
    if (!released) continue;
    shown.push({
      showing_id: row.showing_id,
      page_id: released.page_id,
      outside: row.shown_to === "outside this deployment",
      shown_to: row.shown_to,
      version_of: released.version_of,
      from_label: listed.asked.find((a) => a.showing_id === row.showing_id)?.page_label,
    });
  }
  const multiLabel = standing.mine.clearance.some((l) => l !== "public") || versions.some((v) => v.label !== "public") || versions.length > 1;
  if (versions.length <= 1 && shown.length === 0 && !multiLabel) return null;

  const base = {
    nodeLabel: (detail.claim as { label?: string }).label ?? null,
    versions,
    shown,
    mayAsk: standing.mine.permissions.includes("direct") && versions.some((v) => v.label !== "public"),
  };
  const wantedShown = query.shown ? shown.find((t) => t.page_id === query.shown) : undefined;
  if (wantedShown) {
    const page = await fetchShownPage(who, wantedShown.showing_id, wantedShown.page_id).catch(() => null);
    const showing = showings.get(wantedShown.showing_id);
    if (page && showing) return { ...base, open: { kind: "shown", tab: wantedShown, view: viewOfShownPage(wantedShown, showing, page) } };
  }
  return { ...base, open: whichToOpen(versions, query.at) };
}
