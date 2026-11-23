"use server";

import { revalidatePath } from "next/cache";
import { auth } from "../../../auth";
import type { FormState } from "../../../components/admin/ActionForm";
import { AccountApiError } from "../../../lib/account-api";
import {
  becomeFirstAdministrator,
  markReleaseStepDone,
  renameParty,
  resetSetting,
  restartApi,
  setSetting,
  uploadReleaseList,
  type SettingView,
} from "../../../lib/admin-api";
import { parseField } from "../../../lib/settings";

// What the forms on the settings page do (docs/settings.md). Each acts for
// the person in the server's own session, and the API decides whether they
// may and whether the value can be used: what it refuses is said beside the
// form in the API's own words.

const NOT_SIGNED_IN: FormState = { error: "You are not signed in." };
const KINDS: ReadonlyArray<SettingView["kind"]> = ["text", "number", "boolean", "list", "groups", "lists"];

async function actingUser(): Promise<string | null> {
  const session = await auth();
  return session?.externalId ?? null;
}

function refused(err: unknown): FormState {
  if (err instanceof AccountApiError) return { error: err.message };
  console.error("[settings] an action failed:", err);
  return { error: "That did not work, and nothing was changed. Try again in a moment." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** What the API said of a change, in a sentence for beside the form. */
function said(key: string, outcome: { in_force: "now" | "at_restart"; warnings: Array<{ check: string; message: string }> }, verb: string): string {
  const when = outcome.in_force === "now" ? "It is in force now." : "It takes effect when the API is next started.";
  const warned = outcome.warnings.map((w) => ` With it the check "${w.check}" fails: ${w.message}`).join("");
  return `${verb} ${key}. ${when}${warned}`;
}

export async function setSettingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const key = text(form, "key");
  const kind = KINDS.find((k) => k === text(form, "kind"));
  if (!key || !kind) return { error: "The form did not say which setting it is for." };
  const secret = form.get("secret") === "true";
  const raw = String(form.get("value") ?? "");
  let value;
  if (secret) {
    if (raw.trim() === "") return { error: "Paste the key." };
    value = raw.trim();
  } else {
    const parsed = parseField(kind, raw);
    if (!parsed.ok) return { error: parsed.error };
    value = parsed.value;
  }
  const reason = text(form, "reason");
  try {
    const outcome = await setSetting(user, key, { value, ...(reason ? { reason } : {}) });
    revalidatePath("/admin", "layout");
    return { notice: said(key, outcome, secret ? "Saved the key" : "Saved") };
  } catch (err) {
    return refused(err);
  }
}

export async function resetSettingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const key = text(form, "key");
  if (!key) return { error: "The form did not say which setting it is for." };
  const reason = text(form, "reason");
  try {
    const outcome = await resetSetting(user, key, reason ? { reason } : {});
    revalidatePath("/admin", "layout");
    return { notice: said(key, outcome, form.get("secret") === "true" ? "Removed the key" : "Returned to its default:") };
  } catch (err) {
    return refused(err);
  }
}

export async function restartAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const reason = text(form, "reason");
  try {
    await restartApi(user, reason ? { reason } : {});
  } catch (err) {
    return refused(err);
  }
  return {
    notice:
      "The API is starting again. It answers nothing for a few seconds; every run that was in flight handed its work back and is taken up again.",
  };
}

export async function renamePartyAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const partyId = text(form, "party_id");
  const name = text(form, "name");
  if (!partyId) return { error: "The form did not say which party it is for." };
  if (!name) return { error: "Give the name." };
  try {
    const { party } = await renameParty(user, partyId, name);
    revalidatePath("/admin", "layout");
    return { notice: `It is ${party.name} now.` };
  } catch (err) {
    return refused(err);
  }
}

export async function firstAdministratorAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const code = text(form, "code");
  if (!code) return { error: "Give the code." };
  try {
    await becomeFirstAdministrator(user, code);
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/", "layout");
  return { notice: "You are this deployment's first administrator. Loading it now." };
}

// --- Minerval's releases (docs/releases.md) -------------------------------------

export async function releaseStepDoneAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const version = text(form, "version");
  const step = text(form, "step");
  if (!version || !step) return { error: "The form did not say which step it is for." };
  try {
    await markReleaseStepDone(user, version, step);
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/admin", "layout");
  return { notice: "Marked done." };
}

export async function uploadReleaseListAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the file of the list." };
  if (file.size > 4_000_000) return { error: "That file is larger than a list of releases is." };
  let entries: unknown;
  try {
    entries = (JSON.parse(await file.text()) as { entries?: unknown }).entries;
  } catch {
    return { error: "That file is not the list: it is not JSON." };
  }
  if (!Array.isArray(entries)) return { error: "That file is not the list: it has no entries." };
  try {
    const outcome = await uploadReleaseList(user, entries);
    revalidatePath("/admin", "layout");
    const kept = outcome.accepted + outcome.already;
    if (kept === 0 && outcome.refused.length > 0) {
      return { error: `Nothing in the file carries Minerval's signature as this version knows it. ${outcome.refused[0]!.message}` };
    }
    return {
      notice:
        `Kept ${outcome.accepted} new ${outcome.accepted === 1 ? "entry" : "entries"}` +
        (outcome.already > 0 ? `; ${outcome.already} were here already` : "") +
        (outcome.refused.length > 0 ? `; ${outcome.refused.length} did not carry Minerval's signature and were left out` : "") +
        ".",
    };
  } catch (err) {
    return refused(err);
  }
}
