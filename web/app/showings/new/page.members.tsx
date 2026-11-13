import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkNav, day } from "@/components/inside/nav";
import { fetchMyLabels } from "@/lib/admin-api";
import { fetchClaimDetail } from "@/lib/api";
import { fetchOutbound } from "@/lib/inside-api";
import { askShowingAction } from "../actions";

export const metadata: Metadata = { title: "Show a page · Minerval" };
export const dynamic = "force-dynamic";

// Asking for a node's page to be shown to people who do not read the label
// it was written at (POST /showings; docs/showing-a-page.md, "Asking"). The
// form says, beside each choice, what it shows and to whom, and what a
// standing showing undertakes. Nothing is preselected: how a page is shown
// is chosen each time it is asked for.

export default async function AskShowingPage({ searchParams }: { searchParams: Promise<{ node?: string; at?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct")) return <NeedsPermission title="Show a page" permission="direct" />;
  const { node: nodeId, at } = await searchParams;
  const detail = nodeId ? await fetchClaimDetail(nodeId).catch(() => null) : null;
  if (!detail) {
    return (
      <div className="admin-page">
        <PageHead title="Show a page" lede="A showing is asked for from a node's page." />
        <WorkNav who={who} current="/showings/new" />
        <p className="account-empty admin-first">
          Open the node on <Link href="/claims">the list of claims</Link>, choose the assessment made at the label you want shown, and follow
          &ldquo;Ask for this page to be shown&rdquo;.
        </p>
      </div>
    );
  }
  const versions = (detail.versions ?? []).filter((v) => v.label !== "public");
  const [mine, outbound] = await Promise.all([
    fetchMyLabels(who.externalId),
    fetchOutbound(who.externalId).catch(() => null),
  ]);
  const sending = outbound?.how_sending_works ?? {};

  return (
    <div className="admin-page">
      <PageHead
        back={{ href: `/claims/${detail.claim.id}`, label: "the node" }}
        title="Show a page"
        lede="Often the evidence for something is more sensitive than the thing itself. Showing a page lets people who may not read the evidence read what this node's Steward concluded from it: the page as written, with the passages a redaction policy covers removed and marked."
      />
      <WorkNav who={who} current="/showings/new" />

      <section className="acct-section admin-first">
        <div className="acct-head">
          <h2>The node</h2>
        </div>
        <p className="acct-prose acct-measure">
          <Link href={`/claims/${detail.claim.id}`}>{detail.claim.text}</Link>
        </p>
      </section>

      {versions.length === 0 ? (
        <p className="account-empty">
          This node has no assessment that some members cannot read, among the labels you read, so there is nothing to show: everyone who
          can open the node already reads all of it that you do.
        </p>
      ) : (
        <ActionForm action={askShowingAction} submit="Ask for this page to be shown">
          <input type="hidden" name="node_id" value={detail.claim.id} />

          <fieldset className="admin-fieldset inside-choices">
            <legend>Which page</legend>
            {versions.map((v) => (
              <label key={v.id} className="admin-check">
                <input type="radio" name="page_label" value={v.label} required defaultChecked={versions.length === 1 || at === v.label} />
                <span>
                  The page written at <code>{v.label}</code>, whose assessment is of {day(v.assessed_at)}.
                </span>
              </label>
            ))}
            <small className="inside-note">
              What is shown is that page and what was written at its label: the assessment, its arguments and their evaluations, the readings
              of its sources, its subclaims. Something written at another label that this one reads is that label&rsquo;s page, and showing
              it is a separate showing.
            </small>
          </fieldset>

          <fieldset className="admin-fieldset inside-choices">
            <legend>Who it is shown to</legend>
            {mine.labels.map((l) => (
              <label key={l.name} className="admin-check">
                <input type="radio" name="to" value={`label:${l.name}`} required />
                <span>
                  People who read at <code>{l.name}</code>.<small>{l.who_reads} The page arrives there as a source, and a fresh assessment of the node at that label is opened to weigh it, which runs when someone pays for it.</small>
                </span>
              </label>
            ))}
            <label className="admin-check">
              <input type="radio" name="to" value="outside" required />
              <span>
                People outside this deployment.
                <small>
                  Anyone. What is released is put in a signed package and submitted to the public graph under the organisation&rsquo;s
                  account, where it is reviewed like any contribution and then weighed as a source by the node&rsquo;s Steward there. A node
                  that exists only in this deployment is first proposed to the public graph, in words a person here writes or approves.
                </small>
              </span>
            </label>
            <small className="inside-note">
              A destination that already reads the label the page was written at is refused, since those people have the page whole. Labels
              you do not read are not offered here, because the name of a label is not shown to people who may not read it.
            </small>
          </fieldset>

          <fieldset className="admin-fieldset inside-choices">
            <legend>Once, or standing</legend>
            <label className="admin-check">
              <input type="radio" name="form" value="once" required />
              <span>
                Once.
                <small>
                  The page goes as it stands today, with its date. Nothing is undertaken about later assessments, and the people it is shown
                  to are told so. They can see that the moment was chosen by someone who could already read the verdict.
                </small>
              </span>
            </label>
            <label className="admin-check">
              <input type="radio" name="form" value="standing" required />
              <span>
                Standing.
                <small>
                  Each later assessment of the node at this label goes through the same steps. The people it is shown to see every one of
                  them: an assessment that is not released shows to them as held, with why and for how long, and stays in the showing&rsquo;s
                  history. That is what a standing showing undertakes: later results cannot be left out without that being seen. You can end
                  it; the end is dated, with a reason from a fixed list, and what was shown stays shown.
                </small>
              </span>
            </label>
          </fieldset>

          <fieldset className="admin-fieldset inside-choices">
            <legend>What it covers</legend>
            <label className="admin-check">
              <input type="radio" name="scope" value="node" required />
              <span>
                This node alone.
                <small>A subclaim of it appears on the page with how it bears, and its own page is not shown.</small>
              </span>
            </label>
            <label className="admin-check">
              <input type="radio" name="scope" value="under" required />
              <span>
                This node and what sits under it.
                <small>
                  Each node under it has its page shown in the same way. Under a standing showing, a node that later comes to sit under this
                  one is covered from then and shows as not yet assessed until it is; one that leaves stays in the record with the date and
                  the reason. So the shape of the work shows on the other side as it grows.
                </small>
              </span>
            </label>
          </fieldset>

          <fieldset className="admin-fieldset inside-choices">
            <legend>Only for a showing outside: how what is released leaves</legend>
            <label className="admin-check">
              <input type="radio" name="send" value="by_a_person_each_time" />
              <span>
                A person sends each time.
                <small>{sending.by_a_person_each_time ?? "Each package waits until a person who directs the graph sends it."}</small>
              </span>
            </label>
            <label className="admin-check">
              <input type="radio" name="send" value="as_released" />
              <span>
                Sent as soon as it is released.
                <small>{sending.as_released ?? "Each package is sent to the public graph as soon as it is built, with nobody sending it."}</small>
              </span>
            </label>
          </fieldset>

          <div className="acct-prose acct-measure inside-next">
            <p>
              <strong>Asking shows nothing.</strong> The page is first redacted under the policy for this boundary, and Audit checks the
              redaction; each of those is a run that happens when someone pays for it. Then the people who hold release for each party
              whose material a part rests on release it or hold it, part by part. Nothing is released by time passing.
            </p>
            <p>
              Some things are shown whenever the page is shown, and nothing is removed from them: the verdict with its confidence, what
              kinds of evidence it was made on, that each source exists and whether an outside party supplied it, how the page was made, and
              how many passages were removed under each category. Holding them holds the whole page. The <Link href="/redaction-policies">redaction policy</Link> for the
              boundary lists them, and everyone the page is shown to can read that policy in full.
            </p>
            <p>
              Your name and the permissions you hold now are recorded on the showing, where the people it is shown to can read them. For a
              showing outside, the record says a person holding these permissions asked, and does not give the name.
            </p>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
