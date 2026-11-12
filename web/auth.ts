/**
 * Auth.js (next-auth v5) configuration — the human sign-in half of issue #70.
 *
 * Design: the web app owns the session; the API stays provider-agnostic. We
 * use OAuth providers only (GitHub, Google — enabled by env), so we never
 * store credentials. On sign-in we derive a stable external subject
 * "<provider>:<providerAccountId>", provision the account on the API
 * (contributors.externalId), and carry the subject in the JWT session. Every
 * dashboard call to the API is made server-side with the service key plus
 * x-acting-user: <externalId>.
 *
 * Swapping to a hosted provider (Clerk/WorkOS/...) later only replaces this
 * file and the /signin page — the API contract (externalId + provision) is
 * unchanged.
 *
 * Single sign-on. An organization's own identity provider is one more
 * provider here, any that speaks OpenID Connect, set by AUTH_OIDC_ISSUER,
 * AUTH_OIDC_ID and AUTH_OIDC_SECRET. The API still never talks to a
 * provider: the subject becomes "oidc:<sub>", and the group names the
 * provider put in the sign-in's ID token are passed along when the account
 * is provisioned, so that a members-only deployment can grant a permission
 * to a group (lib/members.ts).
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { provisionUser } from "./lib/account-api";
import { groupsFromClaims, membersOnly, signInValidSeconds } from "./lib/members";

const isProduction = process.env.NODE_ENV === "production";

export function githubEnabled(): boolean {
  return Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
}
export function googleEnabled(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}
/**
 * Sign-in through an organization's identity provider (OpenID Connect).
 * The issuer and client id are settings; the client secret is an
 * environment variable and belongs in no file.
 */
export function oidcEnabled(): boolean {
  return Boolean(
    process.env.AUTH_OIDC_ISSUER && process.env.AUTH_OIDC_ID && process.env.AUTH_OIDC_SECRET
  );
}
/** What the sign-in button calls the provider. */
export function oidcName(): string {
  return process.env.AUTH_OIDC_NAME?.trim() || "single sign-on";
}

/**
 * Local-development sign-in with just a username — NEVER available in
 * production builds, regardless of env vars. On by default in dev when no
 * OAuth provider is configured (zero-config local dashboard), or explicitly
 * via AUTH_DEV_LOGIN=true.
 */
export function devLoginEnabled(): boolean {
  if (isProduction) return false;
  if (process.env.AUTH_DEV_LOGIN === "true") return true;
  if (process.env.AUTH_DEV_LOGIN === "false") return false;
  return !githubEnabled() && !googleEnabled() && !oidcEnabled();
}

const providers: Provider[] = [];
if (githubEnabled()) providers.push(GitHub);
if (googleEnabled()) providers.push(Google);
if (oidcEnabled()) {
  providers.push({
    id: "oidc",
    name: oidcName(),
    type: "oidc",
    issuer: process.env.AUTH_OIDC_ISSUER,
    clientId: process.env.AUTH_OIDC_ID,
    clientSecret: process.env.AUTH_OIDC_SECRET,
    // The scopes every provider has. One that sends groups only when asked
    // by scope (Okta's "groups", say) is asked by setting AUTH_OIDC_SCOPE.
    authorization: {
      params: { scope: process.env.AUTH_OIDC_SCOPE?.trim() || "openid profile email" },
    },
    checks: ["pkce", "state", "nonce"],
    profile(claims: Record<string, unknown>) {
      const text = (name: string) =>
        typeof claims[name] === "string" && claims[name] ? (claims[name] as string) : null;
      return {
        id: String(claims.sub),
        name: text("name") ?? text("preferred_username") ?? text("email") ?? String(claims.sub),
        email: text("email"),
        image: text("picture"),
      };
    },
  });
}
if (devLoginEnabled()) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Development login",
      credentials: {
        username: { label: "Username", type: "text" },
      },
      authorize(credentials) {
        const username = String(credentials?.username ?? "").trim();
        if (!/^[a-z0-9_-]{1,40}$/i.test(username)) return null;
        return {
          id: username,
          name: username,
          email: `${username}@dev.local`,
        };
      },
    })
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  pages: { signIn: "/signin" },
  // In a members-only deployment a sign-in ends at a fixed age, however
  // much the session is used (the jwt callback below), so the cookie need
  // not outlive it either. Elsewhere the session is as it always was.
  session: membersOnly()
    ? { strategy: "jwt", maxAge: signInValidSeconds() }
    : { strategy: "jwt" },
  trustHost: true,
  secret:
    process.env.AUTH_SECRET ??
    (isProduction ? undefined : "minerval-dev-secret-not-for-production"),
  callbacks: {
    async jwt({ token, account, user, profile }) {
      // First sign-in: derive the stable subject and provision the account
      // on the API so the acting-user header resolves from the first request.
      if (account && user) {
        const externalId = `${account.provider}:${account.providerAccountId}`;
        token.externalId = externalId;
        token.signedInAt = Date.now();
        try {
          await provisionUser({
            externalId,
            displayName: user.name ?? externalId,
            email: user.email ?? null,
            avatarUrl: user.image ?? null,
            // The identity provider's groups, from this sign-in's claims. Sent
            // for a single sign-on only, and then always, so that a person
            // who has left every group is recorded as in none.
            ...(account.provider === "oidc"
              ? { groups: groupsFromClaims(profile as Record<string, unknown> | undefined) }
              : {}),
          });
        } catch (err) {
          // Keep the session; the dashboard surfaces provisioning problems.
          console.error("[auth] account provisioning failed:", err);
        }
        return token;
      }
      // A members-only deployment ends a session at a fixed age after the
      // sign-in, so the person signs in again and the API hears what groups
      // they are in now (lib/members.ts). A session that is only ever
      // renewed would carry the groups of its first day for as long as it
      // was used.
      if (membersOnly()) {
        const signedInAt = typeof token.signedInAt === "number" ? token.signedInAt : 0;
        if (Date.now() - signedInAt > signInValidSeconds() * 1000) return null;
      }
      return token;
    },
    async session({ session, token }) {
      session.externalId = (token.externalId as string | undefined) ?? null;
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    /** Stable subject "<provider>:<id>" — the API's contributors.externalId. */
    externalId?: string | null;
  }
}
