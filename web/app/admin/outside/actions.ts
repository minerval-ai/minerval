"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import type { FormState } from "../../../components/admin/ActionForm";
import { AccountApiError } from "../../../lib/account-api";
import {
  adoptPublicRequest,
  askPublicMandate,
  backPublicMandate,
  british,
  commissionOutwardWork,
  declinePublicRequest,
  fundPublicMandate,
  fundPublicNode,
  leaveOutOfKeepCurrent,
  openPublicMandate,
  sayToPublicGrantmaker,
  sendReport,
  sendReportFacts,
  setStandingChoice,
  takeBackLeaveOut,
  takeUpPublicRequest,
} from "../../../lib/outside-api";

// What the forms on the pages about the public graph do. Each acts for the
// person in the server's own session, and the API decides whether they may:
// every act that reaches the public graph takes a person who holds the
// permission for it. What the API refuses, or the public graph answers, is
// said beside the form in their own words.

const NOT_SIGNED_IN: FormState = { error: "You are not signed in." };

async function actingUser(): Promise<string | null> {
  const session = await auth();
  return session?.externalId ?? null;
}

function refused(err: unknown): FormState {
  if (err instanceof AccountApiError) return { error: british(err.message) };
  console.error("[outside] an action failed:", err);
  return { error: "That did not work, and nothing was sent. Try again in a moment." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function owlsOf(form: FormData): number | null {
  const n = Number(text(form, "owls"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function act(run: (user: string) => Promise<FormState>): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    const said = await run(user);
    revalidatePath("/admin/outside", "layout");
    return said;
  } catch (err) {
    return refused(err);
  }
}

// --- standing choices -----------------------------------------------------------

export async function setChoiceAction(_previous: FormState, form: FormData): Promise<FormState> {
  const key = text(form, "key");
  const on = text(form, "on") === "true";
  const mandate = text(form, "public_mandate_id");
  if (mandate && !UUID.test(mandate)) return { error: "Give the public mandate by its id, as the list of public mandates shows it." };
  const hours = (name: string) => (text(form, name) === "" ? undefined : Number(text(form, name)));
  return act(async (user) => {
    await setStandingChoice(user, key, {
      on,
      ...(key === "keep_public_current" ? { public_mandate_id: mandate || null, delay_hours: hours("delay_hours"), batch_hours: hours("batch_hours") } : {}),
    });
    return { notice: on ? "Turned on, under your name." : "Turned off, under your name." };
  });
}

export async function leaveOutAction(_previous: FormState, form: FormData): Promise<FormState> {
  const mandate = text(form, "mandate_id");
  const node = text(form, "node_id");
  const label = text(form, "label");
  if (!mandate && !node) return { error: "Name a mandate, a node, or both, by id." };
  if ((mandate && !UUID.test(mandate)) || (node && !UUID.test(node))) return { error: "A mandate and a node are named by their ids." };
  return act(async (user) => {
    await leaveOutOfKeepCurrent(user, { ...(mandate ? { mandate_id: mandate } : {}), ...(node ? { node_id: node } : {}), ...(label ? { label } : {}) });
    return { notice: "Left out from now on." };
  });
}

export async function takeBackLeaveOutAction(_previous: FormState, form: FormData): Promise<FormState> {
  return act(async (user) => {
    await takeBackLeaveOut(user, text(form, "id"));
    return { notice: "No longer left out." };
  });
}

// --- public requests --------------------------------------------------------------

export async function adoptRequestAction(_previous: FormState, form: FormData): Promise<FormState> {
  return act(async (user) => {
    const result = await adoptPublicRequest(user, text(form, "public_request_id"), text(form, "label") || undefined);
    return { notice: result.already ? "Already adopted at that label." : "Adopted. It is an ordinary request here now, and nothing was said outside." };
  });
}

export async function takeUpRequestAction(_previous: FormState, form: FormData): Promise<FormState> {
  if (text(form, "understood") !== "yes") return { error: "Tick the box to say you have read what this shows outside." };
  return act(async (user) => {
    await takeUpPublicRequest(user, text(form, "adoption_id"));
    return { notice: "Said on the public graph, in the organisation's name." };
  });
}

export async function declineRequestAction(_previous: FormState, form: FormData): Promise<FormState> {
  return act(async (user) => {
    await declinePublicRequest(user, text(form, "adoption_id"), text(form, "reason"));
    return { notice: "Said on the public graph, with the reason chosen." };
  });
}

// --- public mandates and public owls ----------------------------------------------------

export async function openPublicMandateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const message = text(form, "message");
  if (!message) return { error: "Write what the public mandate is for. These words are sent as you write them." };
  if (text(form, "understood") !== "yes") return { error: "Tick the box to say you have read what this shows outside." };
  let conversation: string | null = null;
  try {
    conversation = (await openPublicMandate(user, message)).conversation_id;
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin/outside", "layout");
  if (!conversation) return { notice: "Sent to the public Grantmaker." };
  redirect(`/admin/outside/mandates/${conversation}`);
}

export async function sayToGrantmakerAction(_previous: FormState, form: FormData): Promise<FormState> {
  const message = text(form, "message");
  if (!message) return { error: "Write what you want to say. These words are sent as you write them." };
  return act(async (user) => {
    await sayToPublicGrantmaker(user, text(form, "conversation_id"), message);
    return { notice: "Sent. The public Grantmaker's reply appears here when its turn ends." };
  });
}

export async function fundPublicMandateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const owls = owlsOf(form);
  if (!owls) return { error: "Give the budget in public owls." };
  return act(async (user) => {
    await fundPublicMandate(user, text(form, "conversation_id"), owls);
    return { notice: "Funded. The mandate is public on the public graph now." };
  });
}

export async function backPublicMandateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const owls = owlsOf(form);
  if (!owls) return { error: "Give the amount in public owls." };
  return act(async (user) => {
    await backPublicMandate(user, text(form, "mandate_id"), owls);
    return { notice: `${owls} public owls added.` };
  });
}

export async function fundPublicNodeAction(_previous: FormState, form: FormData): Promise<FormState> {
  const owls = owlsOf(form);
  const node = text(form, "node_id");
  if (!owls) return { error: "Give the budget in public owls." };
  return act(async (user) => {
    await fundPublicNode(user, node, owls);
    revalidatePath(`/claims/${node}`);
    return { notice: "Paid for, from the organisation's public owls. The public graph's Steward takes it up there." };
  });
}

export async function askPublicMandateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const mandate = text(form, "mandate_id");
  if (!UUID.test(mandate)) return { error: "Choose one of the organisation's public mandates." };
  return act(async (user) => {
    await askPublicMandate(user, text(form, "node_id"), mandate);
    return { notice: "Asked. The mandate's officers on the public graph decide whether its money pays." };
  });
}

// --- agents' reports -----------------------------------------------------------------------

export async function sendReportAction(_previous: FormState, form: FormData): Promise<FormState> {
  return act(async (user) => {
    await sendReport(user, text(form, "sending_id"));
    return { notice: "Sent to Minerval's maintainers, as shown." };
  });
}

export async function sendReportFactsAction(_previous: FormState, form: FormData): Promise<FormState> {
  return act(async (user) => {
    await sendReportFacts(user, text(form, "sending_id"));
    return { notice: "The facts were sent, and none of the agent's words." };
  });
}

export async function commissionWorkAction(_previous: FormState, form: FormData): Promise<FormState> {
  const owls = owlsOf(form);
  if (!owls) return { error: "Give the budget in owls." };
  return act(async (user) => {
    const result = await commissionOutwardWork(user, text(form, "action_id"), owls);
    return { notice: result.note ?? `Paid for: ${result.work}. What the run does not spend comes back.` };
  });
}
