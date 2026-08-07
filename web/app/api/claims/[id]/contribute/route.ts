import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  allocateToClaim,
  AccountApiError,
} from "../../../../../lib/account-api";

// Chip in toward a claim's next assessment: allocations accumulate across
// funders and the assessment runs the moment they cover its cost.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Sign in to put owls toward this claim.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  const body = (await request.json().catch(() => ({}))) as { owls?: number };
  const owls = Number(body.owls);
  if (!(owls > 0)) {
    return NextResponse.json(
      { error: "A positive number of owls is required." },
      { status: 400 }
    );
  }
  try {
    const result = await allocateToClaim(session.externalId, id, owls);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AccountApiError) {
      const error =
        err.code === "INSUFFICIENT_OWLS"
          ? "Your balance cannot cover that. You can buy owls from your " +
            "account page."
          : err.message;
      return NextResponse.json(
        { error, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] claim allocation failed:", err);
    return NextResponse.json(
      { error: "The contribution could not be made. Please try again." },
      { status: 502 }
    );
  }
}
