import type { ReactNode } from "react";
import { auth, signOut } from "../auth";
import { fetchMyPermissions } from "../lib/account-api";
import { membersOnly } from "../lib/members";
import { PageHead } from "./PageHead";
import { signInOptions } from "./sign-in-options";

// The gate of a members-only deployment (lib/members.ts), placed round every
// page by the root layout.
//
// On the public graph it is the page and nothing else: it does not look at
// the session, so a page that could be served from a cache still can be.
//
// In a members-only deployment it stands in for the page until the visitor
// may see it:
//   - not signed in: the sign-in buttons, and afterwards the page asked for;
//   - signed in with no permission: who they are signed in as, the identity
//     an administrator will know them by, and that there is nothing to show
//     until one grants them something;
//   - a member: the page.
//
// The API is what refuses a read (it serves nothing to anyone who is not a
// signed-in member); this is what tells a person why they see nothing and
// what to do about it. It reads the session, which is also what makes every
// page under it rendered for its reader and never ahead of time.
export function MembersGate({ children }: { children: ReactNode }) {
  if (!membersOnly()) return <>{children}</>;
  return <Gate>{children}</Gate>;
}

async function Gate({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.externalId) {
    return (
      <div className="col">
        <PageHead
          title="Sign in"
          lede="This is a private deployment of Minerval. Nothing in it is shown to anyone who is not signed in."
        />
        {signInOptions({})}
      </div>
    );
  }

  let mine;
  try {
    mine = await fetchMyPermissions(session.externalId);
  } catch (err) {
    console.error("[minerval] could not read the signed-in account's permissions:", err);
    return (
      <div className="col">
        <PageHead
          title="Not available"
          lede="This deployment could not check what you may see, so it is showing nothing. Try again in a moment."
        />
        {signOutForm()}
      </div>
    );
  }
  if (mine.member) return <>{children}</>;

  const identity = mine.account.external_id ?? session.externalId;
  return (
    <div className="col">
      <PageHead
        title="No access yet"
        lede={
          <>
            You are signed in{mine.account.display_name ? <> as {mine.account.display_name}</> : null},
            and hold no permission in this deployment, so there is nothing to show you yet. An
            administrator of the deployment grants permissions.
          </>
        }
      />
      <p>
        An administrator will know you by this sign-in identity: <code>{identity}</code>
      </p>
      <p className="signin-note">
        If you are setting this deployment up, put that identity in its{" "}
        <code>FIRST_ADMINISTRATOR</code> setting and sign in again. The setting works once, for
        the deployment&rsquo;s first administrator.
      </p>
      {signOutForm()}
    </div>
  );
}

function signOutForm() {
  return (
    <form
      className="signin-options"
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      <button className="signin-button" type="submit">
        Sign out
      </button>
    </form>
  );
}
