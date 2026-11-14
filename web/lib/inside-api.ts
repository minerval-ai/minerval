import "server-only";
import { accountFetch, pathSegment } from "./account-api";

// Server-only client for what a member of a private deployment works
// through once it holds material at more than one label: showing a node's
// page to readers who do not read its label, the gates, a
// boundary's redaction policy, sending outside, and sets of files
// (docs/showing-a-page.md, docs/published-pages.md, docs/file-sets.md).
// Every call names the signed-in person, and the API decides what they may
// read and do: these routes exist only where READS=members.
//
// The shapes are the API's own (snake_case), written out here because the
// web app is a separate package.

const seg = pathSegment;

// --- showings (GET /showings, GET /showings/:id, GET /showings/:id/pages/:page_id) ---

/** One of the four states a node under a showing is in, as the readers it is shown to are told. */
export type NodeState = "not_yet_assessed" | "released_whole" | "released_in_part" | "held";

/** A showing as the side it is shown to lists it. */
export interface ShownShowingRow {
  showing_id: string;
  node_id: string;
  shown_to: string;
  form: "once" | "standing";
  scope: "node" | "under";
  asked_at: string;
  ended_at: string | null;
}

/** One page under a showing, as the side it was asked for at sees it: where its redaction stands. */
export interface AskedPage {
  page_id: string;
  node_id: string;
  version_of: string;
  stage: "to_redact" | "to_check" | "at_gate" | "cannot_cross" | "overtaken";
  stage_in_words: string;
  round: number;
  redact_action_id: string | null;
  cannot_cross?: { category: string; note: string | null };
  audit_reasons?: string;
  /** For a page at the release gate: which kinds of part wait on which party. Kind and party, never text. */
  waiting_on?: Array<{ part: number | null; kind: string; party: string; standing: "held" | "waiting" }>;
}

/** A showing as the side it was asked for at lists it. */
export interface AskedShowingRow {
  showing_id: string;
  node_id: string;
  node: string | null;
  page_label: string;
  shown_to: string;
  form: "once" | "standing";
  scope: "node" | "under";
  asked_at: string;
  ended_at: string | null;
  pages: AskedPage[];
}

/** One version of a node's page, described without any of its text. */
export interface ShownVersion {
  page_id: string;
  version_of: string;
  state: NodeState;
  held_because?: string;
  held_for?: string;
  shown_at?: string;
  source_id?: string | null;
  removals_under_the_policy?: Record<string, number>;
  parts_held?: number;
  of_parts?: number;
  held_kinds?: string;
  redaction_round: number;
  fingerprint: string | null;
  audit: string | null;
}

export interface ShownNode {
  node_id: string;
  text: string | null;
  under: string | null;
  covered_from: string;
  left_at?: string;
  left_because?: string;
  first_assessed_at: string | null;
  showing_began: string;
  state: NodeState;
  versions: ShownVersion[];
}

export interface ShowingAct {
  at: string;
  what: string;
  page_id?: string;
  on?: string;
  for_party?: string;
  by: string;
  rule_id?: string;
  holding: string[];
  reason?: string;
}

export interface ShownShowing {
  showing_id: string;
  shown_to: string;
  form: "once" | "standing";
  scope: string;
  asked_at: string;
  asked_by: string | null;
  asked_holding: string[];
  ended_at: string | null;
  ended_because: string | null;
  policy: { policy_id: string; version: number; hash: string } | null;
  nodes: ShownNode[];
  acts: ShowingAct[];
}

export interface ShownMark {
  at: number;
  category: string;
}

export interface ShownPart {
  part: number;
  kind: string;
  descriptor: string;
  hash: string;
  /** Released: the text as written, with each removal marked where it was made. */
  text?: string;
  removals_marked?: ShownMark[];
  salt?: string;
  /** Held: the words that stand in its place. */
  held?: string;
}

