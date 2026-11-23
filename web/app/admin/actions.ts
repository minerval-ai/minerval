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
  decideConnectionWrite,
  createOwls,
  defineLabel,
  fetchConnection,
  grantPermission,
  lookAtConnection,
  offerConnectionTools,
  removeConnectionCredential,
  removeGrant,
  removeLabelRead,
  sendUsageReports,
  setConnectionCredential,
  setProviderClearance,
  setSourceParty,
  setUpStandingMandate,
  type ConnectionSettings,
  type ConnectionToolPick,
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
  if (permission === "consent" && !partyId) {
    return { error: "Consent is granted for one party. Choose the party." };
  }
  try {
    await grantPermission(user, {
      permission,
      ...(accountId ? { account_id: accountId } : { group }),
      ...(permission === "read" || permission === "read_sources" ? { label } : {}),
      ...(permission === "consent" ? { party_id: partyId } : {}),
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
  const providers = providersTicked(form);
  try {
    await defineLabel(user, {
      name,
      description,
      ...(reads.length > 0 ? { reads } : {}),
      ...(providers.length > 0 ? { providers } : {}),
    });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return {
    notice:
      `Defined ${name}. Nobody reads at it until an administrator grants that. ` +
      (providers.length > 0
        ? `Its text may be sent to ${listed(providers)}.`
        : "No model provider or outside service is cleared for it yet, so no agent can work at it until one is.") +
      " " +
      `Upkeep and audits at ${name} are paid by a General mandate at ${name}, which an administrator who reads it sets up on the Budget page ` +
      `(its row in the table above links there). None is needed if it will hold only work someone asks for and pays for.`,
  };
}

/**
 * The providers a form ticked. "The same as public" is a box of its own,
 * which stands for every provider the form listed (offered), since every
 * provider is cleared for public: ticking it is still a choice made on
 * purpose, and nothing is ticked until someone ticks it.
 */
function providersTicked(form: FormData): string[] {
  const offered = form.getAll("offered").map(String).filter(Boolean);
  const ticked = form.get("same_as_public") ? offered : form.getAll("providers").map(String).filter(Boolean);
  return [...new Set(ticked)];
}

export async function setProviderClearanceAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const label = text(form, "label");
  if (!label) return { error: "Choose a label." };
  const providers = providersTicked(form);
  let result: { cleared: string[]; no_longer_cleared: string[] };
  try {
    result = await setProviderClearance(user, label, providers);
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  const said = [
    ...(result.cleared.length > 0 ? [`cleared ${listed(result.cleared)}`] : []),
    ...(result.no_longer_cleared.length > 0 ? [`took back ${listed(result.no_longer_cleared)}`] : []),
  ];
  return {
    notice:
      said.length > 0
        ? `For ${label}: ${said.join(" and ")}. In force within a few seconds, with no restart.`
        : `Nothing changed for ${label}.`,
  };
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
  const own = form.get("is_own_organization") === "on";
  try {
    await addParty(user, { name, is_own_organization: own });
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: own ? `Recorded ${name} as the organisation that runs this deployment.` : `Added ${name}.` };
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
    // Named only where the deployment holds material at more than one label
    // and the connection is new: a connection keeps the label it was added at.
    ...(text(form, "label") ? { label: text(form, "label") } : {}),
    // Optional: empty is none.
    stake: text(form, "stake") || null,
    // Only where the checklist was on the form: none ticked is then a choice.
    ...(form.get("offered_to_listed") ? { offered_to: form.getAll("offered_to").map(String) } : {}),
    calls_per_minute: rate ? Number(rate) : null,
    ...(timeout ? { timeout_seconds: Number(timeout) } : {}),
  };
}

function settingsProblem(settings: ConnectionSettings): string | null {
  if (!settings.name) return "Give the connection a name.";
  if (!settings.url) return "Give the address of the system's MCP server.";
  if (!settings.party_id) return "Choose whose system it is. Add the party first if it is not listed.";
  if (settings.credential_env && !/^CONNECTION_[A-Z0-9_]+$/.test(settings.credential_env)) {
    return "The credential's variable is named in capitals and starts CONNECTION_. Give its name, never the credential itself.";
  }
  if (settings.calls_per_minute !== null && settings.calls_per_minute !== undefined && !(settings.calls_per_minute >= 1)) {
    return "A rate is a whole number of calls a minute, or left empty for none.";
  }
  return null;
}

// A credential typed into a form is read here, sent to the API once and
// never put back into what the form shows: the API seals it as it arrives,
// and nothing here logs it or keeps it. Not trimmed here; the API says what
// it takes.
const credentialOf = (form: FormData): string => String(form.get("credential") ?? "");

const ONE_CREDENTIAL_PLACE =
  "Give the credential itself or the name of the variable that holds it, not both: a connection takes its credential from one place.";

export async function addConnectionAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const settings = connectionSettings(form);
  const problem = settingsProblem(settings);
  if (problem) return { error: problem };
  const credential = credentialOf(form);
  if (credential.trim() && settings.credential_env) return { error: ONE_CREDENTIAL_PLACE };
  let id: string;
  try {
    id = (await addConnection(user, { ...settings, ...(credential.trim() ? { credential } : {}) })).connection.id;
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
      ...(wanted.stake !== now.stake ? { stake: wanted.stake } : {}),
      ...(wanted.offered_to && [...wanted.offered_to].sort().join() !== [...now.offered_to].sort().join()
        ? { offered_to: wanted.offered_to }
        : {}),
      ...(wanted.calls_per_minute !== now.calls_per_minute ? { calls_per_minute: wanted.calls_per_minute } : {}),
      ...(wanted.timeout_seconds !== undefined && wanted.timeout_seconds !== now.timeout_seconds
        ? { timeout_seconds: wanted.timeout_seconds }
        : {}),
    };
    if (Object.keys(changed).length === 0) return { notice: "Nothing was different, so nothing was changed." };
    const result = await changeConnection(user, id, changed);
    revalidatePath("/admin", "layout");
    const parts = [
      "Changed.",
      ...(result.withdrawn.length > 0
        ? [
            `${count(result.withdrawn.length, "tool")} ${result.withdrawn.length === 1 ? "is" : "are"} no longer offered until you look at what the new address lists and pick again: ${listed(result.withdrawn)}.`,
          ]
        : []),
      ...(result.stored_credential_removed
        ? [
            changed.credential_env
              ? "The credential given on this page was removed: the connection now takes its credential from the variable."
              : "The credential given on this page was removed, since it was given for the old address. Give it again below.",
          ]
        : []),
    ];
    return { notice: parts.join(" ") };
  } catch (err) {
    return refused(err);
  }
}

