import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  submitPrizePayee,
  AccountApiError,
} from "../../../../../lib/account-api";

// The winner's identity and residency step (docs/mathematics.md §8.7):
// dashboard session plus the emailed one-time code, so a leaked consumer key
// can never redirect a prize. Payee details are never echoed back.
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
  let body: {
    legal_name?: unknown; address?: unknown; country?: unknown; us_person?: unknown; code?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const legalName = String(body.legal_name ?? "").trim();
  const address = String(body.address ?? "").trim();
  const country = String(body.country ?? "").trim();
  const code = String(body.code ?? "").trim();
  if (!legalName || !address || !country) {
    return NextResponse.json(
      { error: "Legal name, postal address, and country of residence are all required." },
      { status: 400 }
    );
  }
  if (typeof body.us_person !== "boolean") {
    return NextResponse.json({ error: "Say whether you are a U.S. person." }, { status: 400 });
  }
  if (!code) {
    return NextResponse.json({ error: "Enter the one-time code that was emailed to you." }, { status: 400 });
  }
  try {
    const result = await submitPrizePayee(session.externalId, id, {
      legal_name: legalName, address, country, us_person: body.us_person, code,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AccountApiError) {
      const error =
        err.code === "INVALID_CODE" || err.code === "CODE_EXPIRED"
          ? "The one-time code is wrong or has expired. A fresh code is emailed when the prize becomes payable and on request from the operator."
          : err.code === "NOT_PAYABLE"
            ? "This prize claim is not payable yet, so the steps cannot be completed."
            : err.code === "FORBIDDEN" || err.status === 403
              ? "Only the claimant can complete the steps for this prize."
              : err.message;
      return NextResponse.json({ error, code: err.code }, { status: err.status });
    }
    console.error("[minerval] prize payee step failed:", err);
    return NextResponse.json(
      { error: "The details could not be recorded. Please try again later." },
      { status: 502 }
    );
  }
}
