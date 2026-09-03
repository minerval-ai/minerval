import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import {
  accountApiConfigured,
  submitPrizeClaim,
  AccountApiError,
} from "../../../../../lib/account-api";

// The prize-claim route (docs/mathematics.md §8.4): the browser posts the
// form here as multipart; the handler holds the session and forwards the
// FormData to the API with the service key and the acting-user header, files
// included, the way the JSON routes forward their bodies. The API validates
// independently: statement version, attachment policy, the static Lean
// policy, eligibility, rate limits, and the declarations. This route only
// turns each of its codes into a sentence a claimant can act on.

export const runtime = "nodejs";

const CONTENT_MIN = 200;
const CONTENT_MAX = 20_000;
const LEAN_MAX_BYTES = 256 * 1024;
const DOCS_MAX = 5;
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const DOCS_TOTAL_BYTES = 25 * 1024 * 1024;

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
        error: err.message && err.message !== `Minerval API ${err.status} for /claims`
          ? `The submission was refused before anything ran: ${err.message}`
          : "The submission was refused before anything ran: a file or the Lean source breaks the attachment policy or the static Lean policy published with the rules.",
      };
    case "DECLARATIONS_REQUIRED":
      return {
        status: 422,
        error:
          "Each declaration must be made, and the claim must be filed under the rules version in force.",
      };
    case "DEPOSIT_REQUIRED":
      return {
        status: 402,
        error:
          "Contributing from this account is paused: a previous contribution was flagged as suspected bad faith. The flag can be appealed, and a successful appeal restores your standing in full.",
      };
    case "CONTRIBUTOR_SUSPENDED":
      return { status: 403, error: "This account is suspended from contributing." };
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

  // Light checks that save a round trip; the API is the authority.
  const content = String(form.get("content") ?? "").trim();
  if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
    return NextResponse.json(
      { error: `The written account must run between ${CONTENT_MIN} and ${CONTENT_MAX.toLocaleString()} characters.` },
      { status: 400 }
    );
  }
  const direction = String(form.get("direction") ?? "");
  if (direction !== "proof" && direction !== "disproof") {
    return NextResponse.json({ error: "Say whether this is a proof or a disproof." }, { status: 400 });
  }
  if (!String(form.get("formalization_id") ?? "").trim()) {
    return NextResponse.json({ error: "The statement version is missing; reload the page." }, { status: 400 });
  }
  const leanFile = form.get("lean_file");
  const leanSource = String(form.get("lean_source") ?? "");
  const hasFile = leanFile instanceof File && leanFile.size > 0;
  if (!hasFile && !leanSource.trim()) {
    return NextResponse.json({ error: "Attach the Lean file or paste the Lean source." }, { status: 400 });
  }
  if (hasFile && (leanFile as File).size > LEAN_MAX_BYTES) {
    return NextResponse.json({ error: "The Lean file must be at most 256 KiB." }, { status: 400 });
  }
  if (!hasFile) form.delete("lean_file");
  const docs = form.getAll("documents").filter((f): f is File => f instanceof File && f.size > 0);
  form.delete("documents");
  for (const d of docs) form.append("documents", d);
  if (docs.length > DOCS_MAX || docs.some((d) => d.size > DOC_MAX_BYTES)
    || docs.reduce((s, d) => s + d.size, 0) > DOCS_TOTAL_BYTES) {
    return NextResponse.json(
      { error: "At most five documents, 10 MiB each and 25 MiB in all." },
      { status: 400 }
    );
  }
  for (const k of ["declare_eligible", "declare_understands", "declare_cc0", "declare_rules"]) {
    if (form.get(k) !== "on") {
      return NextResponse.json({ error: "Each declaration must be made." }, { status: 400 });
    }
  }
  // The form's presentational fields are not part of the API's contract.
  form.delete("lean_mode");
  if (session.user?.name && !form.get("contributor_display_name")) {
    form.set("contributor_display_name", session.user.name);
  }

  try {
    const result = await submitPrizeClaim(session.externalId, id, form);
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
