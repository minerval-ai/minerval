import { NextRequest, NextResponse } from "next/server";
import { fetchContributionStatus } from "../../../../lib/api";

// Where a contribution stands, for the propose form to poll after submitting
// (so an accepted proposal links straight to the node it became). Public:
// contributions and their reviews are public records.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const status = await fetchContributionStatus(id);
  if (!status) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
