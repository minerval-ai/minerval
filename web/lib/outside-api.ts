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
  showing_id?: string;
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
