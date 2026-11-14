import { NextResponse } from "next/server";
import { apiConfigured, fetchPublishedPackage } from "@/lib/api";

// The package of a published page exactly as signed, for the check that
// runs in the reader's browser (docs/published-pages.md) and for download.
// Same seam as the other routes here: the browser never talks to the
// backend directly.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!apiConfigured()) {
    return NextResponse.json({ error: "not connected to the live graph" }, { status: 503 });
  }
  const pkg = Number(new URL(req.url).searchParams.get("package")) || undefined;
  try {
    return NextResponse.json(await fetchPublishedPackage(id, pkg));
  } catch {
    return NextResponse.json({ error: "no such published page" }, { status: 404 });
  }
}
