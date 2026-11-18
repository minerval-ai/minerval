import { NextResponse } from "next/server";
import { auth } from "../../../../../../auth";
import { fetchShownPage } from "@/lib/inside-api";

// One shown page as the API serves it to the signed-in person, for the check
// that runs in their own browser (components/claim/CheckShownPage.tsx). Only
// a members-only build has this route, and the proxy of such a build has
// already refused anyone who is not a signed-in member; the API then serves
// the page only to a person who reads the label it is shown to.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; pageId: string }> }) {
  const session = await auth();
  if (!session?.externalId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const { id, pageId } = await params;
  try {
    return NextResponse.json(await fetchShownPage(session.externalId, id, pageId), { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "no page with that id is shown to a label you read" }, { status: 404 });
  }
}
