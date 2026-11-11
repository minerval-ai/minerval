import { NextRequest, NextResponse } from "next/server";
import { sendAssistantMessage } from "../../../../../../lib/account-api";
import { asUser, jsonBody } from "../../../../../../lib/assistant-proxy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await jsonBody<{ message: string }>(request);
  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "The message is empty." }, { status: 400 });
  }
  return asUser(async (externalId) => ({
    conversation: await sendAssistantMessage(externalId, id, message),
  }));
}
