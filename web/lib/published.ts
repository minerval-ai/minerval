// A page another graph publishes of a node (docs/published-pages.md): what
// the API serves of it, and the few words the site says about it in more
// than one place.
import type { PublishedPageShape } from "./published-page/shape";
import type { PackageAct, PackageCheck, PackageVersion } from "./published-page/verify";

export interface PublishedOnNode {
  contribution_id: string | null;
  review: "admitted" | "not admitted" | "waiting for review";
  on_the_nodes_page: boolean;
  attached_package?: number;
  attached_at?: string;
  taken_off_by_the_nodes_steward?: string;
  weighed_in_the_nodes_assessment: { package: number; assessed_at: string } | null;
}

export interface PublishedPageSummary {
  published_page_id: string;
  node_id: string;
  node?: string | null;
  publisher: { account_id: string; name: string; key_id: string };
  form: "once" | "standing" | null;
  scope: "node" | "under" | null;
  showing_began: string | null;
  asked_at: string | null;
  ended: { at: string; because: string } | null;
  state: "not_yet_assessed" | "released_whole" | "released_in_part" | "held" | null;
  version_of: string | null;
  held?: { because: string | null; since: string | null };
  shown_version_of?: string;
  shown_state?: string;
  parts?: number;
  parts_held?: number;
  held_kinds?: string;
  packages_received: number;
  first_received_at: string;
  on_the_node: PublishedOnNode;
  /** Contributions made on this graph through the page and admitted, and how many stand with no answer from the publishing graph. */
  said_back?: { admitted: number; unanswered: number };
}

/** A contribution made on this graph through a published page, with what the publishing graph has said became of it (docs/outward-acts.md). */
export interface SaidBackEntry {
  contribution_id: string;
  type: string;
  submitted_at: string;
  review: "admitted" | "not admitted" | "waiting for review";
  state: string;
  in_words: string;
}

export interface PublishedPageView extends Omit<PublishedPageSummary, "publisher" | "said_back"> {
  package: number;
  received_at: string;
  publisher: {
    account_id: string;
    name: string;
    key_id: string;
    public_key: string;
    runs_on: string;
    attested_by: string;
    declared_interest: string | null;
    registered_at: string | null;
  };
  page: PublishedPageShape | null;
  source_id: string | null;
  audit: string | null;
  fingerprint: string | null;
  policy: { version: number; hash: string; text: string } | null;
  record: {
    made: null | {
      prompt_set: string | null;
      assessed_by_model: string | null;
      redacted_by_model: string | null;
      role_additions: unknown[];
      run_log: null | { sealed: boolean; seal: string | null; steps: number | null; chain_verifies: boolean | null };
      paid_for: null | { by: string; stake: string };
    };
    prompt_set_is_this_graphs: boolean | null;
    sent: string;
    acts: PackageAct[];
  };
  versions: PackageVersion[];
  said_back?: SaidBackEntry[];
  /** What the publishing deployment's package says of keeping public versions current; null on a package made before the setting existed. */
  keeps_public_versions_current?: { setting: "on" | "off"; a_public_mandate_pays_for_it: boolean } | null;
  check: PackageCheck;
  packages: Array<{ package: number; state: string; received_at: string; hash: string }>;
  /**
   * Set when the page was not published from another graph but shown inside
   * this deployment, to a label its reader reads, from a label they do not
   * (docs/showing-a-page.md). It is the same tab, drawn by the same
   * components; what differs is whose page it is said to be and where its
   * record is read from (components/claim/InsideVersions.tsx).
   */
  inside?: {
    tab: { showing_id: string; page_id: string; outside: boolean; shown_to: string; version_of: string; from_label?: string };
    showing: import("./inside-api").ShownShowing;
    page: import("./inside-api").ShownPage;
  };
}

/** The second tab's name, as the owner of the design named it. */
export const SEALED_TAB = "Redacted assessment on sealed evidence";

export function day(iso: string | null | undefined): string {
  if (!iso) return "a date not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "a date not recorded" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** One of the four states, in words. */
export function stateWords(p: { state: string | null; parts?: number; parts_held?: number; held_kinds?: string; held?: { because: string | null; since: string | null } }): string {
  switch (p.state) {
    case "not_yet_assessed":
      return "Not yet assessed";
    case "released_whole":
      return "Released whole";
    case "released_in_part":
      return `Released in part: ${p.parts_held} of ${p.parts} parts held (${p.held_kinds})`;
    case "held":
      return `Held${p.held?.because ? `: ${p.held.because}` : ""}${p.held?.since ? `, since ${day(p.held.since)}` : ""}`;
    case "not_redacted":
      return "Replaced by a later version before it was redacted";
    default:
      return "Not recorded";
  }
}

/** How a showing was asked for, in a sentence. */
export function showingWords(p: { form: string | null; scope: string | null; asked_at: string | null; showing_began: string | null; ended: { at: string; because: string } | null }): string {
  const form =
    p.form === "standing"
      ? `Kept published since ${day(p.asked_at)}, so each later version follows and a version that is held shows as held`
      : `Shown once, on ${day(p.asked_at)}, with nothing undertaken about later versions`;
  const scope = p.scope === "under" ? "this node and what sits under it" : "this node alone";
  return `${form}; ${scope}. It began ${p.showing_began ?? "at a time not recorded"}.${p.ended ? ` It ended on ${day(p.ended.at)}: ${p.ended.because}.` : ""}`;
}
