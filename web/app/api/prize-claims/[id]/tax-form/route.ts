import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  uploadPrizeTaxForm,
  AccountApiError,
} from "../../../../../lib/account-api";

// The winner's tax form (docs/mathematics.md §8.7, §8.9): a W-9 or W-8BEN,
// uploaded as a restricted attachment of kind tax_form on the prize claim.
// Forwarded as multipart with the service key and the acting-user header; the
// body is never logged and never published.

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Sign in to complete the prize steps.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Attach the completed form." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "The form must be at most 10 MiB." }, { status: 400 });
  }
  const formKind = String(form.get("form_kind") ?? "");
  if (formKind !== "w9" && formKind !== "w8ben") {
    return NextResponse.json({ error: "Say whether the form is a W-9 or a W-8BEN." }, { status: 400 });
  }
  form.set("kind", "tax_form");
  try {
    const result = await uploadPrizeTaxForm(session.externalId, id, form);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const error =
        err.code === "INVALID_SUBMISSION"
          ? "The file was refused: it must be a PDF of the completed form."
          : err.code === "NOT_PAYABLE"
            ? "This prize claim is not payable yet, so the steps cannot be completed."
            : err.status === 403
              ? "Only the claimant can complete the steps for this prize."
              : err.message;
      return NextResponse.json({ error, code: err.code }, { status: err.status });
    }
    console.error("[minerval] prize tax form upload failed:", err);
    return NextResponse.json(
      { error: "The form could not be uploaded. Please try again later." },
      { status: 502 }
    );
  }
}
