import {
  signIn,
  githubEnabled,
  googleEnabled,
  devLoginEnabled,
  oidcEnabled,
  oidcName,
} from "../auth";

// The sign-in buttons, one for each provider this deployment has set up.
// Called as a function, not rendered as a component: the /signin page and
// the members-only gate (components/MembersGate.tsx) both place the same
// block, and each form's action is then part of the page that placed it.
//
// `redirectTo` is where the visitor lands afterwards. Without one they come
// back to the page they were on, which is what the gate wants: it stands in
// for whatever page was asked for.
export function signInOptions({ redirectTo }: { redirectTo?: string }) {
  const options = redirectTo ? { redirectTo } : {};
  const anyProvider = githubEnabled() || googleEnabled() || oidcEnabled();
  const devLogin = devLoginEnabled();

  return (
    <div className="signin-options">
      {oidcEnabled() && (
        <form
          action={async () => {
            "use server";
            await signIn("oidc", options);
          }}
        >
          <button className="signin-button" type="submit">
            Continue with {oidcName()}
          </button>
        </form>
      )}
      {githubEnabled() && (
        <form
          action={async () => {
            "use server";
            await signIn("github", options);
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
            await signIn("google", options);
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
              ...options,
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
      {!anyProvider && !devLogin && (
        <p className="signin-note">
          No sign-in providers are configured. Set{" "}
          <code>AUTH_GITHUB_ID</code>/<code>AUTH_GITHUB_SECRET</code> (or the
          Google equivalents) in the frontend environment.
        </p>
      )}
    </div>
  );
}
