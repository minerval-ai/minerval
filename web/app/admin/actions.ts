"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import type { FormState } from "../../components/admin/ActionForm";
import { AccountApiError } from "../../lib/account-api";
import {
  addConnection,
  addLabelRead,
  addParty,
  changeConnection,
  createOwls,
  defineLabel,
  fetchConnection,
  grantPermission,
  lookAtConnection,
  offerConnectionTools,
  removeGrant,
  removeLabelRead,
  sendUsageReports,
  setSourceParty,
  setUpStandingMandate,
  type ConnectionSettings,
} from "../../lib/admin-api";
import { count, listed, withdrawnWords } from "../../lib/admin-words";

// What the forms on the administration pages do. Each acts for the person in
// the server's own session, never for anyone a form names, and the API
// decides whether they may: every one of these is a write that takes a
// signed-in session and the permission to administer. What the API refuses
// is said beside the form in the API's own words.

const NOT_SIGNED_IN: FormState = { error: "You are not signed in." };

async function actingUser(): Promise<string | null> {
  const session = await auth();
  return session?.externalId ?? null;
}

function refused(err: unknown): FormState {
  if (err instanceof AccountApiError) return { error: err.message };
  console.error("[admin] an action failed:", err);
  return { error: "That did not work, and nothing was changed. Try again in a moment." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

// --- people and permissions ----------------------------------------------------

export async function grantAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const permission = text(form, "permission");
  const accountId = text(form, "account_id");
  const group = text(form, "group");
  const label = text(form, "label");
  const partyId = text(form, "party_id");
  if (!permission) return { error: "Choose a permission." };
  if (Boolean(accountId) === Boolean(group)) {
    return { error: "Choose a person or name a group: one of the two, not both." };
  }
  if ((permission === "read" || permission === "read_sources") && !label) {
    return { error: "This permission is granted at one label. Choose the label." };
  }
  if (permission === "release" && !partyId) {
    return { error: "Release is granted for one party. Choose the party." };
  }
  try {
    await grantPermission(user, {
      permission,
      ...(accountId ? { account_id: accountId } : { group }),
      ...(permission === "read" || permission === "read_sources" ? { label } : {}),
      ...(permission === "release" ? { party_id: partyId } : {}),
    });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: "Granted. The grant is in the log." };
}

export async function removeGrantAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await removeGrant(user, text(form, "grant_id"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: "Removed." };
}

// --- labels and parties --------------------------------------------------------

export async function defineLabelAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const name = text(form, "name");
  const description = text(form, "description");
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name)) {
    return {
      error: "A label's name is lower-case letters, digits, hyphens and underscores, starting with a letter.",
    };
  }
  if (!description) return { error: "Say in a sentence what the label is for." };
  const reads = form.getAll("reads").map(String).filter(Boolean);
  try {
    await defineLabel(user, { name, description, ...(reads.length > 0 ? { reads } : {}) });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: `Defined ${name}. Nobody reads at it until an administrator grants that.` };
}

export async function addLabelReadAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const label = text(form, "label");
  const reads = text(form, "reads");
  if (!label || !reads) return { error: "Choose both labels." };
  if (label === reads) return { error: "A label always reads itself. Choose two different labels." };
  try {
    await addLabelRead(user, label, reads);
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: `Recorded: ${label} now reads ${reads}.` };
}

export async function removeLabelReadAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await removeLabelRead(user, text(form, "label"), text(form, "reads"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: "Taken back." };
}

export async function addPartyAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const name = text(form, "name");
  if (!name) return { error: "Give the party's name." };
  try {
    await addParty(user, { name, is_own_organization: form.get("is_own_organization") === "on" });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: `Added ${name}.` };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export async function setSourcePartyAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  // The source's page address or its id: either way the id is what is read.
  const sourceId = text(form, "source").match(UUID)?.[0];
  if (!sourceId) return { error: "Paste the address of the source's page, or its id." };
  const partyId = text(form, "party_id");
  try {
    const result = await setSourceParty(user, sourceId, partyId || null);
    revalidatePath("/admin", "layout");
    return {
      notice: result.party
        ? `Recorded as the material of ${result.party.name}.`
        : "Recorded as no party's material.",
    };
  } catch (err) {
    return refused(err);
  }
}

