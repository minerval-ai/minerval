import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { PageHead } from "@/components/PageHead";
import { NeedsPermission } from "@/components/admin/access";
import { fetchAccount } from "@/lib/account-api";
import { owls } from "@/lib/account-format";
import { fetchMyLabels } from "@/lib/admin-api";
import { holds, loadStanding } from "@/lib/standing";
import { AddSourceForm } from "./AddSourceForm";

export const metadata: Metadata = { title: "Add a source · Minerval" };
export const dynamic = "force-dynamic";

// Adding a document or an address by hand (POST /sources): one of the ways
// material comes into a graph, beside a connection to a system.
//
// The page is written for both kinds of deployment and ships in one. Its
// file name ends .members.tsx, so only a members-only build has it
// (next.config.mjs). There it is for whoever holds the permission to direct.
// The public site's version is the same page for anyone signed in, without
// the paragraph on who can read what is added: everything there is public.
// Turning it on there means renaming this file to page.tsx, adding the route
// to the page table in plugin/skills/using-minerval/SKILL.md, and linking to
// it from the site.

export default async function AddSourcePage() {
  const standing = await loadStanding();
  let externalId: string;
  if (standing.state === "open") {
    const session = await auth();
    if (!session?.externalId) redirect("/signin?callbackUrl=/sources/new");
    externalId = session.externalId;
  } else if (standing.state === "signed_in" && standing.mine.member) {
    if (!holds(standing, "direct")) return <NeedsPermission title="Add a source" permission="direct" />;
    externalId = standing.externalId;
  } else {
    // The gate is already standing in for this page.
    return null;
  }
  const privateDeployment = standing.state !== "open";

  const account = await fetchAccount(externalId).catch(() => null);
  // The labels the person may file the source at, where the deployment holds more than one.
  const labels = privateDeployment ? await fetchMyLabels(externalId).catch(() => null) : null;
  const cap = account?.entitlement.caps_owls?.source_ingest;
  const balance = account?.entitlement.owl_balance;
  const createdHere = account?.entitlement.owls_created_here === true;

  return (
    <div className="admin-page">
      <PageHead
        title="Add a source"
        lede="A source is whatever an agent read, fixed when it was read. Give a document's address here, and the graph's agents read it for the claims, figures and questions it holds."
      />
      <div className="acct-cols">
        <div className="acct-main">
          <AddSourceForm labels={labels} />
        </div>
        <aside className="acct-side acct-side-wide">
          <h3>What happens to it</h3>
          <p className="acct-prose">
            A submitted source is reviewed like any contribution, and nothing is read from it
            until it is admitted. Then the Extractor reads it for what the graph should hold, and
            each thing it finds is matched against what the graph already has before anything new
            is made. The source keeps its own page, with what was read from it.
          </p>
          <h3 className="acct-gap">What it costs</h3>
          <p className="acct-prose">
            Reading a source is paid work.{" "}
            {typeof cap === "number" ? (
              <>
                A ceiling of {owls(cap)} {cap === 1 ? "owl" : "owls"} is held from your balance when
                you submit
              </>
            ) : (
              <>A ceiling is held from your balance when you submit</>
            )}
            ; the cost is metered as the work runs and the unused part returns. If the source is
            not admitted, what was held is returned in full.
            {typeof balance === "number" && (
              <>
                {" "}
                Your balance is {owls(balance)} {balance === 1 ? "owl" : "owls"}.
              </>
            )}
            {createdHere && typeof balance === "number" && typeof cap === "number" && balance < cap && (
              <> Owls here are created by this deployment&rsquo;s administrators: ask one to add to your balance.</>
            )}
          </p>
          {privateDeployment && (
            <>
              <h3 className="acct-gap">Who can read it</h3>
              {labels?.must_choose ? (
                <p className="acct-prose">
                  That follows the label you choose for it. The form lists, for each label you may
                  choose, who reads material filed there and who may open the source itself. Its
                  text is sent to the model providers and outside services this deployment has
                  cleared for that label, and to no other.
                </p>
              ) : (
                <p className="acct-prose">
                  This deployment holds everything at one label, so every member can read a source
                  added here, and its text can be sent to every model provider and outside service
                  the deployment uses.
                </p>
              )}
              <p className="acct-prose">
                It is recorded as no party&rsquo;s material until an administrator says whose it
                is. A system where the organisation&rsquo;s data lives is not added here: an
                administrator connects it
                {holds(standing, "administer") ? (
                  <>
                    {" "}
                    on <Link href="/admin/connections">Connections</Link>
                  </>
                ) : null}
                , and agents read it where it is.
              </p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
