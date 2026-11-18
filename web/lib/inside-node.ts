import "server-only";
import { fetchRelease, fetchReleases, fetchReleasedPage, type ReceivedPage, type ReceivedRelease } from "./inside-api";
import { membersOnly } from "./members";
import type { PublishedPageView } from "./published";
import { shapeOfPublishedPage } from "./published-page/shape";
import type { PublishedPagePackage } from "./published-page/verify";
import { loadStanding } from "./standing";
import { whichToOpen } from "./inside-versions";
import type { ClaimDetail, LeftStanding, NodeVersion } from "./types";

export { assessmentOf, byLabelName, detailAt, detailWithoutJudgment } from "./inside-versions";

// A node's page inside a private deployment (docs/architecture.md, "A
// judgment at each label"; docs/releasing-a-page.md, "What the destination
// sees"). The page is the ordinary one. What a deployment with more than one
// label adds is that a node can carry a judgment at each label, and that a
// page written at a label the reader does not read can have been released to
// them with what was removed or held marked. This file works out, for one
// reader, which of those there are and which the page should open on.
//
// On the public graph none of this exists: the API serves no `versions`,
// and nothing here is asked.

/** A page of this node that was released to a label the reader reads, or outside, and has been released at least in part. */
export interface ReleasedTab {
  release_id: string;
  page_id: string;
  outside: boolean;
  /** The label it was released to, as the API words it: readers at "public". */
  released_to: string;
  version_of: string;
  /** The label the page was written at, where this reader reads it; absent where they do not, and the API then does not name it. */
  from_label?: string;
}

export interface InsideNode {
  /** The node's own label. */
  nodeLabel: string | null;
  versions: NodeVersion[];
  /** Labels this reader reads that examined the node and left another label's assessment standing. */
  leftStanding: LeftStanding[];
  /** Labels this reader reads at which the node has been neither assessed nor examined. */
  notExaminedAt: string[];
  released: ReleasedTab[];
  /** Which the page is open on. */
  open:
    | { kind: "version"; version: NodeVersion }
    // Two or more versions are in force for this reader, at labels that do
    // not read each other. Nothing picks between them.
    | { kind: "several"; versions: NodeVersion[] }
    | { kind: "released"; tab: ReleasedTab; view: PublishedPageView }
    | { kind: "none" };
  /** Whether the reader may release this node's page (holds the permission to direct). */
  mayAsk: boolean;
}

/** A released page in the shape the claim page's second tab takes, built from what the API serves of it. */
function viewOfReleasedPage(tab: ReleasedTab, release: ReceivedRelease, page: ReceivedPage): PublishedPageView {
  const pseudo = {
    page: {
      version_of: page.version_of,
      always_released: page.always_released_as_hashed ?? { text: JSON.stringify(page.always_released ?? {}) },
      parts: (page.parts ?? []).map((p) => ({
        part: p.part,
        kind: p.kind,
        descriptor: p.descriptor,
        hash: p.hash,
        ...(typeof p.text === "string"
          ? { text: p.text, marks: p.removals_marked ?? [], salt: p.salt }
          : {
              // "[An argument against, held by Acme]": the API's own words name the holders after "held by".
              held: { by: heldBy(p.held), ...holdOf(release, tab.page_id, p.part) },
            }),
      })),
    },
  } as unknown as PublishedPagePackage;
  const node = release.nodes.find((n) => n.versions.some((v) => v.page_id === tab.page_id));
  const latest = node?.versions[0];
  return {
    published_page_id: tab.page_id,
    node_id: node?.node_id ?? "",
    form: release.form,
    scope: release.scope_code === "item" ? null : release.scope_code,
    release_began: node?.release_began ?? null,
    asked_at: release.asked_at,
    ended: release.ended_at ? { at: release.ended_at, because: release.ended_because ?? "no reason given" } : null,
    // A later version that is not shown is said above the page, as on the public graph.
    state: latest && latest.page_id !== tab.page_id && latest.state === "held" ? "held" : page.state,
    version_of: latest?.version_of ?? page.version_of,
    ...(latest && latest.page_id !== tab.page_id && latest.state === "held"
      ? { held: { because: latest.held_because ?? null, since: null } }
      : {}),
    released_version_of: page.version_of,
    packages_received: 0,
    first_received_at: page.released_at ?? "",
    on_the_node: { contribution_id: null, review: "admitted", on_the_nodes_page: true, weighed_in_the_nodes_assessment: null },
    package: 0,
    received_at: page.released_at ?? "",
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
    inside: { tab, release, page },
  };
}

/** The reason given for the hold on a part and since when, from the release's acts: the latest hold that stands. */
function holdOf(release: ReceivedRelease, pageId: string, part: number): { reasons: string[]; since: string | null } {
  const acts = release.acts.filter((a) => a.page_id === pageId && a.on === `part ${part}`);
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
  query: { at?: string | null; released?: string | null }
): Promise<InsideNode | null> {
  if (!membersOnly()) return null;
  const standing = await loadStanding();
  if (standing.state !== "signed_in" || !standing.mine.member) return null;
  const versions = detail.versions ?? [];
  const who = standing.externalId;

  // Pages of this node released to a label this reader reads, or outside. A
  // failure loses the tabs, never the page.
  const tabs: ReleasedTab[] = [];
  const releases = new Map<string, ReceivedRelease>();
  const listed = await fetchReleases(who, detail.claim.id).catch(() => ({ received: [], asked: [] }));
  for (const row of listed.received) {
    const release = await fetchRelease(who, row.release_id).catch(() => null);
    if (!release) continue;
    releases.set(row.release_id, release);
    const node = release.nodes.find((n) => n.node_id === detail.claim.id);
    const released = node?.versions.find((v) => v.state === "released_whole" || v.state === "released_in_part");
    if (!released) continue;
    tabs.push({
      release_id: row.release_id,
      page_id: released.page_id,
      outside: row.released_to === "outside this deployment",
      released_to: row.released_to,
      version_of: released.version_of,
      from_label: listed.asked.find((a) => a.release_id === row.release_id)?.page_label,
    });
  }
  const multiLabel = standing.mine.clearance.some((l) => l !== "public") || versions.some((v) => v.label !== "public") || versions.length > 1;
  if (versions.length <= 1 && tabs.length === 0 && !multiLabel) return null;

  const base = {
    nodeLabel: (detail.claim as { label?: string }).label ?? null,
    versions,
    leftStanding: detail.left_standing ?? [],
    notExaminedAt: detail.not_examined_at ?? [],
    released: tabs,
    mayAsk: standing.mine.permissions.includes("direct") && versions.some((v) => v.label !== "public"),
  };
  const wantedReleased = query.released ? tabs.find((t) => t.page_id === query.released) : undefined;
  if (wantedReleased) {
    const page = await fetchReleasedPage(who, wantedReleased.release_id, wantedReleased.page_id).catch(() => null);
    const release = releases.get(wantedReleased.release_id);
    if (page && release) return { ...base, open: { kind: "released", tab: wantedReleased, view: viewOfReleasedPage(wantedReleased, release, page) } };
  }
  return { ...base, open: whichToOpen(versions, query.at) };
}
