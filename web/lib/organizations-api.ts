import "server-only";
import {
  accountFetch,
  pathSegment,
  type Entitlement,
  type GrantView,
  type OwlLedgerEntry,
  type OwlPack,
} from "./account-api";
import type { MemberPermission, OrganizationPermission } from "./organization-permissions";

// Organizations on minerval.ai (docs/organizations.md). Every call acts for
// the signed-in person; the few that read as the organization pass its id,
// which the API checks against its members and their permissions. Acting as
// the organization on the public graph is done on the public graph's own
// pages, through the switch (lib/acting-as.ts), not from here.

export type OrganizationRole = "admin" | "member";

export interface OrganizationView {
  id: string;
  name: string;
  external_id: string;
  created_at: string;
  role?: OrganizationRole;
  /** What the reader may do as it: every member permission for an admin. */
  permissions?: MemberPermission[];
}

export interface GrantRow {
  id: string;
  permission: OrganizationPermission;
  account_id: string | null;
  deployment_id: string | null;
  granted_at: string;
  granted_by: string | null;
}

export interface MemberView {
  account_id: string;
  display_name: string;
  avatar_url: string | null;
  role: OrganizationRole;
  added_at: string;
  added_by: string | null;
  /** What they may do as the organization: every member permission for an admin. */
  permissions: MemberPermission[];
  /** Their live grants, for withdrawing. Empty for an admin. */
  grants: GrantRow[];
}

export interface InvitationView {
  id: string;
  role: OrganizationRole;
  made_at: string;
  made_by: string | null;
  expires_at: string;
  state: "open" | "accepted" | "cancelled" | "expired";
  accepted_by: string | null;
}

export interface LogEntry {
  id: string;
  at: string;
  kind: string;
  credential: "session" | "operator";
  actor: { id: string; display_name: string } | null;
  detail: Record<string, unknown>;
}

