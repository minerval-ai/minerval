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
  status: "pass" | "fail" | "to_do" | "not_applicable";
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

export interface StandingMandateState {
  id: string;
  status: string;
  budget_owls: number;
  daily_owls: number;
  running: boolean;
}

export interface StandingMandate {
  name: "general";
  title: string;
  objective: string;
  /** The mandate, or the oldest the reader reads where there is one for each label. */
  mandate: StandingMandateState | null;
  /**
   * Only where the deployment holds material at more than one label: for
   * each label the reader reads, the mandate set up there or none. A
   * mandate's work runs at its label.
   */
  by_label?: Array<{ label: string; mandate: StandingMandateState | null }>;
}

export interface SetupChecklist {
  /** The deployment's own checks of its configuration; null in a build that has no preflight. */
  preflight: PreflightReport | null;
  permissions: PermissionHolders[];
  labels: ChecklistLabel[];
  undefined_labels_in_provider_setting: string[];
  /**
   * Whether the deployment's settings (PROVIDER_LABELS) fix which providers
   * each label may be sent to. Absent from a build before the labels page
   * could clear them, where the settings were the only way.
   */
  clearance_fixed_by_settings?: boolean;
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
    /** Reports go over the connection to minerval.ai and wait on report_usage, which an admin of the organization grants. */
    waits_on_organization?: boolean;
    prepared: number;
    unsent: number;
    last_error: string | null;
  };
  /** Keeping public versions current: the setting, whether anything is behind it, and the last request the public graph did not take. Absent from an older API. */
  public_graph?: {
    account_set: boolean;
    /** This deployment's connection to minerval.ai, with the grants its settings need and it lacks. Absent from an older API; null where never connected. */
    connection?: {
      state: "waiting" | "connected" | "denied" | "expired" | "by_hand";
      organization_name: string | null;
      grants: string[];
      problem: string | null;
      missing_grants: Array<{ grant: string; why: string }>;
    } | null;
    keep_public_current: { setting: "on" | "off"; sends: boolean; in_words: string };
    last_not_taken: string | null;
    /** Pages shown outside that are open, the signing key's fingerprint, and when that key was last registered on the public graph from here. Absent from an older API. */
    signing_key?: { released_outside: number; fingerprint: string | null; registered_from_here_at: string | null };
  };
  /** Following the public graph, as far as it is said without asking the feed. Absent from an older API; null where nothing is or could be followed. */
  mirror?: {
    state: "following" | "paused" | "not_started";
    set_by: "app" | "settings";
    key_waiting: boolean;
    refusal: { code: string; message: string; owner: "operator" | "admin" } | null;
    check_error: string | null;
  } | null;
  connections: {
    total: number;
    on: number;
    offering_tools: number;
    failing: Array<{ id: string; name: string }>;
    tools_withdrawn: Array<{ connection: { id: string; name: string }; tool: string }>;
    credential_missing: Array<{ id: string; name: string }>;
    /** Connections at labels the administrator does not read: counted, and not among the figures above. */
    not_shown: number;
  };
  /** Each gate, how far it has come toward the Redactor deciding alone; absent from a build before gates started with a person. */
  gates?: {
    aim: string;
    each: Array<{
      gate_id: string;
      from: string;
      to: string;
      to_outside: boolean;
      a_person_decides: string[];
      the_redactor_decides: string[];
      open: string[];
      narrower_settings: number;
      waiting_on_a_person: number;
      referred_by_the_redactor: number;
      oldest_waiting_hours: number | null;
      agreement: { window_days: number; decided: number; as_proposed: number; kinds_ready: string[] };
    }>;
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
  /** The kind of act, as GET /permissions/log filters by it (LOG_TYPES in src/services/permission-service.ts). */
  type: string;
  at: string;
  by: string | null;
  /** Who did it, by account id, as `by` on the log takes it; null where no person did it. */
  by_id?: string | null;
  via?: string;
  permission?: string;
  account?: string;
  group?: string;
  label?: string | Withheld;
  reads?: string | Withheld;
  party?: string | Withheld;
  previous_party?: string | Withheld | null;
  source_id?: string;
  /** For source_party_set: the source's title, withheld unless the reader reads the source's label. */
  source_title?: string | Withheld;
  connection?: string | Withheld;
  previous_label?: string | Withheld;
  changed?: string[];
  offered?: string[];
  no_longer_offered?: string[];
  /**
   * For setting_changed and setting_reset: the setting, its value before and
   * after as the environment would hold it (for a key, "set" or "not set"),
   * and the reason given (`why`, on a restart too).
   */
  setting?: string;
  before?: string | null;
  after?: string | null;
  secret?: boolean;
  why?: string;
  /** For party_renamed: the name the party had. */
  previous_name?: string;
  /** For release_step_done: the release and the step. */
  version?: string;
  step?: string;
  /** For provider_clearance_set: the providers cleared for the label, and those no longer cleared. */
  cleared?: string[];
  no_longer_cleared?: string[];
  tool?: string;
  reason?: string;
  amount_owls?: number;
  mandate?: { id: string; title: string };
  note?: string;
  /** A feed key accepted for the mirror, and the feed it started following. */
  key_id?: string;
  feed?: string;
  /** For the file_set_* events: the set, by name; on its closing, how many files it holds; on a set switched off or on. */
  file_set?: string | Withheld;
  files?: number;
  enabled?: boolean;
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
  body: { name: string; description: string; reads?: string[]; providers?: string[] }
): Promise<{ labels: LabelView[] }> {
  return accountFetch("/labels", { method: "POST", actingUser: externalId, body });
}

