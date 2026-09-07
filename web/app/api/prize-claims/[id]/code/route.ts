import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  requestPrizeClaimCode,
  AccountApiError,
  type PrizeCodePurpose,
} from "../../../../../lib/account-api";
import { prizeStepSentence } from "../../../../../lib/prize-forms";

// The one-time code (docs/mathematics.md §8.7): the API issues it through
// POST /prize-claims/:id/code {purpose} to the claimant's dashboard session
// only, and returns it in the response with a delivery note; no message is
// sent in this version. The page shows the code beside the step it unlocks.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Sign in to be issued a code.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  let body: { purpose?: unknown } = {};
  try {
    body = (await request.json()) as { purpose?: unknown };
  } catch {
    body = {};
  }
  const purpose: PrizeCodePurpose | null =
    body.purpose === "payee" ? "payee" : body.purpose === "withdraw" ? "withdraw" : null;
  if (!purpose) {
    return NextResponse.json(
      { error: "A code is issued for the payee steps or for a withdrawal, nothing else." },
      { status: 400 }
    );
  }
  try {
    const issued = await requestPrizeClaimCode(session.externalId, id, purpose);
    return NextResponse.json(issued);
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: prizeStepSentence(err, "code"), code: err.code },
        { status: err.status >= 500 ? 502 : err.status }
      );
    }
    console.error("[minerval] prize code request failed:", err);
    return NextResponse.json(
      { error: "A code could not be issued. Please try again later." },
      { status: 502 }
    );
  }
}
