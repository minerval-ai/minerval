import { NextResponse } from "next/server";
import { loadWorkCounts } from "@/lib/inbox";
import { loadStanding } from "@/lib/standing";

// The counts beside the sidebar's entries (components/work/Sidebar.tsx), read
// after a page has drawn so that no page waits on them. Every read behind them
// is the API's, made as the signed-in member; a person who is not one is
// answered with nothing. Only a members-only build has this route.
export async function GET() {
  const standing = await loadStanding();
  if (standing.state !== "signed_in" || !standing.mine.member) {
    return NextResponse.json({ error: "not a member" }, { status: 401 });
  }
  const counts = await loadWorkCounts(standing.externalId, standing.mine);
  return NextResponse.json(counts, { headers: { "cache-control": "no-store" } });
}

