import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  createDecomposition,
  AccountApiError,
} from "../../../../../lib/account-api";

// The fewest owls a decomposition takes; the API holds the same line.
const MIN_OWLS = 5;

// Fund a decomposition of this claim: a mandate on it with an owl budget.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Funding a decomposition requires signing in.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  let body: { budget_owls?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const budget = Number(body.budget_owls);
  if (!Number.isFinite(budget) || budget < MIN_OWLS || budget > 10000) {
    return NextResponse.json(
      { error: `Choose a budget of at least ${MIN_OWLS} owls.` },
      { status: 400 }
    );
  }
  try {
    const funded = await createDecomposition(session.externalId, id, budget);
    return NextResponse.json(funded, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] decomposition funding failed:", err);
    return NextResponse.json(
      { error: "The decomposition could not be funded. Please try again later." },
      { status: 502 }
    );
  }
}
