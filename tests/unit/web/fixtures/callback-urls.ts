// Shared cases for the /signin callbackUrl check (F45). Values are what the
// page receives after Next decodes the query string.

export const ORIGIN = "https://minerval.example";

const fromQuery = (qs: string): string => {
  const v = new URLSearchParams(qs).get("callbackUrl");
  if (v === null) throw new Error(`no callbackUrl in ${qs}`);
  return v;
};

/**
 * Values the old "starts with / and not //" check let through but a browser
 * resolves off-site (backslash read as slash; tab/CR/LF dropped).
 */
export const OFF_SITE_BYPASSES: Array<[label: string, value: string]> = [
  ["finding payload /%5Cevil.example/login", fromQuery("callbackUrl=/%5Cevil.example/login")],
  ["literal backslash", "/\\evil.example"],
  ["double backslash", fromQuery("callbackUrl=/%5C%5Cevil.example")],
  ["backslash then slash", "/\\/evil.example"],
  ["tab between slashes", fromQuery("callbackUrl=/%09/evil.example")],
  ["LF between slashes", fromQuery("callbackUrl=/%0A/evil.example")],
  ["CR between slashes", fromQuery("callbackUrl=/%0D/evil.example")],
  ["CRLF between slashes", "/\r\n/evil.example"],
  ["tab then backslash", "/\t\\evil.example"],
  ["backslash then tab", "/\\\tevil.example"],
];

/** Values rejected before and after the fix; they must keep falling back. */
export const ALWAYS_REJECTED: Array<[label: string, value: string]> = [
  ["protocol-relative", "//evil.example"],
  ["absolute off-site", "https://evil.example/login"],
  ["absolute same-site (NextAuth's own form)", `${ORIGIN}/claims`],
  ["javascript scheme", "javascript:alert(1)"],
  ["relative without leading slash", "evil.example"],
  ["empty", ""],
  ["leading tab", "\t//evil.example"],
];

/**
 * Same-site values carrying control characters. The old check passed them
 * through unchanged and so must the new one: tab/CR/LF are dropped by the
 * browser and other C0/DEL are percent-encoded into the path, so none of
 * these can reach another host.
 */
export const SAME_SITE_CONTROL_CHAR_PATHS: Array<[label: string, value: string]> = [
  ["/claims%09 (trailing tab)", fromQuery("callbackUrl=/claims%09")],
  ["embedded LF", "/claims\nx"],
  ["trailing CR", "/claims\r"],
  ["NUL", "/claims\u0000"],
  ["DEL", "/claims\u007f"],
  ["SOH before a slash", "/\u0001/evil.example"],
  ["US before a backslash", "/\u001f\\evil.example"],
];

const CLAIM = "11111111-2222-3333-4444-555555555555";
const REQUEST = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/**
 * Every callbackUrl the app itself builds, as the inner path before it is
 * wrapped in `/signin?callbackUrl=${encodeURIComponent(path)}`.
 */
export const HONEST_PATHS: Array<[source: string, path: string]> = [
  ["signin default", "/account"],
  ["ProposeClaim (server render)", "/claims"],
  ["ProposeClaim (client)", "/claims?propose="],
  ["Contribute (server render)", `/claims/${CLAIM}`],
  ...(
    [
      "challenge",
      "support",
      "propose_edit",
      "add_instance",
      "propose_argument",
      "propose_merge",
      "propose_split",
    ] as const
  ).map((t): [string, string] => [`Contribute (client, ${t})`, `/claims/${CLAIM}?contribute=${t}`]),
  ["PrizeClaimForm", `/claims/${CLAIM}/prize/claim`],
  ["OAuth consent page", `/oauth/consent?request_id=${REQUEST}`],
];

/** Round-trip an inner path through the signin link the app renders. */
export function viaSigninLink(path: string): string {
  const href = `/signin?callbackUrl=${encodeURIComponent(path)}`;
  return new URL(href, ORIGIN).searchParams.get("callbackUrl") ?? "";
}
