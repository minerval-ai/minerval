import { NextRequest, NextResponse } from "next/server";
import {
  deleteAssistantConversation,
  getAssistantConversation,
  setAssistantModel,
} from "../../../../../lib/account-api";
import { asUser, jsonBody } from "../../../../../lib/assistant-proxy";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return asUser(async (externalId) => ({
    conversation: await getAssistantConversation(externalId, id),
  }));
}

// Choose the model for the replies that follow.
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await jsonBody<{ model: string }>(request);
  if (!body.model) {
    return NextResponse.json({ error: "No model was named." }, { status: 400 });
  }
  const model = body.model;
  return asUser(async (externalId) => ({
    conversation: await setAssistantModel(externalId, id, model),
  }));
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return asUser((externalId) => deleteAssistantConversation(externalId, id));
}
