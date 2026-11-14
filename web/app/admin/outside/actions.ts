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
  declinePublicRequest,
  fundPublicMandate,
  fundPublicNode,
  openPublicMandate,
  sayToPublicGrantmaker,
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
    const said = await takeUpPublicRequest(user, text(form, "adoption_id"));
    return { notice: british(String(said.in_words ?? "Offered to the gate to outside.")) };
  });
}

export async function declineRequestAction(_previous: FormState, form: FormData): Promise<FormState> {
  return act(async (user) => {
    const said = await declinePublicRequest(user, text(form, "adoption_id"), text(form, "reason"), text(form, "note") || undefined);
    return { notice: british(String(said.in_words ?? "Declined, and offered to the gate to outside with the reason chosen.")) };
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