/** A model provider or outside service, with what it would be sent (GET /labels/providers). */
export interface ProviderView {
  name: string;
  kind: "model_provider" | "outside_service";
  description: string;
  /** Whether this deployment has it set up: a key set, an endpoint declared, a service on. */
  configured: boolean;
}

export interface ProviderClearance {
  /** Whether the deployment's settings (PROVIDER_LABELS) fix the clearance; nothing can be changed then. */
  fixed_by_settings: boolean;
  providers: ProviderView[];
  /** Each label besides public, with the providers cleared for it now. */
  labels: Array<{ label: string; cleared: string[] }>;
}

export async function fetchProviderClearance(externalId: string): Promise<ProviderClearance> {
  return accountFetch<ProviderClearance>("/labels/providers", { actingUser: externalId });
}

export function setProviderClearance(
  externalId: string,
  label: string,
  providers: string[]
): Promise<ProviderClearance & { cleared: string[]; no_longer_cleared: string[] }> {
  return accountFetch(`/labels/${seg(label)}/providers`, { method: "PUT", actingUser: externalId, body: { providers } });
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
  credential: {
    /** stored: given on the connection's page and kept sealed; environment: the variable `env` names; null: none asked for. */
    source: "stored" | "environment" | null;
    env: string | null;
    header: string;
    /** Whether a call would carry it: the variable is set, or the key that sealed the stored one is. */
    set: boolean;
    stored: { given_at: string; key: "current" | "previous" | "missing" } | null;
  };
  party: { id: string; name: string; is_own_organization: boolean };
  /** Where an administrator gave one; recorded on every reading kept. */
  stake: string | null;
  label: string;
  /** The agent roles a run is offered the connection in. */
  offered_to: string[];
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
  /** What the agent wrote in the call. */
  arguments: unknown;
}

/** A list an administrator's clearance leaves rows out of, with how many and the API's sentence saying so. */
export interface NotShown {
  not_shown: number;
  not_shown_note?: string;
}

// --- the labels a person may file new material at (GET /labels/mine) -------------

export interface MyLabel {
  name: string;
  description: string;
  /** Who reads material filed at the label, in the API's words. */
  who_reads: string;
}

export interface MyLabels {
  /** Whether the deployment holds material at more than one label, so that something new must name one. */
  must_choose: boolean;
  works_at: string | null;
  labels: MyLabel[];
}

export function fetchMyLabels(externalId: string): Promise<MyLabels> {
  return accountFetch("/labels/mine", { actingUser: externalId });
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
  stake?: string | null;
  calls_per_minute?: number | null;
  timeout_seconds?: number;
  enabled?: boolean;
  /** The agent roles a run is offered the connection in. */
  offered_to?: string[];
}

/** An agent role a connection may be offered to, as the API describes it. */
export interface ConnectionRoleView {
  role: string;
  name: string;
  /** Whether the role may keep a reading as a source: always, when its work records sources, or never. */
  keeps: "yes" | "when_recording" | "no";
  /** Why a new connection starts this role unticked; absent where it starts ticked. */
  off_at_first?: string;
}

export function fetchConnections(
  externalId: string
): Promise<{ notice: string; can_keep_credentials: boolean; roles: ConnectionRoleView[]; connections: ConnectionView[] } & NotShown> {
  return accountFetch("/connections", { actingUser: externalId });
}

export function fetchConnection(
  externalId: string,
  id: string
): Promise<{ notice: string; can_keep_credentials: boolean; roles: ConnectionRoleView[]; connection: ConnectionView }> {
  return accountFetch(`/connections/${seg(id)}`, { actingUser: externalId });
}

export async function fetchConnectionCalls(
  externalId: string,
  id: string,
  options: { keptOnly?: boolean; limit?: number } = {}
): Promise<{ calls: ConnectionCall[] } & NotShown> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.keptOnly) params.set("kept", "true");
  return accountFetch<{ calls: ConnectionCall[] } & NotShown>(`/connections/${seg(id)}/calls?${params}`, {
    actingUser: externalId,
  });
}

/**
 * Add a connection. `credential`, when given, is the credential itself, which
 * the API seals as it arrives; it is never sent back.
 */
export function addConnection(
  externalId: string,
  body: ConnectionSettings & { credential?: string }
): Promise<{ notice: string; connection: ConnectionView; looked: Looked }> {
  return accountFetch("/connections", { method: "POST", actingUser: externalId, body });
}

export function changeConnection(
  externalId: string,
  id: string,
  body: ConnectionSettings
): Promise<{ notice: string; connection: ConnectionView; withdrawn: string[]; stored_credential_removed: boolean }> {
  return accountFetch(`/connections/${seg(id)}`, { method: "PATCH", actingUser: externalId, body });
}

