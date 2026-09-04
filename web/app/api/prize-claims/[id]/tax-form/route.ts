import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  uploadPrizeTaxForm,
  AccountApiError,
} from "../../../../../lib/account-api";
import { buildTaxFormApiForm, prizeStepSentence } from "../../../../../lib/prize-forms";

// The winner's tax form (docs/mathematics.md §8.7, §8.9): a W-9 or W-8BEN,
// uploaded as a restricted attachment on the prize claim through
// POST /prize-claims/:id/attachments, which reads the file part `tax_form`,
// `kind` as w9 | w8ben, and the one-time `code` issued for the payee steps.
// Forwarded as multipart with the service key and the acting-user header;
// the body is never logged and never published.

export const runtime = "nodejs";

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
  const built = buildTaxFormApiForm(form);
  if (!built.ok) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }
  try {
    const result = await uploadPrizeTaxForm(session.externalId, id, built.form);
    return NextResponse.json({ attachment_id: result.attachment_id }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: prizeStepSentence(err, "tax_form"), code: err.code },
        { status: err.status >= 500 ? 502 : err.status }
      );
    }
    console.error("[minerval] prize tax form upload failed:", err);
    return NextResponse.json(
      { error: "The form could not be uploaded. Please try again later." },
      { status: 502 }
    );
  }
}