export interface ShownPage extends ShownVersion {
  always_shown?: Record<string, unknown>;
  always_shown_as_hashed?: { text: string; salt: string; hash: string };
  earlier_fingerprints?: string[];
  parts?: ShownPart[];
  verification: { ok: boolean; problems: string[]; checked: number; held: number } | null;
}

export async function fetchShowings(
  externalId: string,
  nodeId?: string
): Promise<{ shown: ShownShowingRow[]; asked: AskedShowingRow[]; hold_reasons: Record<string, string>; end_reasons: Record<string, string> }> {
  const query = nodeId ? `?node_id=${encodeURIComponent(nodeId)}` : "";
  return accountFetch(`/showings${query}`, { actingUser: externalId });
}

export function fetchShowing(externalId: string, id: string): Promise<ShownShowing> {
  return accountFetch(`/showings/${seg(id)}`, { actingUser: externalId });
}

export function fetchShownPage(externalId: string, showingId: string, pageId: string): Promise<ShownPage> {
  return accountFetch(`/showings/${seg(showingId)}/pages/${seg(pageId)}`, { actingUser: externalId });
}

export interface AskShowing {
  node_id: string;
  page_label: string;
  to_label?: string;
  outside?: boolean;
  form: "once" | "standing";
  scope: "node" | "under";
}

export function askShowing(
  externalId: string,
  body: AskShowing
): Promise<{ showing_id: string; pages_opened: number; sending?: string }> {
  return accountFetch("/showings", { method: "POST", actingUser: externalId, body });
}

export function endShowing(externalId: string, id: string, reason: string): Promise<unknown> {
  return accountFetch(`/showings/${seg(id)}/end`, { method: "POST", actingUser: externalId, body: { reason } });
}

export function holdShownPage(
  externalId: string,
  showingId: string,
  pageId: string,
  body: { lift?: boolean; reason?: string }
): Promise<unknown> {
  return accountFetch(`/showings/${seg(showingId)}/pages/${seg(pageId)}/hold`, {
    method: "POST",
    actingUser: externalId,
    body,
  });
}

export function payForShowingWork(
  externalId: string,
  showingId: string,
  pageId: string,
  owls: number
): Promise<{ status: string; work: string; note?: string }> {
  return accountFetch(`/showings/${seg(showingId)}/pages/${seg(pageId)}/commission`, {
    method: "POST",
    actingUser: externalId,
    body: { owls },
  });
}

// --- the gate (GET /gate/queue, POST /gate/decisions, /gates, /gate/backlog) ---------

export interface QueueStanding {
  party: { id: string; name: string };
  standing: "released" | "held" | "waiting";
}

export interface QueueItem {
  item_id: string;
  page_id: string;
  /** What kind of thing the item is: a node's page, an answer, a mandate, a message, funding. */
  kind_of_thing: string;
  kind_of_thing_in_words: string;
  showing_id: string;
  node_id?: string;
  /** The node's wording, where the person reads the node. */
  node?: string;
  /** A hold one of the person's parties has already placed on the item. */
  held?: Array<{ party: { id: string; name: string }; reason: string | null; since: string | null }>;
  /** The Redactor's hold, where it holds the item, and a delay that stands. */
  held_by_the_redactor?: { reason: string; since: string };
  delayed_until?: string;
  the_redactor_proposes: "let through" | "hold" | "delay";
  audit: string | null;
  waiting_since: string | null;
  /** The part's place in the item; null for the item itself (a page with its verdict). */
  part: number | null;
  kind: string;
  decide_for: Array<{ id: string; name: string; setting?: string }>;
  rests_on: QueueStanding[];
  removals_by_category?: Record<string, number>;
  redactor_least_sure?: boolean;
  why_least_sure?: string[];
  /** The part as it was written, where the person reads at the label it was written at. */
  as_written?: string;
  /** The part as it would be shown if released: after removals, with the marks. */
  as_it_would_be_shown?: string;
  /**
   * The passages removed from the part. With the Redactor's note where the
   * person reads at the item's label; without it, and only for a part that
   * rests on the material of outside parties they release for and no one
   * else's, where they do not.
   */
  removals?: Array<{ passage: string; category: string; redactor_note?: string }>;
  /** What is shown whenever anything of the item is shown. */
  always_shown?: Record<string, unknown>;
  /** The node's wording as the page would show it, where the node is at the page's label. */
  wording_as_it_would_be_shown?: string;
  /** The API's sentence, where the person does not read at the label the item was written at: what they are and are not shown. */
  shown_as_released?: string;
}

