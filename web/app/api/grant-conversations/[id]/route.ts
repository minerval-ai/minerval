import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  getGrantConversation,
  AccountApiError,
} from "../../../../lib/account-api";

// The transcript fetch behind the mandate page's management chat.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Sign in to read the conversation.", code: "SIGN_IN" },
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
    const conversation = await getGrantConversation(session.externalId, id);
    return NextResponse.json({ conversation });
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: "The conversation could not be loaded." },
      { status: 502 }
    );
  }
}
