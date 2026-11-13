"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import type { FormState } from "../../components/admin/ActionForm";
import { AccountApiError } from "../../lib/account-api";
import {
  askShowing,
  decideAtGate,
  endGateSetting,
  endShowing,
  holdShownPage,
  payForShowingWork,
  releaseProposal,
  savePolicy,
  sendOutside,
  setGate,
  setGateMode,
  writeProposal,
  type GateDecision,
  type PolicyCategory,
} from "../../lib/inside-api";

// What the forms on the pages for showings, the gates, a boundary's
// policy and sending outside do. Each acts for the person in the server's
// own session, never for anyone a form names, and the API decides whether
// they may. What the API refuses is said beside the form in the API's own
// words.

const NOT_SIGNED_IN: FormState = { error: "You are not signed in." };

async function actingUser(): Promise<string | null> {
  const session = await auth();
  return session?.externalId ?? null;
}

function refused(err: unknown): FormState {
  if (err instanceof AccountApiError) {
    // A refused policy version comes with each category's problem; the API's message may already say them.
    const problems = (err.payload?.problems ?? []) as Array<{ category?: string; problem?: string }>;
    const more = problems.map((p) => `"${p.category}": ${p.problem}`).filter((line) => !err.message.includes(line));
    if (more.length > 0) return { error: `${err.message} ${more.join(" ")}` };
    return { error: err.message };
  }
  console.error("[showings] an action failed:", err);
  return { error: "That did not work, and nothing was changed. Try again in a moment." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

// --- asking, ending, holding, paying ----------------------------------------------

export async function askShowingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const nodeId = text(form, "node_id");
  const pageLabel = text(form, "page_label");
  const to = text(form, "to");
  const formOf = text(form, "form");
  const scope = text(form, "scope");
  if (!pageLabel) return { error: "Choose which assessment's page is to be shown." };
  if (!to) return { error: "Choose who the page is to be shown to." };
  if (formOf !== "once" && formOf !== "standing") return { error: "Choose once or standing." };
  if (scope !== "node" && scope !== "under") return { error: "Choose what the showing covers." };
  const outside = to === "outside";
  let showingId: string;
  try {
    const asked = await askShowing(user, {
      node_id: nodeId,
      page_label: pageLabel,
      form: formOf,
      scope,
      ...(outside ? { outside: true } : { to_label: to.replace(/^label:/, "") }),
    });
    showingId = asked.showing_id;
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/showings");
  redirect(`/showings/${showingId}`);
}

export async function endShowingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const reason = text(form, "reason");
  if (!reason) return { error: "Choose a reason. It is recorded with the date, where the people the page is shown to can read it." };
  try {
    await endShowing(user, text(form, "showing_id"), reason);
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/showings", "layout");
  return { notice: "Ended. Later assessments no longer follow, and what was shown stays shown." };
}

export async function holdPageAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const lift = text(form, "lift") === "true";
  const reason = text(form, "reason");
  if (!lift && !reason) return { error: "Choose a reason for the hold. It is all the other side is told." };
  try {
    await holdShownPage(user, text(form, "showing_id"), text(form, "page_id"), lift ? { lift: true } : { reason });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/showings", "layout");
  return { notice: lift ? "The hold is lifted. It stays on the record." : "Held. The hold shows on the other side with its date and its reason." };
}

export async function payForWorkAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const owls = Number(text(form, "owls"));
  if (!Number.isFinite(owls) || owls <= 0) return { error: "Give a budget in owls, more than zero." };
  try {
    const paid = await payForShowingWork(user, text(form, "showing_id"), text(form, "page_id"), owls);
    revalidatePath("/showings", "layout");
    return { notice: paid.note ?? `Paid for ${paid.work}. It runs now; what it does not spend comes back to you.` };
  } catch (err) {
    return refused(err);
  }
}

// --- at the gate ------------------------------------------------------------------

const DECISIONS: readonly GateDecision[] = ["release", "approve", "hold", "lift", "delay", "remove"];

export async function decideAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const decision = text(form, "decision") as GateDecision;
  if (!DECISIONS.includes(decision)) return { error: "Choose what to do with the ticked items." };
  const reason = text(form, "reason");
  if (decision === "hold" && !reason) return { error: "A hold gives a reason from the list. It is all the other side is told." };
  const until = text(form, "until");
  if (decision === "delay" && !until) return { error: "A delay gives the date and time it runs until." };
  const items = form
    .getAll("item")
    .map(String)
    .filter(Boolean)
    .map((value) => {
      const [itemId, part] = value.split(":");
      return { item_id: itemId!, part: part === "page" ? null : Number(part) };
    });
  if (items.length === 0) return { error: "Tick at least one item." };
  if (decision === "remove") {
    const passage = String(form.get("passage") ?? "");
    const category = text(form, "category");
    if (!passage || !category) return { error: "Give the passage exactly as it appears in the part, and the policy's category that covers it." };
    for (const item of items) Object.assign(item, { passage, category });
  }
  try {
    const result = await decideAtGate(user, {
      ...(text(form, "party_id") ? { party_id: text(form, "party_id") } : {}),
      decision,
      ...(decision === "hold" ? { reason } : {}),
      ...(decision === "delay" ? { until: new Date(until).toISOString() } : {}),
      items,
    });
    revalidatePath("/gate");
    revalidatePath("/gates");
    revalidatePath("/showings", "layout");
    const n = result.decided;
    const s = n === 1 ? "" : "s";
    const done =
      decision === "release"
        ? `Released ${n} item${s}. A release is not taken back.`
        : decision === "approve"
          ? `Approved ${n} item${s} as the Redactor left ${n === 1 ? "it" : "them"}. What it held or delayed stays back.`
          : decision === "hold"
            ? `Held ${n} item${s}. Each hold shows on the other side and can be lifted.`
            : decision === "delay"
              ? `Delayed ${n} item${s}. ${n === 1 ? "It goes" : "They go"} when the time comes, unless someone holds ${n === 1 ? "it" : "them"}.`
              : decision === "remove"
                ? `Removed the passage from ${n} part${s}, with the category's mark in its place.`
                : `Lifted the hold or delay on ${n} item${s}.`;
    const shown = result.shown.length > 0 ? ` ${result.shown.length === 1 ? "An item is" : `${result.shown.length} items are`} now shown.` : "";
    const same = result.unchanged > 0 ? ` ${result.unchanged} already stood that way.` : "";
    const not = result.refused.length > 0 ? ` Not done for ${result.refused.length}: ${[...new Set(result.refused.map((r) => r.why))].join(" ")}` : "";
    return n === 0 && result.refused.length > 0 ? { error: not.trim() } : { notice: `${done}${shown}${same}${not}` };
  } catch (err) {
    return refused(err);
  }
}

