"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import type { FormState } from "../../components/admin/ActionForm";
import { AccountApiError } from "../../lib/account-api";
import { savePolicy, type PolicyCategory } from "../../lib/inside-api";
import { endGateSettingAction, setGateAction, setGateModeAction } from "../releases/actions";

// The forms on a boundary's page. The gate's own acts are the releases
// actions, used as they are; these only fit the boundary page's fields to
// them and refresh the boundary's own address as well as /gates. Saving a
// policy version is done here so that a refusal comes back with each
// category's problem, to be shown beside the category it is about.

const refresh = () => revalidatePath("/gates", "layout");

/** Add a rule: the scope's reference comes from the field for that scope. */
export async function addRuleAction(previous: FormState, form: FormData): Promise<FormState> {
  const scope = String(form.get("scope") ?? "boundary");
  const fields: Record<string, string> = {
    mandate: "scope_ref_mandate",
    under: "scope_ref_node",
    request: "scope_ref_request",
  };
  const sent = new FormData();
  for (const [k, v] of form.entries()) if (!k.startsWith("scope_ref")) sent.append(k, v);
  if (fields[scope]) sent.set("scope_ref", String(form.get(fields[scope]) ?? "").trim());
  const said = await setGateModeAction(previous, sent);
  refresh();
  return said;
}

export async function endRuleAction(previous: FormState, form: FormData): Promise<FormState> {
  const said = await endGateSettingAction(previous, form);
  refresh();
  return said;
}

export async function gateSettingsAction(previous: FormState, form: FormData): Promise<FormState> {
  const said = await setGateAction(previous, form);
  refresh();
  return said;
}

export interface PolicyFormState extends FormState {
  problems?: Array<{ category: string; problem: string }>;
}

export async function savePolicyVersionAction(_previous: PolicyFormState, form: FormData): Promise<PolicyFormState> {
  const session = await auth();
  const user = session?.externalId ?? null;
  if (!user) return { error: "You are not signed in." };
  const names = form.getAll("category_name").map(String);
  const covers = form.getAll("category_covers").map(String);
  const examples = form.getAll("category_examples").map(String);
  const categories: PolicyCategory[] = names
    .map((name, i) => ({
      name: name.trim(),
      covers: (covers[i] ?? "").trim(),
      examples: (examples[i] ?? "").trim(),
    }))
    .filter((c) => c.name || c.covers);
  const to = String(form.get("to") ?? "");
  const gateId = String(form.get("gate_id") ?? "");
  try {
    await savePolicy(user, {
      from_label: String(form.get("from_label") ?? ""),
      ...(to === "outside" ? { outside: true } : { to_label: to }),
      categories,
    });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const problems = (
        (err.payload?.problems ?? []) as Array<{
          category?: string;
          problem?: string;
        }>
      )
        .filter((p) => p.problem)
        .map((p) => ({ category: p.category ?? "", problem: p.problem! }));
      if (problems.length > 0) {
        return {
          error: `This version was not saved: ${problems.length === 1 ? "one category has a problem" : `${problems.length} problems`}, shown beside ${problems.length === 1 ? "it" : "the categories"}.`,
          problems,
        };
      }
      return { error: err.message };
    }
    console.error("[gates] saving a policy version failed:", err);
    return {
      error: "That did not work, and nothing was changed. Try again in a moment.",
    };
  }
  refresh();
  revalidatePath("/redaction-policies", "layout");
  redirect(`/gates/${encodeURIComponent(gateId)}?tab=policy&saved=1`);
}
