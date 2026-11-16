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
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { auth } from "./auth";
import { fetchMyPermissions } from "./lib/account-api";
import { GATE_PATH, GATE_REFUSAL, gateDecision, wantsPage } from "./lib/gate";

// The gate page is this app's own, so the request is rewritten to it at the
// address the app itself was asked at (`ownUrl`), which is not always the
// address in `request.url` below: where the site's public address is set
// (AUTH_URL), Auth.js hands the handler a request rewritten to that
// address, and a rewrite to it is a request out to the public address. In
// a container that address is another port or another host, which the app
// cannot reach from inside, and every page then failed.
const gate = (ownUrl: string) =>
  auth(async (request) => {
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
        return NextResponse.rewrite(new URL(GATE_PATH, ownUrl));
      case "refuse":
        return NextResponse.json(GATE_REFUSAL, { status: 401 });
    }
  });

export function proxy(request: NextRequest, event: NextFetchEvent) {
  return (gate(request.url) as unknown as (request: NextRequest, event: NextFetchEvent) => Promise<Response>)(request, event);
}

// Every request but the ones signing in needs before there is a session
// (the sign-in handlers, and the stylesheet, scripts and icons of the gate
// page itself). The matcher has to be written out: Next reads it when it
// builds.
//
// One more path is left out: a file uploaded into a file set
// (app/api/file-sets/[id]/files/[...path]/route.members.ts). A proxy is
// handed a request's body whole, and holds at most ten megabytes of it, so a
// larger file would arrive cut short. That route serves nothing: it takes a
// file from the person in the server's own session and hands it to the API
// as a stream, and the API refuses anyone who is not a member holding the
// permission to direct.
export const config = {
  matcher: ["/((?!api/auth/|api/file-sets/[^/]+/files/|_next/static/|_next/image|icon\\.svg$|apple-icon$).*)"],
};
