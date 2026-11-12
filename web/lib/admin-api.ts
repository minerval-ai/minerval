import "server-only";
import { accountFetch, pathSegment } from "./account-api";

// Server-only client for what a members-only deployment's administrators
// work through: the setup checklist, permissions, labels and parties,
// connections, owls the deployment creates, the standing mandates and the
// usage report (docs/accounts.md, "Members-only deployments";
// docs/connections.md; docs/usage-report.md). Every call names the signed-in
// person, and the API decides what they may do: these routes exist only
// where READS=members, and each write takes a signed-in session.
//
// The shapes are the API's own (snake_case), written out here because the
// web app is a separate package.

// An id or a name as exactly one segment of a backend path (see pathSegment).
const seg = pathSegment;

// --- the setup checklist (GET /setup/checklist) --------------------------------

export interface PreflightCheck {
  name: string;
  status: "pass" | "fail" | "not_applicable";
  /** Whether a fail here stops agent work on this deployment. */
  blocking: boolean;
  /** One sentence, the API's own. */
  message: string;
}

export interface PreflightReport {
  holds_private_material: boolean | null;
  ready: boolean;
  agent_work: "allowed" | "refused";
  checks: PreflightCheck[];
}

export interface Holders {
  accounts: number;
  groups: number;
}

export interface PermissionHolders extends Holders {
  permission: string;
  scope: "none" | "label" | "party";
  by_label?: Array<{ label: string } & Holders>;
  by_party?: Array<{ party: { id: string; name: string } } & Holders>;
}

export interface ChecklistLabel {
  name: string;
  reads: string[];
  model_providers_cleared: string[];
  outside_services_cleared: string[];
  roles_not_served: Array<{ role: string; model: string; provider: string | null }>;
}

export interface StandingMandate {
  name: "general" | "governance";
  title: string;
  objective: string;
  mandate: { id: string; status: string; budget_owls: number; daily_owls: number; running: boolean } | null;
}

export interface SetupChecklist {
  preflight: PreflightReport;
  permissions: PermissionHolders[];
  labels: ChecklistLabel[];
  undefined_labels_in_provider_setting: string[];
  standing_mandates: StandingMandate[];
  owls: {
    created_here: boolean;
    created_total_owls: number | null;
    spent_total_owls: number | null;
    unpriced_models: Array<{ setting: string; model: string }>;
  };
  usage_report: {
    price: "metered" | "flat";
    reporting: boolean;
    destination: "online" | "file" | "none";
    destination_ready: boolean;
    prepared: number;
    unsent: number;
    last_error: string | null;
  };
  connections: {
    total: number;
    on: number;
    offering_tools: number;
    failing: Array<{ id: string; name: string }>;
    tools_withdrawn: Array<{ connection: { id: string; name: string }; tool: string }>;
    credential_missing: Array<{ id: string; name: string }>;
  };
  material: {
    sources: number;
    sources_with_no_party: number;
    sources_by_party: Array<{ party: { id: string; name: string; is_own_organization: boolean }; sources: number }>;
    sources_waiting_for_review: number;
    nodes: number;
  };
}

export function fetchSetupChecklist(externalId: string): Promise<SetupChecklist> {
  return accountFetch<SetupChecklist>("/setup/checklist", { actingUser: externalId });
}

// --- permissions ---------------------------------------------------------------

export interface PermissionDefinition {
  name: string;
  scope: "none" | "label" | "party";
  /** What holding it lets a person do, and what it never lets anyone do: the API's sentences. */
  covers: string;
  never: string;
}

export interface GrantView {
  id: string;
  permission: string;
  account: { id: string; display_name: string; external_id: string | null; email: string | null } | null;
  group: string | null;
  label: string | null;
  party: { id: string; name: string } | null;
  granted_by: { id: string; display_name: string } | null;
  granted_via: string;
  granted_at: string;
  removed_by: { id: string; display_name: string } | null;
  removed_at: string | null;
}

