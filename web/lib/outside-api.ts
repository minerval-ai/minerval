import "server-only";
import { accountFetch, pathSegment } from "./account-api";

// Server-only client for what a members-only deployment does on the public
// graph besides showing pages, and what comes back (docs/outward-acts.md):
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
  public_mandates?: Array<{ id: string; title: string | null; status: string | null; budget_owls: number | null; spent_owls: number | null; public: true }>;
  who_may_act: string;
  what_a_public_mandate_shows?: string;
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

export interface KeepCurrent {
  setting: "on" | "off";
  public_mandate_id: string | null;
  delay_hours: number;
  batch_hours: number;
  sends: boolean;
  in_words: string;
  set_at: string | null;
  what_it_shows_outside: string;
  last_not_taken?: { at: string; the_public_graph_said: string | null };
  versions: Array<{ node_id: string; node: string | null; version_of: string; due_at: string; state: "waiting" | "sent" | "not_sent"; because?: string }>;
  versions_note: string;
  left_out: Array<{ id: string; mandate_id: string | null; node_id: string | null; node: string | null; set_at: string; by: string | null }>;
}

export interface StandingChoice {
  key: "keep_public_current" | "send_failure_facts" | "send_redacted_reports";
  name: string;
  on: boolean;
  what_it_shows_outside: string;
  set_by: string | null;
  set_at: string | null;
  who_may_set_it: string;
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
  offered_for_sending: boolean;
  facts: { tool: string | null; kind: string; severity: string; minerval: { migration: number; prompt_set: string }; seen: number; first_seen: string; last_seen: string };
  as_written: { title: string; body: string };
  sending?: {
    sending_id: string;
    state: string;
    redaction_action_id?: string | null;
    redaction_expected_cost_owls?: number | null;
    as_it_would_go?: { title: string; body: string };
    removed?: Array<{ from: string; category: string; note: string }>;
    sent_at?: string;
    sent_by?: string | null;
    facts_sent_at?: string;
    facts_said_seen?: number | null;
    came_back?: { status: string; maintainers_note: string | null; issue_url: string | null; asked_at: string };
  };
}

export interface ReportsForSending {
  reports: ReportForSending[];
  listed: string;
  what_sending_shows: string;
  who_may_send: string;
}

const get = <T>(path: string, externalId: string) => accountFetch<T>(path, { actingUser: externalId });
const post = <T>(path: string, externalId: string, body: unknown = {}, method = "POST") => accountFetch<T>(path, { method, actingUser: externalId, body });

export const fetchPublicAccount = (who: string) => get<PublicAccount>("/outside/account", who);
export const fetchOutwardLog = async (who: string) => (await get<{ acts: OutwardAct[] }>("/outside/log?limit=100", who)).acts;
export const fetchKeepCurrent = (who: string) => get<KeepCurrent>("/outside/keep-current", who);
export const fetchStandingChoices = async (who: string) => (await get<{ choices: StandingChoice[] }>("/outside/choices", who)).choices;
export const fetchPublicRequests = (who: string, nodeId?: string) => get<PublicRequests>(`/outside/requests${nodeId ? `?node_id=${seg(nodeId)}` : ""}`, who);
export const fetchSaidBack = (who: string) => get<{ contributions: ReceivedContribution[]; how_it_works: string }>("/outside/said-back", who);
export const fetchReportsForSending = (who: string) => get<ReportsForSending>("/outside/reports", who);
export const fetchPublicConversation = (who: string, id: string) => get<Record<string, any>>(`/outside/mandates/conversations/${seg(id)}`, who);

export const setStandingChoice = (who: string, key: string, body: { on: boolean; public_mandate_id?: string | null; delay_hours?: number; batch_hours?: number }) =>
  post<Record<string, unknown>>(`/outside/choices/${seg(key)}`, who, body, "PUT");
export const adoptPublicRequest = (who: string, id: string, label?: string) => post<{ adoption_id: string; request_id: string; already: boolean }>(`/outside/requests/${seg(id)}/adopt`, who, label ? { label } : {});
export const takeUpPublicRequest = (who: string, adoptionId: string) => post<Record<string, unknown>>(`/outside/requests/adopted/${seg(adoptionId)}/take-up`, who);
export const declinePublicRequest = (who: string, adoptionId: string, reason: string) => post<Record<string, unknown>>(`/outside/requests/adopted/${seg(adoptionId)}/decline`, who, { reason });
export const openPublicMandate = (who: string, message: string) => post<{ conversation_id: string | null }>("/outside/mandates", who, { message });
export const sayToPublicGrantmaker = (who: string, id: string, message: string) => post<Record<string, unknown>>(`/outside/mandates/conversations/${seg(id)}/messages`, who, { message });
export const fundPublicMandate = (who: string, id: string, budgetOwls: number) => post<{ public_mandate_id: string | null }>(`/outside/mandates/conversations/${seg(id)}/fund`, who, { budget_owls: budgetOwls });
export const backPublicMandate = (who: string, id: string, owls: number) => post<Record<string, unknown>>(`/outside/mandates/${seg(id)}/back`, who, { owls });
export const fundPublicNode = (who: string, nodeId: string, owls: number) => post<Record<string, unknown>>(`/outside/nodes/${seg(nodeId)}/fund`, who, { owls });
export const askPublicMandate = (who: string, nodeId: string, mandateId: string) => post<Record<string, unknown>>(`/outside/nodes/${seg(nodeId)}/raise`, who, { mandate_id: mandateId });
export const leaveOutOfKeepCurrent = (who: string, body: { mandate_id?: string; node_id?: string; label?: string }) => post<{ id: string }>("/outside/keep-current/leave-out", who, body);
export const takeBackLeaveOut = (who: string, id: string) => post<{ lifted: boolean }>(`/outside/keep-current/leave-out/${seg(id)}`, who, undefined, "DELETE");
export const sendReport = (who: string, sendingId: string) => post<Record<string, unknown>>(`/outside/reports/${seg(sendingId)}/send`, who);
export const sendReportFacts = (who: string, sendingId: string) => post<Record<string, unknown>>(`/outside/reports/${seg(sendingId)}/send-facts`, who);
export const commissionOutwardWork = (who: string, actionId: string, owls: number) => post<{ status: string; work: string; note?: string }>(`/outside/work/${seg(actionId)}/commission`, who, { owls });
