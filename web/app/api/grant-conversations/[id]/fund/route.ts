import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  fundGrantConversation,
  AccountApiError,
} from "../../../../../lib/account-api";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Sign in to fund the mandate.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  const body = (await request.json().catch(() => ({}))) as {
    budget_owls?: number;
  };
  const budget = Number(body.budget_owls);
  if (!(budget > 0)) {
    return NextResponse.json(
      { error: "A positive owl budget is required." },
      { status: 400 }
    );
  }
  try {
    const result = await fundGrantConversation(session.externalId, id, budget);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] mandate funding failed:", err);
    return NextResponse.json(
      { error: "Funding failed. Nothing was escrowed; please try again." },
      { status: 502 }
    );
  }
}