export interface GateQueue {
  items: QueueItem[];
  more_waiting: boolean;
  not_reading_the_label?: string;
  /** The fixed list a hold gives its reason from: each key with the words the other side is told. */
  hold_reasons: Record<string, string>;
  /** The acts at a gate, each in the API's words. */
  acts: Record<string, string>;
  note: string;
}

export function fetchGateQueue(externalId: string): Promise<GateQueue> {
  return accountFetch("/gate/queue?limit=200", { actingUser: externalId });
}

export type GateDecision = "release" | "approve" | "remove" | "hold" | "delay" | "lift";

export interface Decided {
  decided: number;
  unchanged: number;
  refused: Array<{ item: { item_id?: string; part?: number | null }; why: string }>;
  shown: string[];
}

export function decideAtGate(
  externalId: string,
  body: {
    party_id?: string;
    decision: GateDecision;
    reason?: string;
    until?: string;
    items: Array<{ item_id: string; part?: number | null; passage?: string; category?: string }>;
  }
): Promise<Decided> {
  return accountFetch("/gate/decisions", { method: "POST", actingUser: externalId, body });
}

export interface GateSetting {
  setting_id: string;
  kind: string;
  scope: string;
  scope_in_words: string;
  scope_ref: string | null;
  party: { id: string; name: string } | null;
  mode: string;
  in_words: string;
  set_by: string | null;
  set_holding: string[];
  set_at: string;
  made_from_release_rule?: string;
  delay_hours?: number;
  batch_hours?: number;
}

export interface Gate {
  gate_id: string;
  from: string;
  to: string;
  to_outside: boolean;
  flow: "asked" | "everything";
  flow_in_words: string;
  backlog_shown_to_the_other_side: boolean;
  send_as_released?: boolean;
  keeps_the_other_side_current: string;
  keep_current_mandate: string | null;
  keep_current_owls?: number;
  starting_positions: Record<string, string>;
  settings: GateSetting[];
  you_may_set: { the_gate_as_a_whole: boolean; for_parties: Array<{ id: string; name: string }> };
}

export interface Gates {
  gates: Gate[];
  modes: Record<string, string>;
  kinds: Record<string, string>;
  scopes: Record<string, string>;
  flows: Record<string, string>;
  acts: Record<string, string>;
}

export function fetchGates(externalId: string): Promise<Gates> {
  return accountFetch("/gates", { actingUser: externalId });
}

export function setGate(
  externalId: string,
  gateId: string,
  body: { flow?: string; backlog_shown?: boolean; send_as_released?: boolean; keep_current_mandate?: string | null; keep_current_owls?: number }
): Promise<unknown> {
  return accountFetch(`/gates/${seg(gateId)}`, { method: "PUT", actingUser: externalId, body });
}

export function setGateMode(
  externalId: string,
  gateId: string,
  body: { mode: string; kind?: string; scope?: string; scope_ref?: string; party_id?: string; delay_hours?: number; batch_hours?: number }
): Promise<{ setting_id: string; changed: boolean; applies: string; let_through_now: number }> {
  return accountFetch(`/gates/${seg(gateId)}/settings`, { method: "PUT", actingUser: externalId, body });
}

export function endGateSetting(externalId: string, settingId: string): Promise<unknown> {
  return accountFetch(`/gates/settings/${seg(settingId)}`, { method: "DELETE", actingUser: externalId });
}

export interface BacklogLine {
  kind: string;
  kind_in_words: string;
  waiting_on: string;
  in_words: string;
  party?: string;
  items: number;
  parts?: number;
  oldest_waiting_hours: number;
}

