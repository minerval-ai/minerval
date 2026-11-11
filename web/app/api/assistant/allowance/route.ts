import { NextRequest } from "next/server";
import { setAssistantAllowance } from "../../../../lib/account-api";
import { asUser, jsonBody } from "../../../../lib/assistant-proxy";

// Which kinds of held action run without asking, in every conversation.
export async function PUT(request: NextRequest) {
  const body = await jsonBody<{ kinds: string[] }>(request);
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k) => typeof k === "string") : [];
  return asUser((externalId) => setAssistantAllowance(externalId, kinds));
}