// --- setting a gate ----------------------------------------------------------------

export async function setGateModeAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const mode = text(form, "mode");
  if (!mode) return { error: "Choose how the gate treats it." };
  const scope = text(form, "scope") || "boundary";
  const scopeRef = text(form, "scope_ref");
  if (scope !== "boundary" && !scopeRef) return { error: "Give the id of the mandate, the node or the request the setting is for." };
  try {
    const set = await setGateMode(user, text(form, "gate_id"), {
      mode,
      kind: text(form, "kind") || "*",
      scope,
      ...(scope !== "boundary" ? { scope_ref: scopeRef } : {}),
      ...(text(form, "party_id") ? { party_id: text(form, "party_id") } : {}),
    });
    revalidatePath("/gates");
    revalidatePath("/gate");
    return {
      notice: set.changed
        ? `Set. ${set.applies}${set.let_through_now > 0 ? ` ${set.let_through_now} part${set.let_through_now === 1 ? "" : "s"} went through just now.` : ""}`
        : "That is how it already stands. Nothing changed.",
    };
  } catch (err) {
    return refused(err);
  }
}

export async function endGateSettingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await endGateSetting(user, text(form, "setting_id"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/gates");
  revalidatePath("/gate");
  return { notice: "Ended. What it covered now falls under the next widest setting, or the gate's starting position." };
}

export async function setGateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const flow = text(form, "flow");
  try {
    await setGate(user, text(form, "gate_id"), {
      ...(flow ? { flow } : {}),
      backlog_shown: form.get("backlog_shown") === "on",
      ...(form.has("outside") ? { send_as_released: form.get("send_as_released") === "on" } : {}),
    });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/gates");
  return { notice: "Saved." };
}

// --- a boundary's policy -----------------------------------------------------------

export async function savePolicyAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const names = form.getAll("category_name").map(String);
  const covers = form.getAll("category_covers").map(String);
  const examples = form.getAll("category_examples").map(String);
  const categories: PolicyCategory[] = names
    .map((name, i) => ({ name: name.trim(), covers: (covers[i] ?? "").trim(), examples: (examples[i] ?? "").trim() }))
    .filter((c) => c.name || c.covers);
  const to = text(form, "to");
  let savedId: string;
  try {
    const saved = await savePolicy(user, {
      from_label: text(form, "from_label"),
      ...(to === "outside" ? { outside: true } : { to_label: to }),
      categories,
    });
    savedId = saved.policy_id;
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/redaction-policies", "layout");
  // The page of the version just saved, which is now the one in force.
  redirect(`/redaction-policies/${savedId}`);
}

// --- sending outside ---------------------------------------------------------------

export async function sendOutsideAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    const report = await sendOutside(user, text(form, "showing_id"));
    revalidatePath("/outbound");
    revalidatePath("/showings", "layout");
    if (report.sent.length === 0 && report.proposals.length === 0) return { notice: "Nothing was waiting to be sent." };
    const admitted = report.sent.filter((s) => s.result === "admitted").length;
    const not = report.sent.filter((s) => s.result !== "admitted");
    return {
      ...(not.length > 0
        ? { error: `${not.length} package${not.length === 1 ? " was" : "s were"} not taken by the public graph: ${not.map((s) => s.detail ?? s.result).join(" ")}` }
        : {}),
      notice: `${admitted} package${admitted === 1 ? "" : "s"} sent and taken by the public graph.${report.proposals.length > 0 ? ` ${report.proposals.length} proposal${report.proposals.length === 1 ? "" : "s"} of a node went with ${report.proposals.length === 1 ? "it" : "them"}.` : ""}`,
    };
  } catch (err) {
    return refused(err);
  }
}

export async function writeProposalAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const words = text(form, "text");
  try {
    const written = await writeProposal(user, {
      showing_id: text(form, "showing_id"),
      node_id: text(form, "node_id"),
      ...(words ? { text: words } : {}),
    });
    revalidatePath("/outbound");
    return { notice: written.in_words };
  } catch (err) {
    return refused(err);
  }
}

export async function releaseProposalAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await releaseProposal(user, text(form, "proposal_id"), text(form, "party_id"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/outbound");
  return { notice: "Released. A release is not taken back." };
}
