import { NextRequest } from "next/server";
import { sharePage, unsharePage } from "../../../../../../lib/account-api";
import { asUser } from "../../../../../../lib/assistant-proxy";

type Ctx = { params: Promise<{ id: string }> };

// Share a page by link, or withdraw the link: the signed-in user's own act.
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return asUser(async (externalId) => ({ page: await sharePage(externalId, id) }));
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return asUser((externalId) => unsharePage(externalId, id));
}
