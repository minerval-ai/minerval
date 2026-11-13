"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import type { FormState } from "../../components/admin/ActionForm";
import { AccountApiError } from "../../lib/account-api";
import {
  askShowing,
  decideAtGate,
  endReleaseRule,
  endShowing,
  holdShownPage,
  payForShowingWork,
  releaseProposal,
  savePolicy,
  sendOutside,
  setReleaseRule,
  writeProposal,
  type PolicyCategory,
} from "../../lib/inside-api";
import { END_REASONS, HOLD_REASONS } from "../../lib/inside-words";

// What the forms on the pages for showings, the release queue, a boundary's
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
  const send = text(form, "send");
  if (outside && send !== "as_released" && send !== "by_a_person_each_time") {
    return { error: "Choose how what is released leaves the deployment." };
  }
  let showingId: string;
  try {
    const asked = await askShowing(user, {
      node_id: nodeId,
      page_label: pageLabel,
      form: formOf,
      scope,
      ...(outside ? { outside: true, send: send as "as_released" | "by_a_person_each_time" } : { to_label: to.replace(/^label:/, "") }),
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
  if (!(reason in END_REASONS)) return { error: "Choose a reason. It is recorded with the date, where the people the page is shown to can read it." };
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
  if (!lift && !(reason in HOLD_REASONS)) return { error: "Choose a reason for the hold. It is all the other side is told." };
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

// --- the release queue ------------------------------------------------------------

export async function decideAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const decision = text(form, "decision");
  if (decision !== "release" && decision !== "hold" && decision !== "lift") return { error: "Choose release or hold." };
  const reason = text(form, "reason");
  if (decision === "hold" && !(reason in HOLD_REASONS)) return { error: "A hold gives a reason from the list. It is all the other side is told." };
  const items = form
    .getAll("item")
    .map(String)
    .filter(Boolean)
    .map((value) => {
      const [pageId, part] = value.split(":");
      return { page_id: pageId!, part: part === "page" ? null : Number(part) };
    });
  if (items.length === 0) return { error: "Tick at least one item." };
  try {
    const result = await decideAtGate(user, {
      party_id: text(form, "party_id"),
      decision,
      ...(decision === "hold" ? { reason } : {}),
      items,
    });
    revalidatePath("/release");
    revalidatePath("/showings", "layout");
    const done =
      decision === "release"
        ? `Released ${result.decided} item${result.decided === 1 ? "" : "s"}. A release is not taken back.`
        : decision === "hold"
          ? `Held ${result.decided} item${result.decided === 1 ? "" : "s"}. Each hold shows on the other side and can be lifted.`
          : `Lifted the hold on ${result.decided} item${result.decided === 1 ? "" : "s"}.`;
    const shown = result.shown.length > 0 ? ` ${result.shown.length === 1 ? "A page is" : `${result.shown.length} pages are`} now shown.` : "";
    const not = result.refused.length > 0 ? ` Not done for ${result.refused.length}: ${[...new Set(result.refused.map((r) => r.why))].join(" ")}` : "";
    return result.decided === 0 && result.refused.length > 0 ? { error: not.trim() } : { notice: `${done}${shown}${not}` };
  } catch (err) {
    return refused(err);
  }
}

export async function setRuleAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const to = text(form, "to");
  const pageLabel = text(form, "page_label");
  const condition = text(form, "condition");
  if (!pageLabel || !to || !condition) return { error: "Choose the party, the two sides of the boundary and the condition." };
  try {
    await setReleaseRule(user, {
      party_id: text(form, "party_id"),
      page_label: pageLabel,
      ...(to === "outside" ? { outside: true } : { to_label: to.replace(/^label:/, "") }),
      condition,
      covers_verdict: form.get("covers_verdict") === "on",
    });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/release");
  return { notice: "The rule is set. It applies to pages that reach the queue from now on, and each release it makes is recorded as made under it." };
}

export async function endRuleAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await endReleaseRule(user, text(form, "rule_id"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/release");
  return { notice: "Ended." };
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
