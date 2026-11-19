/**
 * What the Assistant is told when the person it works for does not hold
 * every permission (src/permissions.ts).
 *
 * The Assistant's tools are its user's MCP tools, and in a members-only
 * deployment a tool whose route needs a permission is not offered to a
 * person who lacks it (mcp/route-tools.ts). The role prompt and the caller
 * skills are the same text everywhere and speak of those tools as ones the
 * Assistant has. This note is how a run learns otherwise, the way
 * features-off-note.ts says which features are off: one passage in the
 * run's first task message, outside the hashed role text, naming the tools
 * that are missing and the reason. What to make of it is the agent's
 * judgment.
 *
 * It is the Assistant's alone, because only the Assistant acts for one
 * person. No other agent's tools depend on anyone's permissions.
 *
 * On the public graph nobody holds or lacks a permission, nothing is
 * withheld, and there is no note.
 */
import { PERMISSION_DEFINITIONS, PERMISSIONS, type PermissionName } from "../permissions.js";

/**
 * The passage for one run: "" when nothing is withheld. The tools are
 * grouped by the permission each needs, in the permissions' own order.
 */
export function permissionsNote(
  withheld: ReadonlyArray<{ tool: string; permission: PermissionName }>
): string {
  if (withheld.length === 0) return "";
  const lines = PERMISSIONS.flatMap((permission) => {
    const tools = withheld.filter((w) => w.permission === permission).map((w) => w.tool);
    if (tools.length === 0) return [];
    return [
      `Without the permission to ${PERMISSION_DEFINITIONS[permission].phrase}: ${tools.join(", ")}.`,
    ];
  });
  return (
    `In this deployment its administrators grant each person separate permissions, and your ` +
    `user does not hold all of them. The tools that need a permission your user lacks are not ` +
    `offered to you in this conversation, so what your instructions and skills say about ` +
    `using them does not apply here.\n` +
    lines.join("\n") +
    `\nAn administrator of the deployment grants a permission. You cannot, and your user ` +
    `cannot grant one to themselves. The rest of your instructions hold as written.`
  );
}

/**
 * What the Assistant is told in a conversation its user started while acting
 * as an organization (docs/organizations.md, "Acting as the organization"):
 * that it works for the organization, under what its user may do as it, that
 * its work is the organization's on the public record and is charged to the
 * organization's owls, and which tools that leaves out. "" in a conversation
 * of the user's own.
 */
export function organizationNote(
  actingFor:
    | {
        organizationName: string;
        role: "admin" | "member";
        permissions: readonly string[];
        allowanceLeftMicroUsd?: number;
        withheld: ReadonlyArray<{ tool: string; permission: string | null; reason: string }>;
      }
    | undefined
): string {
  if (!actingFor) return "";
  const name = actingFor.organizationName;
  const holds =
    actingFor.role === "admin"
      ? `Your user is an admin of ${name}, and holds every permission a member can be given.`
      : `Your user is a member of ${name} and may, as it: ${actingFor.permissions.join(", ")}.`;
  const byPermission = new Map<string, string[]>();
  const other: string[] = [];
  for (const w of actingFor.withheld) {
    if (w.permission) byPermission.set(w.permission, [...(byPermission.get(w.permission) ?? []), w.tool]);
    else other.push(w.tool);
  }
  const lines = [
    ...[...byPermission].map(([permission, tools]) => `Without ${permission}: ${tools.join(", ")}.`),
    ...(other.length > 0 ? [`Never done as an organization: ${other.join(", ")}.`] : []),
  ];
  return (
    `Your user started this conversation acting as the organization ${name}, so in it you work for ${name}. ` +
    `What you do on the public graph is ${name}'s: the public record shows ${name}, and its log shows your user. ` +
    `Your own work here is charged to ${name}'s owls, not your user's. ${holds}` +
    (actingFor.allowanceLeftMicroUsd !== undefined
      ? ` An admin of ${name} set your user an allowance on what they spend of its owls: $${(actingFor.allowanceLeftMicroUsd / 1_000_000).toFixed(2)} is left of it, ` +
        `and it bounds everything you spend here, your own work included, as the balance does. It does not renew; an admin raises it.`
      : "") +
    (lines.length > 0
      ? ` The tools that need what your user does not hold as ${name} are not offered to you here:\n${lines.join("\n")}\n` +
        `An admin of ${name} grants a permission, on its Members tab. You cannot, and your user cannot grant one to themselves.`
      : "") +
    ` The rest of your instructions hold as written.`
  );
}
