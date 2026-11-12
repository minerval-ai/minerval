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
