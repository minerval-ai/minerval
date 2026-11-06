/**
 * A Correspondent's Atom feed (#563), served from the site so readers can
 * subscribe at a public address: the API's GET /correspondents/:id/feed,
 * passed through unchanged.
 */
import { NextRequest, NextResponse } from "next/server";

const BASE = process.env.MINERVAL_API_URL?.replace(/\/$/, "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return new NextResponse("Not found", { status: 404 });
  if (!BASE) return new NextResponse("This deployment is not connected to a Minerval API.", { status: 503 });
  const res = await fetch(`${BASE}/correspondents/${id}/feed`, { next: { revalidate: 300 } });
  if (!res.ok) return new NextResponse(res.status === 404 ? "Not found" : "Feed unavailable", { status: res.status });
  return new NextResponse(await res.text(), {
    status: 200,
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
}
