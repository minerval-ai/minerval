import { NextResponse } from "next/server";
import { apiConfigured, fetchClaimCitation } from "@/lib/api";

// BFF endpoint for the "Cite this claim" panel (#290). Same seam as the other
// claim routes: the browser never talks to the backend directly and the API
// key stays server-side. No fixture fallback — a citation asserts what the
// live graph holds, so a design preview shows the panel's unavailable state
// instead of citing sample data.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!apiConfigured()) {
    return NextResponse.json(
      { error: "citation unavailable: not connected to the live graph" },
      { status: 503 },
    );
  }
  try {
    return NextResponse.json(await fetchClaimCitation(id));
  } catch {
    return NextResponse.json({ error: "claim not found" }, { status: 404 });
  }
}
