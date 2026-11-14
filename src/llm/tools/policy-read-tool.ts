/**
 * get_redaction_policies: the policies under which a page written at the
 * run's label may be shown below it (services/redaction-policy.ts).
 *
 * A run that records judgments is told that its page may be shown to
 * readers who do not read its label, with passages removed under a policy
 * (label-note.ts). This is how it reads that policy. It is offered only on
 * a deployment with more than one label: on the public graph nothing is
 * shown below a label and the tool does not exist.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import { rawQuery } from "../../db/client.js";
import { currentLabel } from "../usage-context.js";

export const POLICY_READ_TOOL_NAME = "get_redaction_policies";

export function getPolicyReadToolDefinition(): Tool {
  return {
    name: POLICY_READ_TOOL_NAME,
    description:
      "The policies under which a page written at this run's label may be shown to readers who do not read that " +
      "label: one for each boundary a page has been asked to be shown across, with where it is shown, its version " +
      "and the names of its categories. With policy_id, that policy in full: how removal works, what is shown " +
      "whenever a page is shown, and what each category covers.",
    input_schema: {
      type: "object",
      properties: { policy_id: { type: "string", description: "One of the listed policies, to read it in full." } },
      required: [],
    },
  };
}

/** Returns null for any other tool. */
export async function executePolicyReadTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name !== POLICY_READ_TOOL_NAME) return null;
  const label = currentLabel();
  const rows = await rawQuery<{ id: string; version: number; to_label: string | null; to_outside: boolean; categories: Array<{ name: string }>; body: string }>(
    `SELECT DISTINCT ON (boundary_id) id, version, to_label, to_outside, categories, body
       FROM redaction_policies WHERE side = 'page' AND from_label = $1
      ORDER BY boundary_id, version DESC`,
    [label]
  );
  const id = typeof input.policy_id === "string" ? input.policy_id.trim() : "";
  if (id) {
    const policy = rows.find((r) => r.id === id);
    if (!policy) return JSON.stringify({ success: false, message: "No policy for pages written at this run's label has that id." });
    return JSON.stringify({ success: true, policy_id: policy.id, version: policy.version, text: policy.body });
  }
  return JSON.stringify({
    success: true,
    policies: rows.map((r) => ({
      policy_id: r.id,
      shown_to: r.to_outside ? "outside this deployment" : r.to_label,
      version: r.version,
      categories: r.categories.map((c) => c.name),
    })),
    ...(rows.length === 0
      ? { note: "No page written at this label has been asked to be shown to readers who do not read it, so no boundary has a policy yet. Every boundary starts from the same text." }
      : {}),
  });
}
