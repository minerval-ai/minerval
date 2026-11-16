import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import { accountApiConfigured, takeUpRequest, AccountApiError } from "../../../../../lib/account-api";

// Take a request up (docs/outward-acts.md, "Taking up a request in public"):
// the account says, on the request's record and under its own name, that it
// is doing the work. It commits the account to doing the work well, not to
// a result, and funds nothing.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json({ error: "Sign in to take a request up.", code: "SIGN_IN" }, { status: 401 });
  }
  if (!accountApiConfigured()) {
    return NextResponse.json({ error: "This deployment is not connected to a Minerval API." }, { status: 503 });
  }
  try {
    return NextResponse.json(await takeUpRequest(session.externalId, id));
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("[minerval] taking up a request failed:", err);
    return NextResponse.json({ error: "That did not go through; please try again." }, { status: 502 });
  }
}
