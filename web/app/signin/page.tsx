import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  auth,
  signIn,
  githubEnabled,
  googleEnabled,
  devLoginEnabled,
} from "../../auth";

export const metadata: Metadata = { title: "Sign in · Minerval" };

// One account for everything: consuming the API and contributing to the
// graph. Sessions are cookie-based; OAuth providers hold the credentials.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  // Same-site relative paths only — never an open redirect.
  const redirectTo =
    callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : "/account";

  const session = await auth();
  if (session?.externalId) redirect(redirectTo);

  const anyOauth = githubEnabled() || googleEnabled();
  const devLogin = devLoginEnabled();

  return (
    <div className="col">
      <p className="claim-eyebrow">account</p>
      <h1>Sign in</h1>
      <p>
        One account serves both roles: <em>consumer</em> (API keys, usage,
        the coming browser extension) and <em>contributor</em> (challenges,
        evidence, reputation). Reading the graph never requires an account.
      </p>

      <div className="signin-options">
        {githubEnabled() && (
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo });
            }}
          >
            <button className="signin-button" type="submit">
              Continue with GitHub
            </button>
          </form>
        )}
        {googleEnabled() && (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo });
            }}
          >
            <button className="signin-button" type="submit">
              Continue with Google
            </button>
          </form>
        )}
        {devLogin && (
          <form
            className="signin-dev"
            action={async (formData: FormData) => {
              "use server";
              await signIn("dev", {
                username: formData.get("username"),
                redirectTo,
              });
            }}
          >
            <label className="sc" htmlFor="dev-username">
              development login
            </label>
            <div className="signin-dev-row">
              <input
                id="dev-username"
                name="username"
                placeholder="username"
                autoComplete="off"
                required
                pattern="[A-Za-z0-9_\-]{1,40}"
              />
              <button className="signin-button" type="submit">
                Sign in
              </button>
            </div>
            <p className="signin-note">
              Local development only; never available in production.
            </p>
          </form>
        )}
        {!anyOauth && !devLogin && (
          <p className="signin-note">
            No sign-in providers are configured. Set{" "}
            <code>AUTH_GITHUB_ID</code>/<code>AUTH_GITHUB_SECRET</code> (or the
            Google equivalents) in the frontend environment.
          </p>
        )}
      </div>
    </div>
  );
}
