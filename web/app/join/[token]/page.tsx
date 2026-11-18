import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { AccountApiError } from "../../../lib/account-api";
import { readInvitation, type InvitationRead } from "../../../lib/organizations-api";
import { Banner, Card, Kv, WorkHead, WorkPage, shortDay } from "../../../components/work/ui";
import { WorkForm } from "../../../components/work/WorkForm";
import { acceptInvitationAction } from "../../account/organizations/actions";

export const metadata: Metadata = { title: "Join an organization · Minerval", robots: { index: false } };
export const dynamic = "force-dynamic";

// An invitation link (docs/organizations.md, "Members and admins"). The
// person opens it signed in as themselves, sees what it is for, and accepts.
// It is used once.

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await auth();
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);

  let invitation: InvitationRead | null = null;
  let problem: string | null = null;
  try {
    invitation = await readInvitation(session.externalId, token);
  } catch (err) {
    problem = err instanceof AccountApiError ? err.message : "This invitation could not be read.";
  }

  return (
    <WorkPage>
      <WorkHead title={invitation ? `Join ${invitation.organization.name}` : "Join an organization"} sub="An invitation" />
      {problem && <Banner tone="bad">{problem}</Banner>}
      {invitation && (
        <Card>
          <Kv
            rows={[
              ["Organization", invitation.organization.name],
              ["As", invitation.role === "admin" ? "Admin: changes members, buys and spends owls for it" : "Member: sees it, its members and its log"],
              ["Open until", shortDay(invitation.expires_at)],
            ]}
          />
          {invitation.state === "open" ? (
            <div style={{ marginTop: 14 }}>
              <WorkForm action={acceptInvitationAction} submit={`Join as ${session.user?.name ?? "yourself"}`} primary>
                <input type="hidden" name="token" value={token} />
              </WorkForm>
            </div>
          ) : (
            <Banner tone="warn">
              {invitation.state === "accepted"
                ? "This invitation has already been used."
                : invitation.state === "cancelled"
                  ? "An admin cancelled this invitation."
                  : "This invitation has expired. Ask an admin for a new one."}
            </Banner>
          )}
        </Card>
      )}
      <p className="w-muted">
        <Link href="/account/organizations">Your organizations</Link>
      </p>
    </WorkPage>
  );
}
