import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { KeepForm } from "@/components/inside/KeepForm";
import { can, viewer } from "@/components/admin/access";
import { WorkNav, day } from "@/components/inside/nav";
import { fetchPolicies, fetchPolicy } from "@/lib/inside-api";
import { savePolicyAction } from "../../showings/actions";

export const metadata: Metadata = { title: "A redaction policy · Minerval" };
export const dynamic = "force-dynamic";

// One version of a boundary's redaction policy in full
// (GET /redaction-policies/:policy_id), and, for an administrator who reads
// the label the pages are written at, the form that saves the next version
// (PUT /redaction-policies). Two sections of every version are written by
// the system and are the same at every boundary: how removal works, and
// what is shown whenever a page is shown. The categories are the
// deployment's to add, reword and drop.

const BLANK_ROWS = 3;

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { id } = await params;
  const [policy, listed] = await Promise.all([
    fetchPolicy(who.externalId, id).catch(() => null),
    fetchPolicies(who.externalId).catch(() => []),
  ]);
  if (!policy) notFound();
  const sides = listed.filter((p) => p.boundary_id === policy.boundary_id);
  const boundary = sides.find((p) => p.from_label) ?? sides[0] ?? null;
  const newest = sides.reduce((n, p) => Math.max(n, p.version), 0);
  const inForce = newest === 0 || policy.version === newest;
  const outside = boundary?.shown_to === "outside this deployment";
  const mayEdit = can(who, "administer") && !!boundary?.from_label && inForce;

  return (
    <div className="admin-page">
      <PageHead
        back={{ href: "/redaction-policies", label: "redaction policies" }}
        kicker="Redaction policy"
        title={`Version ${policy.version}`}
        lede={
          <>
            For pages written at {boundary?.from_label ? <code>{boundary.from_label}</code> : "a label you do not read"} and shown to{" "}
            {outside ? "people outside this deployment" : boundary ? <code>{boundary.shown_to}</code> : "a label you read"}. Saved on{" "}
            {day(policy.saved_at)}. {inForce ? "It is the version in force at this boundary." : `It is an earlier version: version ${newest} is in force.`}
          </>
        }
      />
      <WorkNav who={who} current="" />

      <section className="acct-section admin-first" id="text">
        <div className="acct-head">
          <h2>The policy in full</h2>
        </div>
        <p className="acct-prose acct-measure">
          This text is published in full with every page shown under it: everyone a page is shown to inside this deployment can read it
          here, and a page shown outside carries it in its signed package. Its fingerprint is <code className="inside-hash-whole">{policy.hash}</code>,
          and every removal records the version it was made under.
        </p>
        <pre className="admin-pre inside-policy">{policy.text}</pre>
      </section>

      <section className="acct-section" id="change">
        <div className="acct-head">
          <h2>Changing it</h2>
        </div>
        {mayEdit ? (
          <>
            <p className="acct-prose acct-measure">
              Saving makes a new version, which is in force from then for this boundary; earlier versions stay on record, and a removal
              already made keeps the version it was made under. You change the categories. How removal works and what is shown whenever a
              page is shown are written by the system, are the same at every boundary, and are not part of what is saved. A category worded
              by how a passage reflects on someone, or one that names something always shown, is refused when you save, with the reason.
              That check is a list of phrases and catches the plain cases: what stands behind it is that everyone on the other side reads
              the policy, and that Audit reads every removal.
            </p>
            <KeepForm action={savePolicyAction} submit={`Save as version ${policy.version + 1}`}>
              <input type="hidden" name="from_label" value={boundary!.from_label} />
              <input type="hidden" name="to" value={outside ? "outside" : boundary!.shown_to} />
              {[...policy.categories, ...Array.from({ length: BLANK_ROWS }, () => ({ name: "", covers: "", examples: "" }))].map((c, i) => (
                <fieldset className="admin-fieldset inside-category" key={i}>
                  <legend>{i < policy.categories.length ? `Category ${i + 1}` : "A new category (leave blank to add none)"}</legend>
                  <label>
                    Name
                    <input name="category_name" defaultValue={c.name} maxLength={80} />
                    {i === 0 && <small>The name is the whole of what a mark says, as in [redacted: {c.name || "personal data"}]. Clear the name and what it covers to drop a category.</small>}
                  </label>
                  <label>
                    What it covers
                    <textarea name="category_covers" rows={2} defaultValue={c.covers} />
                  </label>
                  <label>
                    Examples
                    <textarea name="category_examples" rows={2} defaultValue={c.examples} />
                  </label>
                </fieldset>
              ))}
            </KeepForm>
          </>
        ) : (
          <p className="acct-prose acct-measure">
            {!inForce
              ? "An earlier version is not changed. The next version is saved from the version in force."
              : !can(who, "administer")
                ? "A new version is saved by an administrator of this deployment who reads the label the pages are written at."
                : "You administer this deployment and do not read the label these pages are written at, so its name is not shown to you and you cannot save a version for this boundary from here. An administrator who reads that label can, and an administrator grants reading at a label, to themselves as to anyone, with the grant logged."}
          </p>
        )}
      </section>
    </div>
  );
}
