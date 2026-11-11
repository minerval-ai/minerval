import { NextRequest, NextResponse } from "next/server";
import { deletePage, getPage, savePage } from "../../../../../lib/account-api";
import { asUser, jsonBody } from "../../../../../lib/assistant-proxy";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return asUser(async (externalId) => ({ page: await getPage(externalId, id) }));
}

// The user's own edit: the earlier text is kept as a version.
export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await jsonBody<{ title: string; body: string }>(request);
  const title = body.title?.trim();
  const text = body.body?.trim();
  if (!title || !text) {
    return NextResponse.json({ error: "A page needs a title and a body." }, { status: 400 });
  }
  return asUser((externalId) => savePage(externalId, { id, title, body: text }));
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return asUser((externalId) => deletePage(externalId, id));
}