export interface AccountView {
  id: string;
  display_name: string;
  external_id: string | null;
  email: string | null;
  last_active_at: string;
  groups: Array<{ name: string; asserted_at: string; current: boolean }>;
  grants: Array<{ id: string; permission: string; label: string | null; party_id: string | null }>;
}

/** A name the log holds back from this reader. */
export type Withheld = { withheld: true };

export interface LogEntry {
  event: string;
  at: string;
  by: string | null;
  via?: string;
  permission?: string;
  account?: string;
  group?: string;
  label?: string | Withheld;
  reads?: string | Withheld;
  party?: string | Withheld;
  previous_party?: string | Withheld | null;
  source_id?: string;
  connection?: string | Withheld;
  previous_label?: string | Withheld;
  changed?: string[];
  offered?: string[];
  no_longer_offered?: string[];
  tool?: string;
  reason?: string;
  amount_owls?: number;
  mandate?: { id: string; title: string };
  note?: string;
}

export async function fetchPermissionDefinitions(externalId: string): Promise<PermissionDefinition[]> {
  const r = await accountFetch<{ permissions: PermissionDefinition[] }>("/permissions", { actingUser: externalId });
  return r.permissions;
}

export async function fetchPermissionLog(externalId: string, limit = 100): Promise<LogEntry[]> {
  const r = await accountFetch<{ entries: LogEntry[] }>(`/permissions/log?limit=${limit}`, {
    actingUser: externalId,
  });
  return r.entries;
}

export async function fetchGrants(externalId: string): Promise<GrantView[]> {
  return (await accountFetch<{ grants: GrantView[] }>("/permissions/grants", { actingUser: externalId })).grants;
}

export async function fetchAccounts(externalId: string): Promise<AccountView[]> {
  const r = await accountFetch<{ accounts: AccountView[] }>("/permissions/accounts?limit=1000", {
    actingUser: externalId,
  });
  return r.accounts;
}

export function grantPermission(
  externalId: string,
  body: { permission: string; account_id?: string; group?: string; label?: string; party_id?: string }
): Promise<{ grant: GrantView }> {
  return accountFetch("/permissions/grants", { method: "POST", actingUser: externalId, body });
}

export function removeGrant(externalId: string, grantId: string): Promise<{ grant: GrantView }> {
  return accountFetch(`/permissions/grants/${seg(grantId)}`, { method: "DELETE", actingUser: externalId });
}

// --- labels and parties --------------------------------------------------------

export interface LabelView {
  name: string;
  description: string;
  /** The labels a holder of this one may also read, as recorded: one step. */
  reads: string[];
  created_at: string;
}

export interface PartyView {
  id: string;
  name: string;
  is_own_organization: boolean;
  created_at: string;
}

export async function fetchLabels(externalId: string): Promise<LabelView[]> {
  return (await accountFetch<{ labels: LabelView[] }>("/labels", { actingUser: externalId })).labels;
}

export async function fetchParties(externalId: string): Promise<PartyView[]> {
  return (await accountFetch<{ parties: PartyView[] }>("/parties", { actingUser: externalId })).parties;
}

export function defineLabel(
  externalId: string,
  body: { name: string; description: string; reads?: string[] }
): Promise<{ labels: LabelView[] }> {
  return accountFetch("/labels", { method: "POST", actingUser: externalId, body });
}

export function addLabelRead(externalId: string, label: string, reads: string): Promise<{ labels: LabelView[] }> {
  return accountFetch(`/labels/${seg(label)}/reads`, { method: "POST", actingUser: externalId, body: { reads } });
}

export function removeLabelRead(externalId: string, label: string, reads: string): Promise<{ labels: LabelView[] }> {
  return accountFetch(`/labels/${seg(label)}/reads/${seg(reads)}`, { method: "DELETE", actingUser: externalId });
}

export function addParty(
  externalId: string,
  body: { name: string; is_own_organization?: boolean }
): Promise<{ party: PartyView }> {
  return accountFetch("/parties", { method: "POST", actingUser: externalId, body });
}

