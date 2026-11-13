import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../../auth";
import { accountApiConfigured, assistantTurnStream } from "../../../../../../lib/account-api";

// The running turn as an event stream, passed through from the API as it
// arrives. A long reply can outlast this function's time limit; the page
// reconnects when the stream ends without a `done` event, and falls back to
// reading the conversation if it cannot.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json({ error: "Sign in to use the Assistant.", code: "SIGN_IN" }, { status: 401 });
  }
  if (!accountApiConfigured()) {
    return NextResponse.json({ error: "Not connected to a Minerval API." }, { status: 503 });
  }
  let upstream: Response;
  try {
    upstream = await assistantTurnStream(session.externalId, id, request.signal);
  } catch {
    return NextResponse.json({ error: "The stream could not be opened." }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "The stream could not be opened." }, { status: upstream.status || 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
