import "server-only";
import { accountFetch, pathSegment } from "./account-api";

// Server-only client for what a members-only deployment does on the public
// graph besides releasing pages, and what comes back (docs/outward-acts.md):
// the organisation's public owls and public mandates, public requests
// adopted and taken up, keeping public versions current, what readers said
// back about published pages, and agents' reports sent to Minerval's
// maintainers. Every call names the signed-in person, and the API decides
// what they may do. The shapes are the API's own.

const seg = pathSegment;

/** The API's sentences are written in American spelling; the site's own copy is British. */
export function british(text: string): string {
  return text.replace(/\borganization/g, "organisation").replace(/\bOrganization/g, "Organisation");
}

export interface PublicAccount {
  connected: boolean;
  in_words?: string;
  account?: { id: string | null; name: string | null };
  public_owls?: number;
  public_owls_statement?: string;
  public_mandates?: Array<{
    id: string;
    title: string | null;
    status: string | null;
    budget_owls: number | null;
    spent_owls: number | null;
    /** The conversation with the public Grantmaker it was funded from, where known. */
    conversation_id?: string | null;
    public: true;
  }>;
  who_may_act: string;
  what_a_public_mandate_shows?: string;
  /** The fingerprint of the key this deployment signs with now; null where it has none. */
  signing_key_fingerprint?: string | null;
  /** Whether and under what the signing key is registered on the public graph; null where no key is registered. Absent from an older API. */
  registration?: PublisherRegistration | null;
  registration_in_words?: string;
}

export interface PublisherRegistration {
  registered_at: string;
  key_fingerprint: string;
  account: { id: string | null; name: string | null };
  declared_interest: string | null;
  is_the_current_key: boolean | null;
  read_from: "the public graph" | "this deployment's log";
  registered_from_here: { at: string; by: string | null } | null;
}

export interface PublicConversation {
  id: string;
  opened_at: string | null;
  opened_by: string | null;
  opened_from_here: boolean;
  title: string | null;
  status_on_the_public_graph: string | null;
  funded: boolean;
  public_mandate_id: string | null;
  funded_from_here?: { at: string; by: string | null };
  messages_from_here: number;
}

export interface PublicConversations {
  conversations: PublicConversation[];
  read_from_the_public_graph: boolean;
  in_words: string;
}

export interface OutwardAct {
  id: string;
  at: string;
  what: string;
  kind: string;
  by: string | null;
  holding: string[];
  on_the_public_graph: string | null;
  sent: Record<string, unknown>;
  result: "done" | "refused" | "failed";
  the_public_graph_said?: string;
}



export interface PublicRequest {
  public_request_id: string;
  ask: string;
  why: string;
  satisfied_by: string;
  who_could: string | null;
  addressed_to: string | null;
  bears_on: Array<{ id: string; text: string }>;
  bears_on_text: string | null;
  state_on_the_public_graph: string;
  filed_at: string;
  here: Array<{
    adoption_id: string;
    request_id: string;
    adopted_at: string;
    state_here: string;
    taken_up_in_public_at: string | null;
    declined_in_public?: { at: string; because: string };
  }>;
}

export interface PublicRequests {
  /** With a node named: whether it is the public graph's own, and what funding it there shows. */
  node_is_on_the_public_graph?: boolean;
  what_funding_it_there_shows?: string;
  requests: PublicRequest[];
  as_of: string;
  adopting: string;
  taking_up_in_public: string;
}

export interface ReceivedContribution {
  id: string;
  on_the_public_graph: string;
  node_id: string;
  node: string | null;
  type: string;
  submitted_at: string;
  received_at: string;
  /** The label the page it was made through was written at, where its reassessment is paid for; withheld where the reader does not read it. Absent from an older API. */
  page_label?: string | { withheld: true };
  release_id?: string;
  /** The contribution as it was made on the public graph: public text, written outside this deployment. */
  text_written_outside_this_deployment?: string;
  addresses_it_cites?: string[];
  repeats?: string;
  given_to_the_steward_at?: string;
  reassessment?: string;
  reassessment_as_of?: string | null;
}

export interface ReportForSending {
  report_id: string;
  filed_by: string;
  triage: string;
  audit_note: string | null;
  about: string | null;
  offered_to_the_gate: boolean;
  facts: { tool: string | null; kind: string; severity: string; minerval: { migration: number; prompt_set: string }; seen: number; first_seen: string; last_seen: string };
  as_written: { title: string; body: string };
  at_the_gate?: { item_id: string; offered_at: string; stands: string };
  sent?: { at: string; on_the_public_graph: string | null; said_seen: number | null; came_back?: { status: string; maintainers_note: string | null; issue_url: string | null; asked_at: string } };
}