export interface GateBacklog {
  gates: Array<{ gate_id: string; from?: string; to: string; items_waiting: number; waiting: BacklogLine[] }>;
  /** What the person's labels asked of a label above, by the face asked, and how much has come back. */
  asked_from_here: Array<{
    asked_of: string;
    asked_at: string;
    requests: number;
    owls_put_behind_them: number;
    told_they_were_taken_up: number;
    answer_through_the_gate: number;
    answer_waiting_at_the_gate: number;
    nothing_back_yet: number;
  }>;
  note: string;
}

export function fetchGateBacklog(externalId: string): Promise<GateBacklog> {
  return accountFetch("/gate/backlog", { actingUser: externalId });
}

// --- redaction policies (GET /redaction-policies, PUT /redaction-policies) -----------

export interface PolicySummary {
  policy_id: string;
  boundary_id: string;
  version: number;
  hash: string;
  saved_at: string;
  /** True while the boundary is still on the text every boundary starts from. */
  starting_text: boolean;
  /** Present only for a reader of the label the pages are written at. */
  from_label?: string;
  shown_to: string;
  categories: string[];
}

export interface PolicyCategory {
  name: string;
  covers: string;
  examples: string;
}

export interface PolicyFull {
  policy_id: string;
  boundary_id: string;
  version: number;
  hash: string;
  saved_at: string;
  categories: PolicyCategory[];
  text: string;
}

export async function fetchPolicies(externalId: string): Promise<PolicySummary[]> {
  return (await accountFetch<{ policies: PolicySummary[] }>("/redaction-policies", { actingUser: externalId }))
    .policies;
}

export function fetchPolicy(externalId: string, id: string): Promise<PolicyFull> {
  return accountFetch(`/redaction-policies/${seg(id)}`, { actingUser: externalId });
}

export function savePolicy(
  externalId: string,
  body: { from_label: string; to_label?: string; outside?: boolean; categories: PolicyCategory[] }
): Promise<{ policy_id: string; version: number; hash: string }> {
  return accountFetch("/redaction-policies", { method: "PUT", actingUser: externalId, body });
}

// --- sending outside (GET /outbound and the routes beside it) -------------------------

export interface OutboundSend {
  at: string;
  how: string;
  result: string;
  the_public_graph_said?: string;
  by: string | null;
  holding: string[];
}

export interface OutboundPackage {
  package_id: string;
  sequence: number;
  state: string;
  built_at: string;
  sends: OutboundSend[];
}

export interface OutboundNode {
  showing_id: string;
  node_id: string;
  node: string | null;
  public_node_id: string | null;
  /** Where a node that exists only here stands on its way to having a node on the public graph, in the API's sentence. */
  waiting?: string;
  proposal?: {
    proposal_id: string;
    state: string;
    text: string;
    written_at: string;
    waits_on: Array<{ id: string; name: string }>;
    public_contribution_id: string | null;
  };
  sent: "as_released" | "by_a_person_each_time";
  packages: OutboundPackage[];
}

export function fetchOutbound(
  externalId: string,
  showingId?: string
): Promise<{ nodes: OutboundNode[]; how_sending_works: Record<string, string> }> {
  const query = showingId ? `?showing_id=${encodeURIComponent(showingId)}` : "";
  return accountFetch(`/outbound${query}`, { actingUser: externalId });
}

export interface SendReport {
  proposals: Array<{ node_id: string; state: string }>;
  built: number;
  sent: Array<{ package_id: string; node_id: string; sequence: number; result: string; detail: string | null }>;
}

export function sendOutside(externalId: string, showingId: string): Promise<SendReport> {
  return accountFetch("/outbound/send", { method: "POST", actingUser: externalId, body: { showing_id: showingId } });
}

