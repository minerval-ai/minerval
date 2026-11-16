import type { ReactNode } from "react";
import { signOut } from "../auth";
import { membersOnly } from "../lib/members";
import { loadStanding } from "../lib/standing";
import { MembersBand } from "./MembersBand";
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
//   - a member: the page, under a line of links to the pages their
//     permissions open in this deployment (components/MembersBand.tsx).
//
// The API is what refuses a read (it serves nothing to anyone who is not a
// signed-in member); this is what tells a person why they see nothing and
// what to do about it. It reads the session, which is also what makes every
// page under it rendered for its reader and never ahead of time.
//
// It does not keep a page from being rendered: Next renders a page's content
// whatever its layout shows. The proxy of a members-only build does that
// (proxy.members.ts), by answering anyone who is not a member with a page
// that has nothing in it, which this gate then stands in for.
export function MembersGate({ children }: { children: ReactNode }) {
  if (!membersOnly()) return <>{children}</>;
  return <Gate>{children}</Gate>;
}

async function Gate({ children }: { children: ReactNode }) {
  const standing = await loadStanding();
  if (standing.state === "open") return <>{children}</>;
  if (standing.state === "anonymous") {
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
  if (standing.state === "unavailable") {
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
  const { mine } = standing;
  if (mine.member) {
    return (
      <>
        <MembersBand mine={mine} />
        {children}
      </>
    );
  }

  const identity = mine.account.external_id ?? standing.externalId;
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