export interface ReportsForSending {
  reports: ReportForSending[];
  listed: string;
  how_a_report_goes: string;
}

const get = <T>(path: string, externalId: string) => accountFetch<T>(path, { actingUser: externalId });
const post = <T>(path: string, externalId: string, body: unknown = {}, method = "POST") => accountFetch<T>(path, { method, actingUser: externalId, body });

export const fetchPublicAccount = (who: string) => get<PublicAccount>("/outside/account", who);

// ---- this deployment's connection to minerval.ai (docs/organizations.md, "Connecting") ----

export type { DeploymentGrant } from "./organization-permissions";
import type { DeploymentGrant } from "./organization-permissions";

export interface ConnectionView {
  connected: boolean;
  state: "none" | "waiting" | "connected" | "denied" | "expired" | "by_hand";
  api_url: string | null;
  key_id: string | null;
  code: string | null;
  link: string | null;
  code_expires_at: string | null;
  asked_grants: DeploymentGrant[];
  /** Where it runs, as stated when it connected. */
  hosting?: Hosting | null;
  /** The public graph's web address, for links to the organization there. */
  web_url?: string | null;
  /** The allowance on its spend, as last read, where an admin set one (micro-USD). */
  allowance?: { allowance_micro_usd: number; left_micro_usd: number } | null;
  /** The signed request to carry by hand, where it is connected that way. */
  by_hand_request?: string | null;
  organization: { id: string; name: string } | null;
  deployment: { id: string; name: string } | null;
  grants: DeploymentGrant[];
  connected_at: string | null;
  last_checked_at: string | null;
  problem: string | null;
}

export type Hosting = "own_machines" | "third_party" | "minerval";

/** What connecting would send, to fill the drawer's questions with. */
export interface ConnectWith {
  name: string;
  hosting: Hosting | null;
  /** Fixed by the operator (DEPLOYMENT_HOSTING): shown, not asked. */
  hosting_fixed: boolean;
  needs: Array<{ grant: DeploymentGrant; why: string }>;
  address: string | null;
  api_url: string;
}

export const fetchConnection = async (who: string) => (await get<{ connection: ConnectionView | null }>("/outside/connection", who)).connection;
export const fetchConnectionAndDefaults = (who: string) =>
  get<{ connection: ConnectionView | null; connect_with?: ConnectWith }>("/outside/connection", who);
export const startConnection = (who: string, body: { name: string; hosting?: Hosting; api_url?: string; replace?: boolean }) =>
  post<{ connection: ConnectionView }>("/outside/connection", who, body);
export const startConnectionByHand = (who: string, body: { name: string; hosting?: Hosting; replace?: boolean }) =>
  post<{ connection: ConnectionView }>("/outside/connection/by-hand", who, body);
export const replaceConnectionKey = (who: string) => post<{ connection: ConnectionView }>("/outside/connection/key", who);
export const checkConnection = (who: string) => post<{ connection: ConnectionView | null }>("/outside/connection/check", who);
export const disconnectConnection = (who: string) =>
  accountFetch<{ retired_there: boolean; said: string | null }>("/outside/connection", { method: "DELETE", actingUser: who });
export const fetchOutwardLog = async (who: string) => (await get<{ acts: OutwardAct[] }>("/outside/log?limit=100", who)).acts;
export const fetchPublicRequests = (who: string, nodeId?: string) => get<PublicRequests>(`/outside/requests${nodeId ? `?node_id=${seg(nodeId)}` : ""}`, who);
export const fetchSaidBack = (who: string) => get<{ contributions: ReceivedContribution[]; how_it_works: string }>("/outside/said-back", who);
export const fetchReportsForSending = (who: string) => get<ReportsForSending>("/outside/reports", who);
export const fetchPublicConversations = (who: string) => get<PublicConversations>("/outside/mandates/conversations", who);
export const fetchPublicConversation = (who: string, id: string) => get<Record<string, any>>(`/outside/mandates/conversations/${seg(id)}`, who);