export function setSourceParty(
  externalId: string,
  sourceId: string,
  partyId: string | null
): Promise<{ source_id: string; party: PartyView | null }> {
  return accountFetch(`/sources/${seg(sourceId)}/party`, {
    method: "PUT",
    actingUser: externalId,
    body: { party_id: partyId },
  });
}

// --- connections ---------------------------------------------------------------

export interface ConnectionTool {
  name: string;
  offered_as: string;
  description: string;
  input_schema: unknown;
  annotations: Record<string, unknown> | null;
  /** The server's word that the tool only reads: true, false, or null when it does not say. A hint. */
  read_only_hint: boolean | null;
  marked_as_writing: boolean;
  definition_hash: string;
  listed: boolean;
  seen_at: string;
  offered: boolean;
  offered_at: string | null;
  withdrawn: { at: string; reason: string } | null;
  calls: number;
  readings_kept: number;
}

export interface ConnectionView {
  id: string;
  name: string;
  tool_prefix: string;
  transport: string;
  url: string;
  credential: { env: string | null; header: string; set: boolean };
  party: { id: string; name: string; is_own_organization: boolean };
  stake: string;
  label: string;
  calls_per_minute: number | null;
  timeout_seconds: number;
  enabled: boolean;
  state: {
    status: "off" | "never_checked" | "answering" | "failing";
    last_checked_at: string | null;
    last_answered_at: string | null;
    last_error: { at: string; message: string } | null;
  };
  tools: ConnectionTool[];
  created_at: string;
  updated_at: string;
}

export interface ConnectionCall {
  id: string;
  tool: string;
  called_at: string;
  duration_ms: number | null;
  /** in_flight | answered | tool_error | failed */
  outcome: string;
  error: string | null;
  result_chars: number | null;
  result_sha256: string | null;
  run_id: string | null;
  agent: string | null;
  claim_id: string | null;
  source_id: string | null;
  kept_at: string | null;
  arguments?: unknown;
  arguments_withheld?: true;
}

/** What asking a connection's server for its tools found. */
export interface Looked {
  answered: boolean;
  problem?: string;
  kind?: string;
  withdrawn?: Array<{ name: string; reason: string }>;
}

export interface ConnectionSettings {
  name?: string;
  tool_prefix?: string;
  transport?: string;
  url?: string;
  credential_env?: string | null;
  credential_header?: string;
  party_id?: string;
  label?: string;
  stake?: string;
  calls_per_minute?: number | null;
  timeout_seconds?: number;
  enabled?: boolean;
}

export function fetchConnections(externalId: string): Promise<{ notice: string; connections: ConnectionView[] }> {
  return accountFetch("/connections", { actingUser: externalId });
}

export function fetchConnection(
  externalId: string,
  id: string
): Promise<{ notice: string; connection: ConnectionView }> {
  return accountFetch(`/connections/${seg(id)}`, { actingUser: externalId });
}

export async function fetchConnectionCalls(
  externalId: string,
  id: string,
  options: { keptOnly?: boolean; limit?: number } = {}
): Promise<ConnectionCall[]> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.keptOnly) params.set("kept", "true");
  const r = await accountFetch<{ calls: ConnectionCall[] }>(`/connections/${seg(id)}/calls?${params}`, {
    actingUser: externalId,
  });
  return r.calls;
}

export function addConnection(
  externalId: string,
  body: ConnectionSettings
): Promise<{ notice: string; connection: ConnectionView; looked: Looked }> {
  return accountFetch("/connections", { method: "POST", actingUser: externalId, body });
}

export function changeConnection(
  externalId: string,
  id: string,
  body: ConnectionSettings
): Promise<{ notice: string; connection: ConnectionView; withdrawn: string[] }> {
  return accountFetch(`/connections/${seg(id)}`, { method: "PATCH", actingUser: externalId, body });
}

export function lookAtConnection(
  externalId: string,
  id: string
): Promise<{ notice: string; connection: ConnectionView; looked: Looked }> {
  return accountFetch(`/connections/${seg(id)}/look`, { method: "POST", actingUser: externalId, body: {} });
}

