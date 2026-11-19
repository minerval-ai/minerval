"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { AccountApiError } from "../../../lib/account-api";
import type { FormState } from "../../../components/admin/ActionForm";
import { DEPLOYMENT_GRANTS, MEMBER_PERMISSIONS, type OrganizationPermission } from "../../../lib/organization-permissions";
import {
  acceptConversion,
  acceptInvitation,
  askConversion,
  cancelConversion,
  cancelInvitation,
  createOrganization,
  makeInvitation,
  approveConnectRequest,
  denyConnectRequest,
  grantPermission,
  organizationCheckout,
  revokeOrganizationCredential,
  withdrawGrant,
  removeMember,
  renameOrganization,
  revokeOldKey,
  setRole,
  type DeploymentGrant,
  type OrganizationRole,
} from "../../../lib/organizations-api";

// Organizations on minerval.ai (docs/organizations.md). The acting person
// always comes from the server session, never from the form; the API checks
// what that person may do in the organization the form names.

async function me(): Promise<string | null> {
  const session = await auth();
  return session?.externalId ?? null;
}

function said(err: unknown, fallback: string): FormState {
  return { error: err instanceof AccountApiError ? err.message : fallback };
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const page = (id: string) => `/account/organizations/${id}`;

export async function createOrganizationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const name = field(form, "name");
  if (!name) return { error: "Give the organization a name." };
  let id: string;
  try {
    id = (await createOrganization(who, name)).id;
  } catch (err) {
    return said(err, "The organization could not be made.");
  }
  redirect(page(id));
}

export async function renameAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  try {
    await renameOrganization(who, id, field(form, "name"));
  } catch (err) {
    return said(err, "The name could not be changed.");
  }
  revalidatePath(page(id));
  return { notice: "Renamed." };
}

export async function inviteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  const role = (field(form, "role") === "admin" ? "admin" : "member") as OrganizationRole;
  try {
    const made = await makeInvitation(who, id, role);
    revalidatePath(page(id));
    const base = (process.env.SITE_URL ?? "https://minerval.ai").replace(/\/$/, "");
    return { notice: `Link made. Copy it now: it is shown once. ${base}/join/${made.token}` };
  } catch (err) {
    return said(err, "The invitation could not be made.");
  }
}

export async function cancelInvitationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  try {
    await cancelInvitation(who, id, field(form, "invitation_id"));
  } catch (err) {
    return said(err, "The invitation could not be cancelled.");
  }
  revalidatePath(page(id));
  return { notice: "Cancelled." };
}

export async function setRoleAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  const role = (field(form, "role") === "admin" ? "admin" : "member") as OrganizationRole;
  try {
    await setRole(who, id, field(form, "account_id"), role);
  } catch (err) {
    return said(err, "The role could not be changed.");
  }
  revalidatePath(page(id));
  return { notice: role === "admin" ? "Now an admin." : "Now a member." };
}

export async function removeMemberAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  const leaving = field(form, "leaving") === "1";
  try {
    await removeMember(who, id, field(form, "account_id"));
  } catch (err) {
    return said(err, "That could not be done.");
  }
  if (leaving) redirect("/account/organizations");
  revalidatePath(page(id));
  return { notice: "Removed." };
}

export async function revokeOldKeyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  try {
    await revokeOldKey(who, id, field(form, "key_id"));
  } catch (err) {
    return said(err, "The key could not be revoked.");
  }
  revalidatePath(page(id));
  return { notice: "Revoked." };
}

export async function acceptInvitationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  let id: string;
  try {
    id = (await acceptInvitation(who, field(form, "token"))).id;
  } catch (err) {
    return said(err, "The invitation could not be accepted.");
  }
  redirect(page(id));
}

export async function askConversionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  // The first admin is named by their contributor page's address or id.
  const raw = field(form, "first_admin");
  const firstAdmin = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? raw;
  try {
    await askConversion(who, field(form, "name"), firstAdmin);
  } catch (err) {
    return said(err, "The request could not be made.");
  }
  revalidatePath("/account/convert");
  return { notice: "Asked. Nothing changes until they accept." };
}

export async function cancelConversionAction(_prev: FormState, _form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  try {
    await cancelConversion(who);
  } catch (err) {
    return said(err, "The request could not be withdrawn.");
  }
  revalidatePath("/account/convert");
  return { notice: "Withdrawn." };
}

export async function acceptConversionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  let id: string;
  try {
    id = (await acceptConversion(who, field(form, "conversion_id"))).id;
  } catch (err) {
    return said(err, "The account could not be converted.");
  }
  redirect(page(id));
}

// ---- buying owls for the organization (admins, and members granted buy) ----

export async function buyOwlsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  let url: string;
  try {
    url = await organizationCheckout(who, field(form, "organization_id"), field(form, "pack_id"));
  } catch (err) {
    return said(err, "The purchase could not be started.");
  }
  redirect(url);
}

// ---- what each member and deployment may do as the organization ----

const PERMISSIONS: readonly string[] = [...MEMBER_PERMISSIONS, ...DEPLOYMENT_GRANTS];

export async function grantAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  const permission = field(form, "permission");
  if (!PERMISSIONS.includes(permission)) return { error: "Choose a permission." };
  const accountId = field(form, "account_id");
  const deploymentId = field(form, "deployment_id");
  try {
    await grantPermission(who, id, {
      permission: permission as OrganizationPermission,
      ...(accountId ? { account_id: accountId } : {}),
      ...(deploymentId ? { deployment_id: deploymentId } : {}),
    });
  } catch (err) {
    return said(err, "The permission could not be given.");
  }
  revalidatePath(page(id));
  return { notice: `Given ${permission}.` };
}

export async function revokeCredentialAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  const kind = field(form, "kind") === "mcp_client" ? "mcp_client" : "api_key";
  try {
    await revokeOrganizationCredential(who, id, kind, field(form, "credential_id"));
  } catch (err) {
    return said(err, "The credential could not be revoked.");
  }
  revalidatePath(page(id));
  return { notice: "Revoked." };
}

export async function withdrawGrantAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const id = field(form, "organization_id");
  try {
    await withdrawGrant(who, id, field(form, "grant_id"));
  } catch (err) {
    return said(err, "The permission could not be withdrawn.");
  }
  revalidatePath(page(id));
  return { notice: "Withdrawn." };
}

// ---- connecting a deployment ----

export async function approveConnectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  const organizationId = field(form, "organization_id");
  const grants = form.getAll("grant").map(String).filter((g): g is DeploymentGrant => (DEPLOYMENT_GRANTS as readonly string[]).includes(g));
  if (grants.length === 0) return { error: "Leave at least one grant ticked, or deny it." };
  try {
    await approveConnectRequest(who, field(form, "code"), organizationId, field(form, "name"), grants);
  } catch (err) {
    return said(err, "The deployment could not be approved.");
  }
  redirect(`${page(organizationId)}?tab=deployments`);
}

export async function denyConnectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await me();
  if (!who) return { error: "Not signed in." };
  try {
    await denyConnectRequest(who, field(form, "code"));
  } catch (err) {
    return said(err, "The request could not be denied.");
  }
  return { notice: "Denied. The deployment is told so." };
}
