import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  submitPrizePayee,
  AccountApiError,
} from "../../../../../lib/account-api";
import { payeeBodyFromRequest, prizeStepSentence } from "../../../../../lib/prize-forms";

// The winner's identity and residency step (docs/mathematics.md §8.7):
// dashboard session plus a one-time code, so a leaked consumer key can never
// redirect a prize. The API reads legal_name, country, us_person, has_tin,
// treaty_position, and code; has_tin and treaty_position decide the
// withholding, so both are always sent. Payee details are never echoed back.
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
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = payeeBodyFromRequest(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const result = await submitPrizePayee(session.externalId, id, parsed.body);
    return NextResponse.json({
      recorded: true,
      identity_recorded_at: result.payee?.identity_recorded_at ?? null,
    });
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: prizeStepSentence(err, "payee"), code: err.code },
        { status: err.status >= 500 ? 502 : err.status }
      );
    }
    console.error("[minerval] prize payee step failed:", err);
    return NextResponse.json(
      { error: "The details could not be recorded. Please try again later." },
      { status: 502 }
    );
  }
}
