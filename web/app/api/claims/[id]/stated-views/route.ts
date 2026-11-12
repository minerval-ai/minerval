import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  submitStatedView,
  AccountApiError,
} from "../../../../../lib/account-api";

// Stating a view on a node (constitution §4): the browser posts here; the
// handler holds the session, and the service key with x-acting-user stays
// server-side. The API checks the statement against the node's kind and
// answers in words a person can act on, so those pass through. The
// contributor gate's outcomes are put in this page's own words.

export const runtime = "nodejs";

function gateError(err: AccountApiError): { status: number; error: string } | null {
  switch (err.code) {
    case "DEPOSIT_REQUIRED":
      return {
        status: 402,
        error:
          "Stating a view from this account is paused: an earlier contribution was flagged as suspected bad faith. The flag can be appealed, and a successful appeal restores your standing in full. See the contributor section of your account page.",
      };
    case "CONTRIBUTOR_SUSPENDED":
      return { status: 403, error: "This account is suspended from contributing." };
    case "CONTRIBUTION_RATE_LIMITED":
      return {
        status: 429,
        error: "You have reached the hourly contribution limit for this account. Please try again later.",
      };
    case "NOT_FOUND":
      return { status: 404, error: "This page no longer exists." };
    default:
      return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Stating a view requires signing in.", code: "SIGN_IN" },
      { status: 401 },
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const statement = text(body.statement);
  if (!statement) {
    return NextResponse.json({ error: "Please write your view." }, { status: 400 });
  }
  const noStake = body.no_stake === true;
  const stake = text(body.stake);
  if (!noStake && !stake) {
    return NextResponse.json(
      { error: "Please say what your stake in the answer is, or tick the box if you have none." },
      { status: 400 },
    );
  }
  const probability =
    body.probability === undefined || body.probability === null || body.probability === ""
      ? undefined
      : Number(body.probability);
  const evidenceUrls = Array.isArray(body.evidence_urls)
    ? body.evidence_urls.filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean).slice(0, 20)
    : [];

  try {
    const result = await submitStatedView(session.externalId, id, {
      statement,
      stance: text(body.stance),
      ...(probability !== undefined ? { probability } : {}),
      ...(body.figure && typeof body.figure === "object" ? { figure: body.figure as Record<string, unknown> } : {}),
      ...(text(body.reasons) ? { reasons: text(body.reasons) } : {}),
      evidenceUrls,
      ...(noStake ? { noStake: true } : { stake }),
      displayName: session.user?.name ?? undefined,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const gate = gateError(err);
      if (gate) return NextResponse.json({ error: gate.error, code: err.code }, { status: gate.status });
      // A refusal of the statement itself (422) or of the node (409) is
      // written by the API for whoever is filing it.
      if (err.status === 422 || err.status === 409) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      }
      return NextResponse.json(
        { error: "The statement could not be submitted. Please try again later.", code: err.code },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    console.error("[minerval] stated view submit failed:", err);
    return NextResponse.json(
      { error: "The statement could not be submitted. Please try again later." },
      { status: 502 },
    );
  }
}
