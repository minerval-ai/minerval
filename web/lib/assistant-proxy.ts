import "server-only";
import { NextResponse } from "next/server";
import { auth } from "../auth";
import { accountApiConfigured, AccountApiError } from "./account-api";

// The browser's calls to the Assistant go through the web tier, which acts
// for the signed-in user. Every handler does the same three things around
// its one API call, so they share this.
export async function asUser<T>(
  call: (externalId: string) => Promise<T>,
  status = 200
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.externalId) {
    return NextResponse.json(
      { error: "Sign in to use the Assistant.", code: "SIGN_IN" },
      { status: 401 }
    );
  }
  if (!accountApiConfigured()) {
    return NextResponse.json(
      { error: "This deployment is not connected to a Minerval API." },
      { status: 503 }
    );
  }
  try {
    return NextResponse.json(await call(session.externalId), { status });
  } catch (err) {
    if (err instanceof AccountApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error("[minerval] assistant request failed:", err);
    return NextResponse.json(
      { error: "The Assistant could not be reached. Please try again." },
      { status: 502 }
    );
  }
}

export async function jsonBody<T>(request: Request): Promise<Partial<T>> {
  return (await request.json().catch(() => ({}))) as Partial<T>;
}
