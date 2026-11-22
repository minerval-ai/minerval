import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  proposeClaimIntake,
  AccountApiError,
} from "../../../../lib/account-api";
import { gettingOwlsFor } from "../../../../lib/load-owl-source";

// Propose-a-claim intake (#174 → #157): a signed-in reader suggests something
// the graph does not hold (the Matcher decides its kind, §7a), with or without saying why. Nothing is written directly; the proposal is queued for
// the Contribution Reviewer, and acceptance materializes it through the Matcher.

export const runtime = "nodejs";

function friendlyError(err: AccountApiError, gettingOwls: string): { status: number; error: string } {
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
    case "INSUFFICIENT_OWLS":
      return {
        status: 402,
        error:
          "Proposing a claim or question holds up to 2 owls while its assessment runs, and your " +
          `balance cannot cover it; the unused part of the hold comes back when the run finishes. ${gettingOwls} ` +
          "Or untick “Assess it” to propose it without assessing, which is free.",
      };
    case "LABEL_REQUIRED":
    case "LABEL_NOT_READABLE":
      // The API's own words name the labels that may be chosen.
      return { status: err.status, error: err.message };
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
      { error: "Proposing a claim or question requires signing in.", code: "SIGN_IN" },
      { status: 401 },
    );
  }

  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 },
    );
  }

  let body: { claim?: string; label?: string; assess?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const claim = (body.claim ?? "").trim();
  if (!claim || claim.length > 500) {
    return NextResponse.json(
      {
        error: "Please state it in one sentence (up to 500 characters).",
      },
      { status: 400 },
    );
  }
  try {
    const contribution = await proposeClaimIntake(session.externalId, {
      claim,
      ...(typeof body.label === "string" && body.label ? { label: body.label } : {}),
      // Assessed once accepted unless the proposer unticked it.
      ...(body.assess === false ? { assess: false } : {}),
    });
    return NextResponse.json({ contribution }, { status: 202 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const gettingOwls = err.code === "INSUFFICIENT_OWLS" ? await gettingOwlsFor(session.externalId) : "";
      const { status, error } = friendlyError(err, gettingOwls);
      return NextResponse.json({ error, code: err.code }, { status });
    }
    console.error("[minerval] claim proposal failed:", err);
    return NextResponse.json(
      { error: "The proposal could not be submitted. Please try again later." },
      { status: 502 },
    );
  }
}
