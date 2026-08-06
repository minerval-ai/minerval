import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  continueGrantConversation,
  AccountApiError,
} from "../../../../../lib/account-api";

export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Sign in to continue the conversation.", code: "SIGN_IN" },
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
    return NextResponse.json({ error: "The message is empty." }, { status: 400 });
  }
  try {
    const conversation = await continueGrantConversation(
      session.externalId,
      id,
      body.message.trim()
    );
    return NextResponse.json({ conversation });
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] grant conversation turn failed:", err);
    return NextResponse.json(
      { error: "The reply could not be produced. Please try again." },
      { status: 502 }
    );
  }
}