export function offerConnectionTools(
  externalId: string,
  id: string,
  offered: Array<{ name: string; definition_hash: string }>
): Promise<{ connection: ConnectionView; offered: string[]; no_longer_offered: string[] }> {
  return accountFetch(`/connections/${seg(id)}/tools`, { method: "PUT", actingUser: externalId, body: { offered } });
}

// --- owls the deployment creates, and its standing mandates ---------------------

export interface CreatedOwls {
  /** What an owl is here, in the API's words. */
  statement: string;
  created: {
    total_owls: number;
    into_accounts_owls: number;
    into_mandates_owls: number;
    by_administrator: Array<{ administrator: string; owls: number; acts: number }>;
  };
  entered_by_setting: Array<{ reason: string; owls: number }>;
  spent: { total_owls: number; since: string | null };
  returned_owls: number;
  recent: Array<{
    at: string;
    by: string | null;
    amount_owls: number;
    account?: string;
    mandate?: { id: string; title: string };
    standing_mandate?: string;
    note?: string;
  }>;
  prices: {
    stated: Array<{ model: string; input_usd_per_mtok: number; output_usd_per_mtok: number }>;
    unpriced_models: Array<{ setting: string; model: string }>;
  };
}

export function fetchCreatedOwls(externalId: string, limit = 100): Promise<CreatedOwls> {
  return accountFetch(`/owls/created?limit=${limit}`, { actingUser: externalId });
}

export function createOwls(
  externalId: string,
  body: { amount_owls: number; account_id?: string; mandate_id?: string; note?: string }
): Promise<{ created_owls: number }> {
  return accountFetch("/owls/created", { method: "POST", actingUser: externalId, body });
}

export async function fetchStandingMandates(externalId: string): Promise<StandingMandate[]> {
  const r = await accountFetch<{ standing_mandates: StandingMandate[] }>("/standing-mandates", {
    actingUser: externalId,
  });
  return r.standing_mandates;
}

export function setUpStandingMandate(
  externalId: string,
  name: "general" | "governance",
  body: { budget_owls?: number; daily_owls?: number }
): Promise<{ standing_mandate: StandingMandate }> {
  return accountFetch(`/standing-mandates/${name}`, { method: "POST", actingUser: externalId, body });
}

// --- the usage report -----------------------------------------------------------

export interface UsageReport {
  id: string;
  period: string;
  revision: number;
  /** The report exactly as it is sent. */
  body: string;
  body_hash: string;
  prepared_at: string;
  sent_at: string | null;
  sent_via: "online" | "file" | null;
  receipt: unknown;
  last_attempt_at: string | null;
  last_error: string | null;
}

export interface OutgoingUsageReports {
  price: "metered" | "flat";
  reporting: boolean;
  what_is_sent: string;
  what_is_never_sent: string | null;
  corrections: string | null;
  destination:
    | { kind: "online"; url: string; ready: boolean }
    | { kind: "file"; directory: string }
    | { kind: "none" };
  reports: UsageReport[];
}

export function fetchUsageReports(externalId: string): Promise<OutgoingUsageReports> {
  return accountFetch("/usage-reports/outgoing", { actingUser: externalId });
}

export function sendUsageReports(
  externalId: string,
  recountFrom?: string
): Promise<OutgoingUsageReports & { prepared: number; sent: number; stopped: string | null }> {
  return accountFetch("/usage-reports/outgoing/send", {
    method: "POST",
    actingUser: externalId,
    body: recountFrom ? { recount_from: recountFrom } : {},
  });
}

// --- adding a source ------------------------------------------------------------

export interface SubmittedSource {
  source_id: string;
  contribution_id?: string;
  job_id?: string;
  status: "queued" | "pending_review";
}

export function submitSource(
  externalId: string,
  body: { url: string; title?: string; content?: string }
): Promise<SubmittedSource> {
  return accountFetch("/sources", { method: "POST", actingUser: externalId, body });
}
