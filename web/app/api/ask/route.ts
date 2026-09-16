import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../auth";
import {
  accountApiConfigured,
  askGraph,
  AccountApiError,
  type AskContext,
  type AskTurn,
} from "../../../lib/account-api";

// "Ask the graph" (#312): the BFF behind the claim page's ask box and the
// ask page. The acting identity always comes from the server session, so the
// exchange is metered to the signed-in reader; the API keeps no transcript.

/** Turns forwarded per exchange. Later turns of a long conversation cost
 * more, since the whole history is sent each time; the newest turns carry
 * the question, so the oldest are dropped first. */
const MAX_TURNS = 12;
const MAX_TURN_CHARS = 4_000;

function parseTurns(raw: unknown): AskTurn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const turns: AskTurn[] = [];
  for (const t of raw) {
    if (
      !t ||
      typeof t !== "object" ||
      (t.role !== "user" && t.role !== "assistant") ||
      typeof t.content !== "string" ||
      t.content.trim().length === 0 ||
      t.content.length > MAX_TURN_CHARS
    ) {
      return null;
    }
    turns.push({ role: t.role, content: t.content });
  }
  if (turns[turns.length - 1]!.role !== "user") return null;
  // Keep the tail, but never start on an assistant turn.
  let tail = turns.slice(-MAX_TURNS);
  while (tail.length > 0 && tail[0]!.role !== "user") tail = tail.slice(1);
  return tail;
}

function parseContext(raw: unknown): AskContext | null {
  if (!raw || typeof raw !== "object") return { kind: "graph" };
  const c = raw as { kind?: unknown; claim_id?: unknown };
  if (c.kind === "graph" || c.kind === undefined) return { kind: "graph" };
  if (
    c.kind === "claim" &&
    typeof c.claim_id === "string" &&
    /^[0-9a-f-]{36}$/i.test(c.claim_id)
  ) {
    return { kind: "claim", claim_id: c.claim_id };
  }
  return null;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Asking the graph requires signing in.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  let body: { messages?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const messages = parseTurns(body.messages);
  const context = parseContext(body.context);
  if (!messages || !context) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const result = await askGraph(session.externalId, { messages, context });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AccountApiError) {
      const error =
        err.code === "INSUFFICIENT_OWLS"
          ? "Each answer holds a fraction of an owl while it runs, and your " +
            "balance cannot cover that. You can buy owls from your account page."
          : err.code === "RATE_LIMITED"
            ? "Too many questions in the last hour; please try again a little later."
            : err.message;
      return NextResponse.json({ error, code: err.code }, { status: err.status });
    }
    console.error("[minerval] ask failed:", err);
    return NextResponse.json(
      { error: "The graph could not answer just now. Please try again later." },
      { status: 502 }
    );
  }
}
