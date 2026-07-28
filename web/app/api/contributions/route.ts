import { NextRequest, NextResponse } from "next/server";
import { auth } from "../../../auth";
import {
  accountApiConfigured,
  submitContribution,
  AccountApiError,
} from "../../../lib/account-api";

// Contribution submission (#174): the browser posts here; the handler holds the
// session, and the service key + x-acting-user forwarding stays server-side.
// The API's contributor gate (#71/#157) answers in its own terms; this route
// translates each outcome into a sentence a reader can act on.

export const runtime = "nodejs";

const CONTRIBUTION_TYPES = new Set([
  "challenge",
  "support",
  "propose_edit",
  "add_instance",
  "propose_argument",
  "propose_merge",
  "propose_split",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    case "NOT_FOUND":
      return { status: 404, error: "This claim no longer exists." };
    default:
      return {
        status: err.status >= 500 ? 502 : err.status,
        error: "The contribution could not be submitted. Please try again later.",
      };
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Contributing requires signing in.", code: "SIGN_IN" },
      { status: 401 },
    );
  }

  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 },
    );
  }

  let body: {
    claim_id?: string;
    contribution_type?: string;
    content?: string;
    evidence_urls?: unknown;
    merge_target_claim_id?: string;
    proposed_canonical_form?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const claimId = (body.claim_id ?? "").trim();
  const type = (body.contribution_type ?? "").trim();
  const content = (body.content ?? "").trim();
  if (!UUID_RE.test(claimId) && !claimId.match(/^[a-z0-9-]{1,60}$/)) {
    return NextResponse.json({ error: "Invalid claim id." }, { status: 400 });
  }
  if (!CONTRIBUTION_TYPES.has(type)) {
    return NextResponse.json(
      { error: "Unknown contribution type." },
      { status: 400 },
    );
  }
  if (!content || content.length > 10000) {
    return NextResponse.json(
      { error: "Please write the contribution (up to 10,000 characters)." },
      { status: 400 },
    );
  }
  const evidenceUrls = Array.isArray(body.evidence_urls)
    ? body.evidence_urls
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];
  for (const u of evidenceUrls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw 0;
    } catch {
      return NextResponse.json(
        { error: `Evidence links must be full web addresses; "${u}" is not.` },
        { status: 400 },
      );
    }
  }
  const mergeTarget = (body.merge_target_claim_id ?? "").trim();
  if (type === "propose_merge" && !UUID_RE.test(mergeTarget)) {
    return NextResponse.json(
      { error: "A merge proposal needs the id of the claim it duplicates." },
      { status: 400 },
    );
  }

  try {
    const contribution = await submitContribution(session.externalId, {
      claimId,
      contributionType: type,
      content,
      evidenceUrls,
      ...(type === "propose_merge" ? { mergeTargetClaimId: mergeTarget } : {}),
      ...(body.proposed_canonical_form?.trim()
        ? { proposedCanonicalForm: body.proposed_canonical_form.trim().slice(0, 2000) }
        : {}),
      displayName: session.user?.name ?? undefined,
    });
    return NextResponse.json({ contribution }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountApiError) {
      const { status, error } = friendlyError(err);
      return NextResponse.json({ error, code: err.code }, { status });
    }
    console.error("[minerval] contribution submit failed:", err);
    return NextResponse.json(
      { error: "The contribution could not be submitted. Please try again later." },
      { status: 502 },
    );
  }
}
