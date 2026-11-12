// The gate of a members-only build (lib/gate.ts says what it decides).
//
// This file is the app's proxy only in a build made with READS=members
// (next.config.mjs, pageExtensions). A build for the public graph does not
// contain it, so nothing runs in front of the public site's requests.
//
// It runs before a page or a route handler is chosen. That is why it exists:
// a layout cannot turn a visitor away, because Next renders a page's content
// whatever the layout around it decides to show, and a reader moving between
// pages fetches a page's content without its layout being asked again. So
// the gate in the root layout (components/MembersGate.tsx) tells a visitor
// why they see nothing, and this is what keeps the page they asked for from
// being rendered at all.
import { NextResponse } from "next/server";
import { auth } from "./auth";
import { fetchMyPermissions } from "./lib/account-api";
import { GATE_PATH, GATE_REFUSAL, gateDecision, wantsPage } from "./lib/gate";

export const proxy = auth(async (request) => {
  const externalId = request.auth?.externalId ?? null;
  let member = false;
  if (externalId) {
    try {
      member = (await fetchMyPermissions(externalId)).member;
    } catch (err) {
      // What could not be checked is not let through. The gate page says so.
      console.error("[minerval] the gate could not read the signed-in account's permissions:", err);
    }
  }
  switch (gateDecision({ member, wantsPage: wantsPage(request.headers) })) {
    case "through":
      return NextResponse.next();
    case "gate_page":
      return NextResponse.rewrite(new URL(GATE_PATH, request.url));
    case "refuse":
      return NextResponse.json(GATE_REFUSAL, { status: 401 });
  }
});

// Every request but the ones signing in needs before there is a session
// (the sign-in handlers, and the stylesheet, scripts and icons of the gate
// page itself). The matcher has to be written out: Next reads it when it
// builds.
export const config = {
  matcher: ["/((?!api/auth/|_next/static/|_next/image|icon\\.svg$|apple-icon$).*)"],
};
