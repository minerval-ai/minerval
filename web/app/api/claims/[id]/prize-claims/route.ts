import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  submitPrizeClaim,
  AccountApiError,
} from "../../../../../lib/account-api";
import { buildPrizeClaimApiForm } from "../../../../../lib/prize-forms";

// The prize-claim route (docs/mathematics.md §8.4): the browser posts the
// form here as multipart; the handler holds the session, rebuilds the body
// under the field names the API reads (lib/prize-forms.ts), and forwards it
// with the service key and the acting-user header, files included. The API
// validates independently: statement version, attachment policy, the static
// Lean policy, eligibility, rate limits, and the declarations. This route
// only turns each of its codes into a sentence a claimant can act on.

export const runtime = "nodejs";

function friendlyError(err: AccountApiError): { status: number; error: string } {
  switch (err.code) {
    case "NO_OPEN_BOUNTY":
      return {
        status: 409,
        error:
          "No prize is open on this statement right now: either a submission is under review, the house solver's result is pending, or the prize has closed. The claim page says which.",
      };
    case "STATEMENT_NOT_CURRENT":
      return {
        status: 409,
        error:
          "The formal statement was revised after this form was opened. Reload the page and file against the current statement.",
      };
    case "INELIGIBLE":
      return {
        status: 403,
        error:
          "This account is not eligible to claim a prize: the platform's own account, mandate funders, and program contractors are excluded, and an account must be at least probationary.",
      };
    case "DUPLICATE_LIVE_CLAIM":
      return {
        status: 409,
        error:
          "You already have a live submission on this statement version. Withdraw it, or wait for its outcome, before filing another.",
      };
    case "PRIZE_CLAIM_RATE_LIMITED":
      return {
        status: 429,
        error:
          "Too many submissions for now: at most three per statement in thirty days, and a cooldown after a failed check. The cooldown is waived once for a resubmission within seventy-two hours of a near miss.",
      };
    case "INVALID_SUBMISSION":
      return {
        status: 422,
        error: err.message && !err.message.startsWith("Minerval API ")
          ? `The submission was refused before anything ran: ${err.message}`
          : "The submission was refused before anything ran: a file or the Lean source breaks the attachment policy or the static Lean policy published with the rules.",
      };
    case "DECLARATIONS_REQUIRED":
      return {
        status: 422,
        error: err.message && !err.message.startsWith("Minerval API ")
          ? `The declarations were not accepted: ${err.message}.`
          : "Each declaration must be made, and the claim must be filed under the rules version in force.",
      };
    case "DEPOSIT_REQUIRED":
      return {
        status: 402,
        error:
          "Contributing from this account is paused: a previous contribution was flagged as suspected bad faith. The flag can be appealed, and a successful appeal restores your standing in full.",
      };
    case "CONTRIBUTOR_SUSPENDED":
      return { status: 403, error: "This account is suspended from contributing." };
    case "USER_IDENTITY_REQUIRED":
      return { status: 403, error: "This account is not provisioned for contributing; sign out and back in." };
    case "NOT_FOUND":
      return { status: 404, error: "This claim no longer exists." };
    default:
      return {
        status: err.status >= 500 ? 502 : err.status,
        error: "The submission could not be filed. Please try again later.",
      };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Filing a prize claim requires signing in.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Light checks that save a round trip, and the rebuild under the API's
  // field names; the API is the authority.
  const built = buildPrizeClaimApiForm(form);
  if (!built.ok) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  try {
    const result = await submitPrizeClaim(session.externalId, id, built.form);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const { status, error } = friendlyError(err);
      return NextResponse.json({ error, code: err.code }, { status });
    }
    console.error("[minerval] prize claim submit failed:", err);
    return NextResponse.json(
      { error: "The submission could not be filed. Please try again later." },
      { status: 502 }
    );
  }
}
