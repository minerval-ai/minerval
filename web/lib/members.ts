// Whether this deployment is members-only, as the web app knows it.
//
// One setting, READS, says who a deployment serves, and the API holds the
// rule (src/permissions.ts in the API): at "members" it serves nothing to
// anyone who is not signed in. The web app reads the same variable so that
// it can do its part: say who is reading on every read, keep no copy of a
// read to hand to the next reader, show no design fixtures, and ask a
// visitor to sign in before showing anything.
//
// The variable is read where the web app runs. It must also be set when the
// web app is built: a page built without it may be prerendered and served
// without this code running at all. instrumentation.ts stops a members-only
// deployment from serving anything on a build that was not made for one.
//
// Unset, or any other value, is the public graph, which this file changes
// nothing about.

export function membersOnly(): boolean {
  return process.env.READS === "members";
}

// How long a sign-in lasts in a members-only deployment, in seconds. The
// API counts a person's groups for the same length of time after a sign-in
// (SIGN_IN_VALID_HOURS there, the same variable), because a sign-in is the
// only thing that tells it which groups a person is in. Ending the session
// at that age sends a person back through the identity provider before
// their groups lapse.
export function signInValidSeconds(): number {
  const hours = Number(process.env.SIGN_IN_VALID_HOURS);
  return Math.round((Number.isFinite(hours) && hours > 0 ? hours : 12) * 3600);
}

// The group names in a sign-in's claims (auth.ts passes them to the API
// when it provisions the account). Providers put them in a claim named
// "groups" unless told otherwise (AUTH_OIDC_GROUPS_CLAIM), as a list of
// names, or as one name where a person is in one group. Anything else is no
// groups. Names are passed as the provider wrote them, each once.
export function groupsFromClaims(claims: Record<string, unknown> | null | undefined): string[] {
  const claim = process.env.AUTH_OIDC_GROUPS_CLAIM?.trim() || "groups";
  const value = claims?.[claim];
  const names = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [
    ...new Set(
      names
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  ];
}
