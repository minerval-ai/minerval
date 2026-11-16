// What the gate of a members-only build does with a request
// (proxy.members.ts, which runs in front of every page and route handler of
// such a build and of no other).
//
// A request from a signed-in member goes through. Anything else never
// reaches the page or handler it asked for:
//   - a request for a page (a navigation, or the app's own fetch of a page
//     or a form's action) is answered with the gate page instead, at the
//     address that was asked for, so that after signing in the visitor is
//     where they meant to be;
//   - any other request (a route handler called by a script, an image, a
//     feed) is refused with 401 and no content.
//
// The API is still what refuses a read. This is what keeps the web app from
// rendering a page's frame for someone it will show nothing to.

/** The page that stands in for whatever a visitor who may not see it asked for. */
export const GATE_PATH = "/members-gate";

export type GateDecision = "through" | "gate_page" | "refuse";

export function gateDecision(input: { member: boolean; wantsPage: boolean }): GateDecision {
  if (input.member) return "through";
  return input.wantsPage ? "gate_page" : "refuse";
}

/**
 * Whether a request is for a page: a browser navigating (it accepts HTML),
 * the app fetching a page's content as a reader moves between pages (the
 * `rsc` header), or a form posting to its action (`next-action`).
 */
export function wantsPage(headers: { get(name: string): string | null }): boolean {
  if (headers.get("rsc") !== null || headers.get("next-action") !== null) return true;
  return (headers.get("accept") ?? "").includes("text/html");
}

/** What a refused request that was not for a page is told, in the API's own shape. */
export const GATE_REFUSAL = {
  error: "This is a private deployment of Minerval. Sign in to use it.",
  code: "SIGN_IN_REQUIRED",
} as const;
