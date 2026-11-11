import { NextRequest, NextResponse } from "next/server";
import { startAssistantConversation } from "../../../../lib/account-api";
import { asUser, jsonBody } from "../../../../lib/assistant-proxy";

// Opens a conversation. The reply forms in the background; the page reads
// the conversation until its turn is idle.
export async function POST(request: NextRequest) {
  const body = await jsonBody<{ message: string; model: string; node_id: string }>(request);
  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "The message is empty." }, { status: 400 });
  }
  return asUser(
    async (externalId) => ({
      conversation: await startAssistantConversation(externalId, {
        message,
        ...(body.model ? { model: body.model } : {}),
        ...(body.node_id ? { node_id: body.node_id } : {}),
      }),
    }),
    201
  );
}
