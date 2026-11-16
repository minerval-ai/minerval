"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import type { FormState } from "../../components/admin/ActionForm";
import { AccountApiError } from "../../lib/account-api";
import { addFileSet, closeFileSet, registerDirectory, rehashFileSet, switchFileSet } from "../../lib/inside-api";

// What the forms on the file-set pages do (docs/file-sets.md). Each acts for
// the person in the server's own session, and the API decides whether they
// may: uploading a set takes the permission to direct, registering a
// directory the permission to administer.

const NOT_SIGNED_IN: FormState = { error: "You are not signed in." };

async function actingUser(): Promise<string | null> {
  const session = await auth();
  return session?.externalId ?? null;
}

function refused(err: unknown): FormState {
  if (err instanceof AccountApiError) return { error: err.message };
  console.error("[file-sets] an action failed:", err);
  return { error: "That did not work, and nothing was changed. Try again in a moment." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function addFileSetAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const directory = text(form, "directory");
  const way = text(form, "way");
  const body = {
    name: text(form, "name"),
    description: text(form, "description") || undefined,
    party_id: text(form, "party_id"),
    stake: text(form, "stake"),
    ...(text(form, "label") ? { label: text(form, "label") } : {}),
  };
  if (!body.name) return { error: "Give the set a name." };
  if (!body.party_id) return { error: "Choose whose files these are." };
  if (!body.stake) return { error: "Say what that party stands to gain or lose from what the files show. Where it has no stake, say so." };
  if (way === "directory" && !directory) return { error: "Give the directory, as a path under the root this deployment registers directories from." };
  let id: string;
  try {
    const added = way === "directory" ? await registerDirectory(user, { ...body, directory }) : await addFileSet(user, body);
    id = added.file_set.id;
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/file-sets", "layout");
  redirect(`/file-sets/${id}`);
}

export async function closeFileSetAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await closeFileSet(user, text(form, "file_set_id"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/file-sets", "layout");
  return { notice: "Closed. Nothing is added to it or changed in it from now on." };
}

export async function rehashFileSetAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  try {
    await rehashFileSet(user, text(form, "file_set_id"));
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/file-sets", "layout");
  return { notice: "The directory is being walked and hashed again from nothing." };
}

export async function switchFileSetAction(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await actingUser();
  if (!user) return NOT_SIGNED_IN;
  const on = text(form, "enabled") === "true";
  try {
    await switchFileSet(user, text(form, "file_set_id"), on);
  } catch (err) {
    return refused(err);
  }
  revalidatePath("/file-sets", "layout");
  return { notice: on ? "Switched on. Runs whose label reads this set's label are offered it again." : "Switched off. No run is offered it from now on; what was kept from it stays." };
}
