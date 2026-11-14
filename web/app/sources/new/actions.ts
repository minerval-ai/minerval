"use server";

import { revalidatePath } from "next/cache";
import { auth } from "../../../auth";
import { AccountApiError } from "../../../lib/account-api";
import { submitSource } from "../../../lib/admin-api";

// Submitting a source from the page (POST /sources). The person acting is
// the one in the server's own session. The API decides whether they may (in
// a members-only deployment, the permission to direct) and holds the charge.

export interface AddSourceState {
  error?: string;
  submitted?: { sourceId: string; contributionId: string | null; waitingForReview: boolean };
}

export async function addSourceAction(_previous: AddSourceState, form: FormData): Promise<AddSourceState> {
  const session = await auth();
  if (!session?.externalId) return { error: "You are not signed in." };
  const url = String(form.get("url") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  const content = String(form.get("content") ?? "");
  // Named where the deployment holds material at more than one label.
  const label = String(form.get("label") ?? "").trim();
  try {
    // The same test the API makes, so the commonest mistake is said plainly.
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not a web address");
  } catch {
    return { error: "Give the source's address in full, starting http:// or https://." };
  }
  try {
    const result = await submitSource(session.externalId, {
      url,
      ...(title ? { title } : {}),
      ...(content.trim() ? { content } : {}),
      ...(label ? { label } : {}),
    });
    // The page shows the balance, which the submission has just drawn on.
    revalidatePath("/sources/new");
    return {
      submitted: {
        sourceId: result.source_id,
        contributionId: result.contribution_id ?? null,
        waitingForReview: result.status === "pending_review",
      },
    };
  } catch (err) {
    if (err instanceof AccountApiError) return { error: err.message };
    console.error("[sources] adding a source failed:", err);
    return { error: "That did not work, and nothing was added. Try again in a moment." };
  }
}
