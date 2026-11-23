import type { ReactNode } from "react";
import { signOut } from "../auth";
import { membersOnly } from "../lib/members";
import { loadStanding } from "../lib/standing";
import { Mark } from "../app/Mark";
import { CopyId } from "./work/CopyId";
import { WorkShell } from "./work/Shell";
import { PageHead } from "./PageHead";
import { signInOptions } from "./sign-in-options";
import { WorkForm } from "./work/WorkForm";
import { firstAdministratorAction } from "../app/admin/settings/actions";

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
//   - a member: the page, in the workspace's shell, with a sidebar of the
//     pages their permissions open (components/work/Shell.tsx).
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
      <GateCard>
        <PageHead
          tool
          title="Sign in"
          lede="This is a private deployment of Minerval."
        />
        {signInOptions({})}
      </GateCard>
    );
  }
  if (standing.state === "unavailable") {
    return (
      <GateCard>
        <PageHead
          tool
          title="Not available"
          lede="This deployment could not check what you may see, so it is showing nothing. Try again in a moment."
        />
        {signOutForm()}
      </GateCard>
    );
  }
  const { mine } = standing;
  if (mine.member) return <WorkShell mine={mine}>{children}</WorkShell>;

  const identity = mine.account.external_id ?? standing.externalId;
  return (
    <GateCard>
      <PageHead
        tool
        title="No access yet"
        lede={
          <>
            You are signed in{mine.account.display_name ? <> as {mine.account.display_name}</> : null},
            and hold no permission in this deployment. An administrator grants access: send them this ID.
          </>
        }
      />
      <CopyId value={identity} />
      {mine.awaiting_first_administrator ? (
        <>
          <p className="w-help">
            Setting this deployment up? It has no administrator yet. When its API started it printed a code in its
            log, on a line that begins &ldquo;The first person to sign in&rdquo;. Give the code here and you are its
            first administrator. It works once, and for a day; starting the API again prints a new one.
          </p>
          <WorkForm action={firstAdministratorAction} submit="Become the first administrator" primary>
            <div className="w-field">
              <label htmlFor="first-administrator-code">The code</label>
              <input
                id="first-administrator-code"
                className="w-input"
                name="code"
                required
                maxLength={64}
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX"
              />
            </div>
          </WorkForm>
        </>
      ) : (
        <p className="w-help">
          Setting this deployment up? Whoever runs it starts its API, which prints a one-time code for the first
          administrator in its log; or they put that ID in its <code>FIRST_ADMINISTRATOR</code> setting. Either works
          once, for the first administrator.
        </p>
      )}
      {signOutForm()}
    </GateCard>
  );
}

// The sign-in screens stand alone, centred, with nothing of the deployment behind them.
function GateCard({ children }: { children: ReactNode }) {
  return (
    <div className="w-gate">
      <div className="w-gate-card">
        <div className="w-brand">
          <Mark size={20} />
          <span className="w-brand-name">Minerval</span>
          <span className="w-pill w-neu">Private</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function signOutForm() {
  return (
    <form
      className="w-form"
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      <button className="w-btn" type="submit">
        Sign out
      </button>
    </form>
  );
}