/** Give a connection its credential, or replace it. The API keeps it sealed and never sends it back. */
export function setConnectionCredential(
  externalId: string,
  id: string,
  credential: string
): Promise<{ notice: string; connection: ConnectionView; replaced: boolean }> {
  return accountFetch(`/connections/${seg(id)}/credential`, { method: "PUT", actingUser: externalId, body: { credential } });
}

export function removeConnectionCredential(
  externalId: string,
  id: string
): Promise<{ notice: string; connection: ConnectionView }> {
  return accountFetch(`/connections/${seg(id)}/credential`, { method: "DELETE", actingUser: externalId });
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
    /** `withheld` where the mandate is at a label the reader does not read: its id alone. */
    mandate?: { id: string; title: string; withheld?: true };
    standing_mandate?: string;
    note?: string;
  }>;
  prices: {
    stated: Array<{ model: string; input_usd_per_mtok: number; output_usd_per_mtok: number }>;
    unpriced_models: Array<{ setting: string; model: string }>;
    /** Absent from a build before the vendors' list prices were read live. */
    in_use?: Array<{
      setting: string;
      model: string;
      priced_by: "stated" | "catalog" | "provider" | "none";
      input_usd_per_mtok?: number;
      output_usd_per_mtok?: number;
    }>;
    list_prices_checked_at?: string | null;
    lists?: Array<{ source: string; ok: boolean }>;
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
  name: "general",
  body: { budget_owls?: number; daily_owls?: number; label?: string }
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
    | { kind: "online"; url: string; ready: boolean; signed?: boolean }
    | { kind: "file"; directory: string }
    | { kind: "none" };
  /** The organization the reports are billed to, where this deployment is connected to minerval.ai. Absent from an older API. */
  billed_to?: string | null;
  /** The allowance on what it spends of the organization's public owls, where an admin set one (micro-USD). */
  allowance?: { allowance_micro_usd: number; left_micro_usd: number } | null;
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
  body: { url: string; title?: string; content?: string; label?: string }
): Promise<SubmittedSource> {
  return accountFetch("/sources", { method: "POST", actingUser: externalId, body });
}

// --- the deployment's settings (docs/settings.md) -------------------------------

/** A setting's value as the config file would write it. */
export type SettingValue =
  | string
  | number
  | boolean
  | string[]
  | Array<Record<string, string | number | boolean>>
  | Record<string, string[]>;

/** One setting, as GET /settings gives it. */
export interface SettingView {
  key: string;
  env: string;
  group: string;
  kind: "text" | "number" | "boolean" | "list" | "groups" | "lists";
  about: string;
  /** "machine": whoever runs the machine alone changes it. "app" and "app_secret": the administrators do, here. */
  where: "machine" | "app" | "app_secret";
  applies: "live" | "restart";
  tuning: boolean;
  secret: boolean;
  source: "environment" | "file" | "app" | "default";
  changeable: boolean;
  fixed_by: string | null;
  value: SettingValue | null;
  default: SettingValue | null;
  is_set: boolean | null;
  last_four: string | null;
  set_by: { id: string; name: string } | null;
  set_at: string | null;
  waiting: { value: SettingValue | null } | null;
  unopened: boolean;
}

export interface SettingsListing {
  problem: string | null;
  waiting_for_restart: number;
  settings: SettingView[];
}

export interface SettingChanged {
  setting: SettingView;
  in_force: "now" | "at_restart";
  warnings: Array<{ check: string; message: string }>;
}

export function fetchSettings(externalId: string): Promise<SettingsListing> {
  return accountFetch("/settings", { actingUser: externalId });
}

export function setSetting(
  externalId: string,
  key: string,
  body: { value: SettingValue; reason?: string }
): Promise<SettingChanged> {
  return accountFetch(`/settings/${encodeURIComponent(key)}`, { method: "PUT", actingUser: externalId, body });
}

export function resetSetting(externalId: string, key: string, body: { reason?: string } = {}): Promise<SettingChanged> {
  return accountFetch(`/settings/${encodeURIComponent(key)}`, { method: "DELETE", actingUser: externalId, body });
}

export async function fetchSettingsFile(externalId: string): Promise<string> {
  return (await accountFetch<{ toml: string }>("/settings/file", { actingUser: externalId })).toml;
}

export function restartApi(externalId: string, body: { reason?: string } = {}): Promise<{ restarting: true; waiting: string[] }> {
  return accountFetch("/setup/restart", { method: "POST", actingUser: externalId, body });
}

export function renameParty(externalId: string, partyId: string, name: string): Promise<{ party: PartyView }> {
  return accountFetch(`/parties/${encodeURIComponent(partyId)}`, { method: "PATCH", actingUser: externalId, body: { name } });
}

/** Become the first administrator of a deployment that has none, with the code its API printed. */
export function becomeFirstAdministrator(externalId: string, code: string): Promise<{ administrator: true }> {
  return accountFetch("/setup/first-administrator", { method: "POST", actingUser: externalId, body: { code } });
}
