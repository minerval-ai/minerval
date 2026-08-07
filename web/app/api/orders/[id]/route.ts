import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  cancelAssessmentOrder,
  AccountApiError,
} from "../../../../lib/account-api";

// Cancel a pending assessment order (free — pending orders are uncharged).
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  try {
    const result = await cancelAssessmentOrder(session.externalId, id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: "Cancellation failed. Please try again." },
      { status: 502 }
    );
  }
}