export const adoptPublicRequest = (who: string, id: string, label?: string) => post<{ adoption_id: string; request_id: string; already: boolean }>(`/outside/requests/${seg(id)}/adopt`, who, label ? { label } : {});
export const takeUpPublicRequest = (who: string, adoptionId: string) => post<Record<string, unknown>>(`/outside/requests/adopted/${seg(adoptionId)}/take-up`, who);
export const declinePublicRequest = (who: string, adoptionId: string, reason: string, note?: string) =>
  post<Record<string, unknown>>(`/outside/requests/adopted/${seg(adoptionId)}/decline`, who, note ? { reason, note } : { reason });
export const openPublicMandate = (who: string, message: string) => post<{ conversation_id: string | null }>("/outside/mandates", who, { message });
export const sayToPublicGrantmaker = (who: string, id: string, message: string) => post<Record<string, unknown>>(`/outside/mandates/conversations/${seg(id)}/messages`, who, { message });
export const fundPublicMandate = (who: string, id: string, budgetOwls: number) => post<{ public_mandate_id: string | null }>(`/outside/mandates/conversations/${seg(id)}/fund`, who, { budget_owls: budgetOwls });
export const backPublicMandate = (who: string, id: string, owls: number) => post<Record<string, unknown>>(`/outside/mandates/${seg(id)}/back`, who, { owls });
export const fundPublicNode = (who: string, nodeId: string, owls: number) => post<Record<string, unknown>>(`/outside/nodes/${seg(nodeId)}/fund`, who, { owls });
export const askPublicMandate = (who: string, nodeId: string, mandateId: string) => post<Record<string, unknown>>(`/outside/nodes/${seg(nodeId)}/raise`, who, { mandate_id: mandateId });

// ---- following the public graph (docs/organizations.md, "The mirror") ----

export type MirrorOwner = "operator" | "admin" | "organization";

export interface MirrorFeedKey {
  key_id: string;
  public_key: string;
  feed_id: string | null;
  read_from: string;
  first_seen_at: string;
  accepted: boolean;
  accepted_at: string | null;
  accepted_by: string | null;
  current: boolean;
}

export interface MirrorSetupCheck {
  key: "connected" | "feed_key" | "embedding" | "shape";
  status: "pass" | "fail" | "unknown";
  message: string;
  owner: MirrorOwner;
}

export interface MirrorStatusView {
  applied: boolean;
  public_graph_as_of: string | null;
  complete: boolean;
  sequence: number | null;
  batch_hash: string | null;
  applied_at: string | null;
  feed_id: string | null;
  key_id: string | null;
  searchable_claims: number;
  last_refusal: { sequence: number | null; code: string; message: string; refused_at: string } | null;
}

export interface MirrorSetup {
  in_app: boolean;
  source: { kind: "network" | "files"; set_by: "app" | "settings"; address: string | null };
  state: "following" | "paused" | "not_started";
  started_at: string | null;
  started_by: string | null;
  paused_at: string | null;
  paused_by: string | null;
  last_checked_at: string | null;
  last_check_error: string | null;
  check_requested: boolean;
  interval_seconds: number;
  checks: MirrorSetupCheck[];
  keys_set_by_settings: boolean;
  keys: MirrorFeedKey[];
  feed: { head: number | null; latest_snapshot: number | null; error: string | null } | null;
  status: MirrorStatusView;
  refusal_owner: "operator" | "admin" | null;
  files: Array<{ name: string; sequence: number; applied: boolean }> | null;
  /** The newest batches applied here; notes are given to administrators only. Absent from an older API. */
  batches?: Array<{
    sequence: number;
    kind: string;
    cut_at: string;
    applied_at: string;
    received_from: string | null;
    written: number;
    removed: number;
    notes: {
      merged_with_local_rows: number;
      kept_claims: number;
      kept_rows: number;
      local_rows_followed: number;
      local_judgments_retired: number;
    } | null;
  }>;
}

export const fetchMirrorSetup = async (who: string) => (await get<{ mirror: MirrorSetup }>("/mirror/setup", who)).mirror;
export const followMirror = (who: string) => post<{ mirror: MirrorSetup }>("/mirror/follow", who);
export const pauseMirror = (who: string) => post<{ mirror: MirrorSetup }>("/mirror/pause", who);
export const checkMirror = (who: string) => post<{ mirror: MirrorSetup }>("/mirror/check", who);
export const readMirrorKeys = (who: string) => post<{ read: number; error: string | null; mirror: MirrorSetup }>("/mirror/feed-keys/read", who);
export const acceptMirrorKey = (who: string, keyId: string) => post<{ mirror: MirrorSetup }>(`/mirror/feed-keys/${seg(keyId)}/accept`, who);