// --- connections ---------------------------------------------------------------

function connectionSettings(form: FormData): ConnectionSettings {
  const rate = text(form, "calls_per_minute");
  const timeout = text(form, "timeout_seconds");
  const env = text(form, "credential_env");
  const header = text(form, "credential_header");
  const prefix = text(form, "tool_prefix");
  return {
    name: text(form, "name"),
    url: text(form, "url"),
    transport: text(form, "transport") || "streamable_http",
    credential_env: env || null,
    ...(header ? { credential_header: header } : {}),
    ...(prefix ? { tool_prefix: prefix } : {}),
    party_id: text(form, "party_id"),
    label: text(form, "label"),
    stake: text(form, "stake"),
    calls_per_minute: rate ? Number(rate) : null,
    ...(timeout ? { timeout_seconds: Number(timeout) } : {}),
  };
}

function settingsProblem(settings: ConnectionSettings): string | null {
  if (!settings.name) return "Give the connection a name.";
  if (!settings.url) return "Give the address of the system's MCP server.";
  if (!settings.party_id) return "Choose whose system it is. Add the party first if it is not listed.";
  if (!settings.label) return "Choose the connection's label.";
  if (!settings.stake) return "Say what the party stands to gain or lose from what the system shows.";
  if (settings.credential_env && !/^CONNECTION_[A-Z0-9_]+$/.test(settings.credential_env)) {
    return "The credential's variable is named in capitals and starts CONNECTION_. Give its name, never the credential itself.";
  }
  if (settings.calls_per_minute !== null && settings.calls_per_minute !== undefined && !(settings.calls_per_minute >= 1)) {
    return "A rate is a whole number of calls a minute, or left empty for none.";
  }
  return null;
}