export function takePackageFile(
  externalId: string,
  packageId: string
): Promise<{ file_name: string; package: unknown }> {
  return accountFetch(`/outbound/packages/${seg(packageId)}/file`, {
    method: "POST",
    actingUser: externalId,
    body: {},
  });
}

export function writeProposal(
  externalId: string,
  body: { showing_id: string; node_id: string; text?: string }
): Promise<{ proposal_id: string; state: string; in_words: string }> {
  return accountFetch("/outbound/proposals", { method: "POST", actingUser: externalId, body });
}

// --- file sets (docs/file-sets.md) -----------------------------------------------------

export interface WaysIn {
  upload: boolean;
  register_directory: boolean;
  sandbox_configured: boolean;
}

export interface FileSetView {
  id: string;
  name: string;
  slug: string;
  description: string;
  origin: "upload" | "directory";
  directory: string | null;
  party: { id: string; name: string; is_own_organization: boolean };
  stake: string;
  label: string;
  state: "open" | "hashing" | "closed" | "failed";
  problem: string | null;
  file_count: number;
  total_bytes: number;
  manifest_sha256: string | null;
  closed_at: string | null;
  enabled: boolean;
  commands: number;
  analyses_kept: number;
  files_kept: number;
  created_at: string;
  updated_at: string;
}

export interface FileSetFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SandboxCommand {
  id: string;
  called_at: string;
  duration_ms: number | null;
  outcome: string;
  exit_code: number | null;
  error: string | null;
  output_chars: number | null;
  output_sha256: string | null;
  file_sets: Array<{ id: string; name: string }>;
  source_id: string | null;
  kept_at: string | null;
  command: string;
  files: Array<{ path: string; sha256: string; chars: number }>;
  run_id: string | null;
  agent: string | null;
  claim_id: string | null;
}

export function fetchFileSets(
  externalId: string
): Promise<{ notice: string; ways_in: WaysIn; file_sets: FileSetView[] }> {
  return accountFetch("/file-sets", { actingUser: externalId });
}

export function fetchFileSet(
  externalId: string,
  id: string
): Promise<{ notice: string; ways_in: WaysIn; file_set: FileSetView }> {
  return accountFetch(`/file-sets/${seg(id)}`, { actingUser: externalId });
}

export async function fetchFileSetFiles(externalId: string, id: string, limit = 500): Promise<FileSetFile[]> {
  return (
    await accountFetch<{ files: FileSetFile[] }>(`/file-sets/${seg(id)}/files?limit=${limit}`, {
      actingUser: externalId,
    })
  ).files;
}

export function fetchFileSetCommands(
  externalId: string,
  id: string
): Promise<{ commands: SandboxCommand[]; not_shown: number; not_shown_note?: string }> {
  return accountFetch(`/file-sets/${seg(id)}/commands?limit=200`, { actingUser: externalId });
}

export interface NewFileSet {
  name: string;
  description?: string;
  party_id: string;
  stake: string;
  label?: string;
  directory?: string;
}

export function addFileSet(externalId: string, body: NewFileSet): Promise<{ file_set: FileSetView }> {
  return accountFetch("/file-sets", { method: "POST", actingUser: externalId, body });
}

export function registerDirectory(externalId: string, body: NewFileSet): Promise<{ file_set: FileSetView }> {
  return accountFetch("/file-sets/register", { method: "POST", actingUser: externalId, body });
}

export function closeFileSet(externalId: string, id: string): Promise<{ file_set: FileSetView }> {
  return accountFetch(`/file-sets/${seg(id)}/close`, { method: "POST", actingUser: externalId, body: {} });
}

export function rehashFileSet(externalId: string, id: string): Promise<{ file_set: FileSetView }> {
  return accountFetch(`/file-sets/${seg(id)}/rehash`, { method: "POST", actingUser: externalId, body: {} });
}

export function switchFileSet(externalId: string, id: string, enabled: boolean): Promise<{ file_set: FileSetView }> {
  return accountFetch(`/file-sets/${seg(id)}`, { method: "PATCH", actingUser: externalId, body: { enabled } });
}
