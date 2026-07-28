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
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { provisionUser } from "./lib/account-api";

const isProduction = process.env.NODE_ENV === "production";

export function githubEnabled(): boolean {
  return Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
}
export function googleEnabled(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
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
  return !githubEnabled() && !googleEnabled();
}

const providers: Provider[] = [];
if (githubEnabled()) providers.push(GitHub);
if (googleEnabled()) providers.push(Google);
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
  session: { strategy: "jwt" },
  trustHost: true,
  secret:
    process.env.AUTH_SECRET ??
    (isProduction ? undefined : "minerval-dev-secret-not-for-production"),
  callbacks: {
    async jwt({ token, account, user }) {
      // First sign-in: derive the stable subject and provision the account
      // on the API so the acting-user header resolves from the first request.
      if (account && user) {
        const externalId = `${account.provider}:${account.providerAccountId}`;
        token.externalId = externalId;
        try {
          await provisionUser({
            externalId,
            displayName: user.name ?? externalId,
            email: user.email ?? null,
            avatarUrl: user.image ?? null,
          });
        } catch (err) {
          // Keep the session; the dashboard surfaces provisioning problems.
          console.error("[auth] account provisioning failed:", err);
        }
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
