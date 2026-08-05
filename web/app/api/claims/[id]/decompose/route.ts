import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  createDecompositionJob,
  AccountApiError,
} from "../../../../../lib/account-api";

// Fund deep decomposition of this claim's subtree with an owl budget.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Funding decomposition requires signing in.", code: "SIGN_IN" },
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
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) {
    return NextResponse.json(
      { error: "Choose a budget between 0 and 1,000 owls." },
      { status: 400 }
    );
  }
  try {
    const job = await createDecompositionJob(session.externalId, id, budget);
    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const error =
        err.code === "INSUFFICIENT_OWLS"
          ? "Your owl balance can't cover that budget. Buy owls from your account page."
          : err.message;
      return NextResponse.json(
        { error, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] decomposition funding failed:", err);
    return NextResponse.json(
      { error: "The job could not be funded. Please try again later." },
      { status: 502 }
    );
  }
}
