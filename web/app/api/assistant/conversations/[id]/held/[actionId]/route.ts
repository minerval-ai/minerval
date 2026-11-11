import { NextRequest, NextResponse } from "next/server";
import { decideAssistantHeldAction } from "../../../../../../../lib/account-api";
import { asUser, jsonBody } from "../../../../../../../lib/assistant-proxy";

// The user's answer to a held action: run it, or decline it. This is the
// one place a held call is released, and it takes the signed-in session.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; actionId: string }> }
) {
  const { id, actionId } = await params;
  const body = await jsonBody<{
    decision: "run" | "decline";
    allow: { scope: "conversation" | "always" };
  }>(request);
  if (body.decision !== "run" && body.decision !== "decline") {
    return NextResponse.json({ error: "Say whether to run or decline it." }, { status: 400 });
  }
  const decision = body.decision;
  const scope = body.allow?.scope;
  return asUser(async (externalId) => ({
    conversation: await decideAssistantHeldAction(externalId, id, actionId, {
      decision,
      ...(scope === "conversation" || scope === "always" ? { allow: { scope } } : {}),
    }),
  }));
}
