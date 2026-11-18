"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import type { FormState } from "../../../components/admin/ActionForm";
import { AccountApiError, createAssessmentOrder } from "../../../lib/account-api";
import { offerMandateOutside } from "../../../lib/inside-api";
import {
  adoptPublicRequest,
  askPublicMandate,
  backPublicMandate,
  british,
  checkConnection,
  declinePublicRequest,
  disconnectConnection,
  startConnection,
  type DeploymentGrant,
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

/**
 * An assessment of a public node made here, at a label of the deployment's
 * own, paid for in this deployment's owls: the organisation's own judgment
 * of the node, beside the public one and read only by that label's readers.
 * Nothing is sent outside.
 */
export async function assessHereAction(_previous: FormState, form: FormData): Promise<FormState> {
  const node = text(form, "node_id");
  const label = text(form, "label");
  if (!label) return { error: "Choose the label the assessment is made at." };
  return act(async (user) => {
    await createAssessmentOrder(user, node, label);
    revalidatePath(`/claims/${node}`);
    return {
      notice: `Ordered at ${label}. The Steward there assesses the node on what that label reads; the result appears as that label's version on this page.`,
    };
  });
}

/** Offer a mandate to the gate to outside, as the organisation's face on the public graph. */
export async function offerMandateOutsideAction(_previous: FormState, form: FormData): Promise<FormState> {
  const mandate = text(form, "mandate_id");
  if (!UUID.test(mandate)) return { error: "That is not a mandate." };
  return act(async (user) => {
    await offerMandateOutside(user, mandate);
    revalidatePath(`/mandates/${mandate}`);
    return {
      notice:
        "Offered to the gate to outside. It goes under the gate's setting for mandates; where a person decides as well, it waits for them on At the gate.",
    };
  });
}

// ---- the connection to minerval.ai ----

const GRANTS: readonly DeploymentGrant[] = ["read_feed", "report_usage", "publish", "act"];

export async function connectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const who = await actingUser();
  if (!who) return NOT_SIGNED_IN;
  const grants = form.getAll("grant").map(String).filter((g): g is DeploymentGrant => (GRANTS as readonly string[]).includes(g));
  if (grants.length === 0) return { error: "Ask for at least one grant." };
  const apiUrl = String(form.get("api_url") ?? "").trim();
  try {
    await startConnection(who, {
      name: String(form.get("name") ?? "").trim(),
      grants,
      ...(apiUrl ? { api_url: apiUrl } : {}),
      ...(form.get("replace") === "1" ? { replace: true } : {}),
    });
  } catch (err) {
    return refused(err);
  }
  redirect("/admin/outside?drawer=connect");
}

export async function checkConnectionAction(_prev: FormState, _form: FormData): Promise<FormState> {
  const who = await actingUser();
  if (!who) return NOT_SIGNED_IN;
  try {
    const { connection } = await checkConnection(who);
    revalidatePath("/admin/outside");
    if (connection?.connected) return { notice: `Connected for ${connection.organization?.name ?? "the organisation"}.` };
    if (connection?.state === "denied") return { error: "An admin of the organisation denied it." };
    if (connection?.state === "expired") return { error: "The code expired. Start again." };
    return { notice: "Still waiting for an admin of the organisation." };
  } catch (err) {
    return refused(err);
  }
}

export async function disconnectAction(_prev: FormState, _form: FormData): Promise<FormState> {
  const who = await actingUser();
  if (!who) return NOT_SIGNED_IN;
  try {
    const out = await disconnectConnection(who);
    if (!out.retired_there && out.said) {
      revalidatePath("/admin/outside");
      return { notice: `Disconnected here. ${british(out.said)} An admin of the organisation can retire it on minerval.ai.` };
    }
  } catch (err) {
    return refused(err);
  }
  redirect("/admin/outside");
}