export interface OldKeyView {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ConversionView {
  id: string;
  account: { id: string; display_name: string };
  name: string;
  first_admin: { id: string; display_name: string };
  asked_at: string;
  keeps: { live_api_keys: number; publishers: number; published_pages: number };
}

export interface InvitationRead {
  organization: { id: string; name: string };
  role: OrganizationRole;
  state: InvitationView["state"];
  expires_at: string;
}

const org = (id: string) => `/organizations/${pathSegment(id)}`;

export async function listMyOrganizations(me: string): Promise<OrganizationView[]> {
  return (await accountFetch<{ organizations: OrganizationView[] }>("/organizations", { actingUser: me })).organizations;
}

export async function createOrganization(me: string, name: string): Promise<OrganizationView> {
  return (await accountFetch<{ organization: OrganizationView }>("/organizations", { method: "POST", body: { name }, actingUser: me })).organization;
}

export async function getOrganization(me: string, id: string): Promise<OrganizationView> {
  return (await accountFetch<{ organization: OrganizationView }>(org(id), { actingUser: me })).organization;
}

export async function renameOrganization(me: string, id: string, name: string): Promise<OrganizationView> {
  return (await accountFetch<{ organization: OrganizationView }>(org(id), { method: "PATCH", body: { name }, actingUser: me })).organization;
}

export async function listMembers(me: string, id: string): Promise<MemberView[]> {
  return (await accountFetch<{ members: MemberView[] }>(`${org(id)}/members`, { actingUser: me })).members;
}

export async function setRole(me: string, id: string, accountId: string, role: OrganizationRole): Promise<void> {
  await accountFetch(`${org(id)}/members/${pathSegment(accountId)}`, { method: "PUT", body: { role }, actingUser: me });
}

export async function removeMember(me: string, id: string, accountId: string): Promise<void> {
  await accountFetch(`${org(id)}/members/${pathSegment(accountId)}`, { method: "DELETE", actingUser: me });
}

export async function listInvitations(me: string, id: string): Promise<InvitationView[]> {
  return (await accountFetch<{ invitations: InvitationView[] }>(`${org(id)}/invitations`, { actingUser: me })).invitations;
}

export async function makeInvitation(me: string, id: string, role: OrganizationRole): Promise<{ invitation: InvitationView; token: string }> {
  return accountFetch(`${org(id)}/invitations`, { method: "POST", body: { role }, actingUser: me });
}

export async function cancelInvitation(me: string, id: string, invitationId: string): Promise<void> {
  await accountFetch(`${org(id)}/invitations/${pathSegment(invitationId)}`, { method: "DELETE", actingUser: me });
}

export async function readInvitation(me: string, token: string): Promise<InvitationRead> {
  return (await accountFetch<{ invitation: InvitationRead }>(`/organization-invitations/${pathSegment(token)}`, { actingUser: me })).invitation;
}

export async function acceptInvitation(me: string, token: string): Promise<OrganizationView> {
  return (await accountFetch<{ organization: OrganizationView }>(`/organization-invitations/${pathSegment(token)}/accept`, { method: "POST", actingUser: me })).organization;
}

export async function listLog(me: string, id: string, limit = 100): Promise<LogEntry[]> {
  return (await accountFetch<{ log: LogEntry[] }>(`${org(id)}/log?limit=${limit}`, { actingUser: me })).log;
}

export async function listOldKeys(me: string, id: string): Promise<OldKeyView[]> {
  return (await accountFetch<{ keys: OldKeyView[] }>(`${org(id)}/old-keys`, { actingUser: me })).keys;
}

export async function revokeOldKey(me: string, id: string, keyId: string): Promise<void> {
  await accountFetch(`${org(id)}/old-keys/${pathSegment(keyId)}`, { method: "DELETE", actingUser: me });
}

export async function getOpenConversion(me: string): Promise<ConversionView | null> {
  return (await accountFetch<{ conversion: ConversionView | null }>("/account-conversion", { actingUser: me })).conversion;
}

export async function askConversion(me: string, name: string, firstAdminId: string): Promise<ConversionView> {
  return (await accountFetch<{ conversion: ConversionView }>("/account-conversion", { method: "POST", body: { name, first_admin_id: firstAdminId }, actingUser: me })).conversion;
}

export async function cancelConversion(me: string): Promise<void> {
  await accountFetch("/account-conversion", { method: "DELETE", actingUser: me });
}

export async function listConversionsForMe(me: string): Promise<ConversionView[]> {
  return (await accountFetch<{ conversions: ConversionView[] }>("/account-conversions/for-me", { actingUser: me })).conversions;
}

export async function acceptConversion(me: string, conversionId: string): Promise<OrganizationView> {
  return (await accountFetch<{ organization: OrganizationView }>(`/account-conversions/${pathSegment(conversionId)}/accept`, { method: "POST", actingUser: me })).organization;
}

// ---- reading as the organization, for its own pages ----

export async function organizationAccount(me: string, id: string): Promise<{ entitlement: Entitlement; packs: OwlPack[] }> {
  return accountFetch(`/users/me`, { actingUser: me, actingOrganization: id });
}

export async function organizationLedger(me: string, id: string, limit = 50): Promise<OwlLedgerEntry[]> {
  return (await accountFetch<{ entries: OwlLedgerEntry[] }>(`/billing/ledger?limit=${limit}`, { actingUser: me, actingOrganization: id })).entries;
}

export async function organizationMandates(me: string, id: string): Promise<GrantView[]> {
  return (await accountFetch<{ grants: GrantView[] }>(`/grants`, { actingUser: me, actingOrganization: id })).grants;
}

export async function organizationCheckout(me: string, id: string, packId: string): Promise<string> {
  const r = await accountFetch<{ checkout_url: string }>("/billing/checkout", {
    method: "POST",
    body: { pack_id: packId, return_to: `/account/organizations/${id}?tab=billing` },
    actingUser: me,
    actingOrganization: id,
  });
  return r.checkout_url;
}

// ---- what each member and deployment may do as the organization ----

export async function listOrganizationGrants(me: string, id: string): Promise<GrantRow[]> {
  return (await accountFetch<{ grants: GrantRow[] }>(`${org(id)}/grants`, { actingUser: me })).grants;
}

export async function grantPermission(
  me: string,
  id: string,
  grant: { permission: OrganizationPermission; account_id?: string; deployment_id?: string }
): Promise<GrantRow[]> {
  return (await accountFetch<{ grants: GrantRow[] }>(`${org(id)}/grants`, { method: "POST", body: grant, actingUser: me })).grants;
}

/** A key or MCP client a member made to act as the organization (docs/organizations.md, "Other credentials"). */
export interface CredentialRow {
  kind: "api_key" | "mcp_client";
  id: string;
  name: string;
  account_id: string;
  made_at: string;
  last_used_at: string | null;
}

export async function listOrganizationCredentials(me: string, id: string): Promise<CredentialRow[]> {
  return (await accountFetch<{ credentials: CredentialRow[] }>(`${org(id)}/credentials`, { actingUser: me })).credentials;
}

export async function revokeOrganizationCredential(me: string, id: string, kind: CredentialRow["kind"], credentialId: string): Promise<void> {
  await accountFetch(`${org(id)}/credentials/${kind === "api_key" ? "api_key" : "mcp_client"}/${pathSegment(credentialId)}`, {
    method: "DELETE",
    actingUser: me,
  });
}

export async function withdrawGrant(me: string, id: string, grantId: string): Promise<GrantRow[]> {
  return (await accountFetch<{ grants: GrantRow[] }>(`${org(id)}/grants/${pathSegment(grantId)}`, { method: "DELETE", actingUser: me })).grants;
}

// ---- connected deployments ----

export type { DeploymentGrant } from "./organization-permissions";
import type { DeploymentGrant } from "./organization-permissions";

export interface ConnectRequestView {
  code: string;
  suggested_name: string;
  hosting: string;
  hosting_words: string;
  key_id: string;
  asked_grants: DeploymentGrant[];
  expires_at: string;
  state: "waiting" | "approved" | "denied" | "expired";
  your_organizations: Array<{ id: string; name: string }>;
}

export interface DeploymentView {
  id: string;
  name: string;
  hosting: string;
  hosting_words: string;
  key_id: string;
  approved_at: string;
  approved_by: string | null;
  retired_at: string | null;
  grants: DeploymentGrant[];
  last_write_at: string | null;
  recent_writes: Array<{ method: string; route: string; status: number; at: string }>;
}

export async function readConnectRequest(me: string, code: string): Promise<ConnectRequestView> {
  return (await accountFetch<{ request: ConnectRequestView }>(`/connect-requests/${pathSegment(code)}`, { actingUser: me })).request;
}

export async function approveConnectRequest(
  me: string,
  code: string,
  organizationId: string,
  name: string,
  grants: DeploymentGrant[]
): Promise<{ deployment_id: string }> {
  return accountFetch(`/connect-requests/${pathSegment(code)}/approve`, {
    method: "POST",
    body: { organization_id: organizationId, grants, ...(name ? { name } : {}) },
    actingUser: me,
  });
}

export async function denyConnectRequest(me: string, code: string): Promise<void> {
  await accountFetch(`/connect-requests/${pathSegment(code)}/deny`, { method: "POST", actingUser: me });
}

export async function listDeployments(me: string, id: string): Promise<DeploymentView[]> {
  return (await accountFetch<{ deployments: DeploymentView[] }>(`${org(id)}/deployments`, { actingUser: me })).deployments;
}
