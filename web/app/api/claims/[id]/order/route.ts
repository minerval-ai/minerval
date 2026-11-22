import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  createAssessmentOrder,
  getOpenOrderForClaim,
  AccountApiError,
} from "../../../../../lib/account-api";
import { gettingOwlsFor } from "../../../../../lib/load-owl-source";
import { fetchAssessmentUnderWay } from "../../../../../lib/api";

// The claim page's order surface: GET polls the signed-in user's open order
// for this claim, and whether any pass on it is under way; POST places one. The acting identity always comes from the
// server session.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  // Whether a pass is under way, anyone's: what a reader is shown in place
  // of the button while one is (an accepted proposal's first assessment,
  // someone else's order, the graph's own pass).
  const underWay = fetchAssessmentUnderWay(id).catch(() => ({ under_way: null, assessed: false }));
  if (!session?.externalId) {
    return NextResponse.json({ order: null, signed_in: false, ...(await underWay) });
  }
  if (!accountApiConfigured()) {
    return NextResponse.json({ order: null, signed_in: true, ...(await underWay) });
  }
  try {
    const order = await getOpenOrderForClaim(session.externalId, id);
    return NextResponse.json({ order, signed_in: true, ...(await underWay) });
  } catch {
    return NextResponse.json({ order: null, signed_in: true, ...(await underWay) });
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Ordering an assessment requires signing in.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  try {
    const order = await createAssessmentOrder(session.externalId, id);
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const error =
        err.code === "INSUFFICIENT_OWLS"
          ? "An assessment holds up to 2 owls while it runs, and your balance " +
            `cannot cover that ceiling. ${await gettingOwlsFor(session.externalId)}`
          : err.code === "ORDER_ALREADY_OPEN"
            ? "You already have an open order for this claim."
            : err.message;
      return NextResponse.json(
        { error, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] order creation failed:", err);
    return NextResponse.json(
      { error: "The order could not be placed. Please try again later." },
      { status: 502 }
    );
  }
}