export async function setConnectionCredentialAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const id = text(form, "connection_id");
  const credential = credentialOf(form);
  if (!credential.trim()) return { error: "Paste the credential first." };
  let replaced: boolean;
  try {
    ({ replaced } = await setConnectionCredential(user, id, credential));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  const kept = replaced ? "Replaced, and kept encrypted." : "Kept, encrypted.";
  // Asked straight away, so the person learns now whether the system takes it.
  try {
    const { looked, connection } = await lookAtConnection(user, id);
    revalidatePath("/admin", "layout");
    if (!looked.answered) return { error: `${kept} But the server did not take it: ${looked.problem ?? "no reason was given"}` };
    return { notice: `${kept} The server answered with it and lists ${count(connection.tools.filter((t) => t.listed).length, "tool")}.` };
  } catch {
    return { notice: `${kept} Look at the tools to check that the server takes it.` };
  }
}

export async function removeConnectionCredentialAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await removeConnectionCredential(user, text(form, "connection_id"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: "Removed. The connection's calls now go without a credential." };
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
  // Each switched-on tool carries its name, the hash of the definition that
  // was on the page, which is what a pick is of, and the terms it is offered
  // on: a write grant with its acknowledgement and reason, whether its calls
  // are held, and what a call costs.
  const picks: ConnectionToolPick[] = [];
  for (const value of form.getAll("offer")) {
    try {
      const pick = JSON.parse(String(value)) as Partial<ConnectionToolPick>;
      if (typeof pick.name !== "string" || typeof pick.definition_hash !== "string") continue;
      const writes = pick.writes;
      if (writes !== undefined && !String(writes.reason ?? "").trim()) {
        return { error: `Give your reason for granting ${pick.name} to write: every agent offered it is told it.` };
      }
      if (writes !== undefined && writes.acknowledged !== true) {
        return { error: `Tick the acknowledgement to grant ${pick.name} to write.` };
      }
      picks.push({
        name: pick.name,
        definition_hash: pick.definition_hash,
        ...(writes !== undefined ? { writes: { acknowledged: true, reason: String(writes.reason).trim() }, held: pick.held === true } : {}),
        ...(typeof pick.owls_per_call === "number" && pick.owls_per_call > 0 ? { owls_per_call: pick.owls_per_call } : {}),
      });
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
      ...(result.write_granted.length > 0 ? [`Granted to write: ${listed(result.write_granted)}.`] : []),
      ...(result.write_revoked.length > 0 ? [`No longer granted to write: ${listed(result.write_revoked)}.`] : []),
    ];
    return { notice: parts.length > 0 ? parts.join(" ") : "Saved. Agents are offered the same tools as before." };
  } catch (err) {
    return refused(err);
  }
}

export async function decideWriteAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const decision = text(form, "decision") === "approve" ? "approve" : "decline";
  const note = text(form, "note").trim();
  try {
    const result = await decideConnectionWrite(user, text(form, "connection_id"), text(form, "call_id"), {
      decision,
      ...(note ? { note } : {}),
    });
    revalidatePath("/admin", "layout");
    if (result.outcome === "declined") return { notice: "Declined. Nothing was sent." };
    if (result.outcome === "not_sent") return { error: `Not sent: ${result.problem ?? "the call could no longer be sent"}.` };
    if (result.outcome === "failed") return { error: `Sent once, and it failed: ${result.problem ?? "no answer came"}. It was not sent again.` };
    return {
      notice: result.outcome === "tool_error" ? "Sent. The system answered with an error, shown below." : "Sent. What came back is shown below.",
    };
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
  if (name !== "general") return { error: "There is no such standing mandate." };
  const budget = text(form, "budget_owls");
  const daily = text(form, "daily_owls");
  if ((budget && !(Number(budget) >= 0)) || (daily && !(Number(daily) >= 0))) {
    return { error: "A budget and a pace are amounts of owls, nothing or more." };
  }
  // The label the mandate works at, where the deployment holds material at more than one.
  const label = text(form, "label");
  try {
    await setUpStandingMandate(user, name, {
      ...(budget ? { budget_owls: Number(budget) } : {}),
      ...(daily ? { daily_owls: Number(daily) } : {}),
      ...(label ? { label } : {}),
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