export async function addConnectionAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const settings = connectionSettings(form);
  const problem = settingsProblem(settings);
  if (problem) return { error: problem };
  let id: string;
  try {
    id = (await addConnection(user, settings)).connection.id;
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/connections/${id}`);
}

export async function changeConnectionAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const id = text(form, "connection_id");
  const wanted = connectionSettings(form);
  const problem = settingsProblem(wanted);
  if (problem) return { error: problem };
  try {
    // Only what differs is sent, so the log names what changed and nothing else.
    const { connection: now } = await fetchConnection(user, id);
    const changed: ConnectionSettings = {
      ...(wanted.name !== now.name ? { name: wanted.name } : {}),
      ...(wanted.url !== now.url ? { url: wanted.url } : {}),
      ...(wanted.transport !== now.transport ? { transport: wanted.transport } : {}),
      ...(wanted.credential_env !== now.credential.env ? { credential_env: wanted.credential_env } : {}),
      ...(wanted.credential_header && wanted.credential_header !== now.credential.header
        ? { credential_header: wanted.credential_header }
        : {}),
      ...(wanted.party_id !== now.party.id ? { party_id: wanted.party_id } : {}),
      ...(wanted.label !== now.label ? { label: wanted.label } : {}),
      ...(wanted.stake !== now.stake ? { stake: wanted.stake } : {}),
      ...(wanted.calls_per_minute !== now.calls_per_minute ? { calls_per_minute: wanted.calls_per_minute } : {}),
      ...(wanted.timeout_seconds !== undefined && wanted.timeout_seconds !== now.timeout_seconds
        ? { timeout_seconds: wanted.timeout_seconds }
        : {}),
    };
    if (Object.keys(changed).length === 0) return { notice: "Nothing was different, so nothing was changed." };
    const result = await changeConnection(user, id, changed);
    revalidatePath("/admin", "layout");
    return {
      notice:
        result.withdrawn.length > 0
          ? `Changed. ${count(result.withdrawn.length, "tool")} ${result.withdrawn.length === 1 ? "is" : "are"} no longer offered until you look at what the new address lists and pick again: ${listed(result.withdrawn)}.`
          : "Changed.",
    };
  } catch (err) {
    return refused(err);
  }
}

export async function switchConnectionAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const on = text(form, "enabled") === "true";
  try {
    await changeConnection(user, text(form, "connection_id"), { enabled: on });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: on ? "Switched on." : "Switched off. Readings already kept stand." };
}

export async function lookAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    const { looked, connection } = await lookAtConnection(user, text(form, "connection_id"));
    revalidatePath("/admin", "layout");
    if (!looked.answered) {
      return { error: `The server did not answer: ${looked.problem ?? "no reason was given"}` };
    }
    const listedNow = connection.tools.filter((t) => t.listed).length;
    const withdrawn = looked.withdrawn ?? [];
    return {
      notice:
        `The server answered and lists ${count(listedNow, "tool")}.` +
        (withdrawn.length > 0
          ? ` No longer offered: ${listed(withdrawn.map((w) => `${w.name} (${withdrawnWords(w.reason)})`))}.`
          : ""),
    };
  } catch (err) {
    return refused(err);
  }
}

export async function offerToolsAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  // Each ticked box carries the tool's name and the hash of the definition
  // that was on the page when it was ticked, which is what a pick is of.
  const picks: Array<{ name: string; definition_hash: string }> = [];
  for (const value of form.getAll("offer")) {
    try {
      const pick = JSON.parse(String(value)) as { name?: unknown; definition_hash?: unknown };
      if (typeof pick.name === "string" && typeof pick.definition_hash === "string") {
        picks.push({ name: pick.name, definition_hash: pick.definition_hash });
      }
    } catch {
      return { error: "The form was not read correctly. Load the page again and pick once more." };
    }
  }
  try {
    const result = await offerConnectionTools(user, text(form, "connection_id"), picks);
    revalidatePath("/admin", "layout");
    const parts = [
      ...(result.offered.length > 0 ? [`Now offered: ${listed(result.offered)}.`] : []),
      ...(result.no_longer_offered.length > 0 ? [`No longer offered: ${listed(result.no_longer_offered)}.`] : []),
    ];
    return { notice: parts.length > 0 ? parts.join(" ") : "Nothing changed: agents are offered the same tools as before." };
  } catch (err) {
    return refused(err);
  }
}

// --- owls and the standing mandates ---------------------------------------------

export async function createOwlsAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const amount = Number(text(form, "amount_owls"));
  if (!(amount > 0)) return { error: "Give an amount of owls greater than nothing." };
  const recipient = text(form, "recipient");
  const [kind, id] = recipient.split(":");
  if (!id || (kind !== "account" && kind !== "mandate")) {
    return { error: "Choose where the owls go: a person's balance or a mandate's budget." };
  }
  const note = text(form, "note");
  try {
    await createOwls(user, {
      amount_owls: amount,
      ...(kind === "account" ? { account_id: id } : { mandate_id: id }),
      ...(note ? { note } : {}),
    });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: `Created ${amount.toLocaleString("en-GB")} ${amount === 1 ? "owl" : "owls"}. The act is in the log.` };
}

export async function setUpStandingMandateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const name = text(form, "name");
  if (name !== "general" && name !== "governance") return { error: "There is no such standing mandate." };
  const budget = text(form, "budget_owls");
  const daily = text(form, "daily_owls");
  if ((budget && !(Number(budget) >= 0)) || (daily && !(Number(daily) >= 0))) {
    return { error: "A budget and a daily rate are amounts of owls, nothing or more." };
  }
  try {
    await setUpStandingMandate(user, name, {
      ...(budget ? { budget_owls: Number(budget) } : {}),
      ...(daily ? { daily_owls: Number(daily) } : {}),
    });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: "Set up. Its Grantmaker revises its policy from here." };
}

// --- the usage report -----------------------------------------------------------

export async function sendUsageReportsAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const from = text(form, "recount_from");
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return { error: "Give the day to recount from as YYYY-MM-DD." };
  try {
    const result = await sendUsageReports(user, from || undefined);
    revalidatePath("/admin", "layout");
    if (!result.reporting) return { notice: "Nothing was prepared or sent: this deployment reports nothing." };
    return {
      ...(result.stopped ? { error: `Sending stopped: ${result.stopped}` } : {}),
      notice: `${count(result.prepared, "report")} prepared, ${result.sent} sent.`,
    };
  } catch (err) {
    return refused(err);
  }
}
