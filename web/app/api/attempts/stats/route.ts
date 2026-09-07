import { NextResponse } from "next/server";
import { apiConfigured, fetchAttemptStats } from "@/lib/api";

// BFF endpoint for the platform's attempt record (docs/mathematics.md §7.10):
// the same seam as the server pages (lib/api, with the API key server-side),
// so the browser never talks to the backend directly. `?grant_id=` narrows
// the record to one mandate's attempts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  if (!apiConfigured()) {
    return NextResponse.json({ error: "the frontend is not connected to a Minerval API" }, { status: 503 });
  }
  const grantId = new URL(req.url).searchParams.get("grant_id");
  if (grantId && !UUID_RE.test(grantId)) {
    return NextResponse.json({ error: "grant_id must be a uuid" }, { status: 400 });
  }
  const stats = await fetchAttemptStats(grantId);
  if (!stats) {
    return NextResponse.json({ error: "the attempt record is unavailable" }, { status: 502 });
  }
  return NextResponse.json(stats);
}
