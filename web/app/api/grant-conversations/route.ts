import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../auth";
import {
  accountApiConfigured,
  startGrantConversation,
  AccountApiError,
} from "../../../lib/account-api";

// Opens a granting conversation. Grantmaker turns run a frontier model, so
// give the route the full serverless budget rather than the default.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Creating a grant requires signing in.", code: "SIGN_IN" },
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
    message?: string;
  };
  if (!body.message?.trim()) {
    return NextResponse.json(
      { error: "Say what you want the mandate to do." },
      { status: 400 }
    );
  }
  try {
    const conversation = await startGrantConversation(
      session.externalId,
      body.message.trim()
    );
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] grant conversation start failed:", err);
    return NextResponse.json(
      { error: "The conversation could not be started. Please try again." },
      { status: 502 }
    );
  }
}
