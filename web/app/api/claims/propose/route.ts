import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  proposeClaimIntake,
  AccountApiError,
} from "../../../../lib/account-api";

// Propose-a-claim intake (#174 → #157): a signed-in reader suggests a claim the
// graph does not hold. Nothing is written directly; the proposal is queued for
// the Contribution Reviewer, and acceptance materializes it through the Matcher.

export const runtime = "nodejs";

function friendlyError(err: AccountApiError): { status: number; error: string } {
  switch (err.code) {
    case "DEPOSIT_REQUIRED":
      return {
        status: 402,
        error:
          "Contributing from this account is paused: a previous contribution was flagged as suspected bad faith. The flag can be appealed, and a successful appeal restores your standing in full. See the contributor section of your account page.",
      };
    case "CONTRIBUTOR_SUSPENDED":
      return {
        status: 403,
        error: "This account is suspended from contributing.",
      };
    case "CONTRIBUTION_RATE_LIMITED":
      return {
        status: 429,
        error:
          "You have reached the hourly contribution limit for this account. Please try again later.",
      };
    case "QUOTA_EXCEEDED":
      return {
        status: 402,
        error:
          "Your monthly free-tier allowance is exhausted; it resets next month. Proposing a claim triggers review work, which draws on the allowance.",
      };
    default:
      return {
        status: err.status >= 500 ? 502 : err.status,
        error: "The proposal could not be submitted. Please try again later.",
      };
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Proposing a claim requires signing in.", code: "SIGN_IN" },
      { status: 401 },
    );
  }

  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 },
    );
  }

  let body: { claim?: string; argument?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const claim = (body.claim ?? "").trim();
  const argument = (body.argument ?? "").trim();
  if (!claim || claim.length > 500) {
    return NextResponse.json(
      { error: "Please state the claim in one sentence (up to 500 characters)." },
      { status: 400 },
    );
  }
  // The intake schema requires a supporting argument: a proposal is a claim
  // plus the case for holding it, not a bare sentence.
  if (!argument || argument.length > 5000) {
    return NextResponse.json(
      {
        error:
          "Please say why the claim belongs in the graph: the evidence or reasoning behind it (up to 5,000 characters).",
      },
      { status: 400 },
    );
  }

  try {
    const contribution = await proposeClaimIntake(session.externalId, {
      claim,
      argument,
    });
    return NextResponse.json({ contribution }, { status: 202 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const { status, error } = friendlyError(err);
      return NextResponse.json({ error, code: err.code }, { status });
    }
    console.error("[minerval] claim proposal failed:", err);
    return NextResponse.json(
      { error: "The proposal could not be submitted. Please try again later." },
      { status: 502 },
    );
  }
}
