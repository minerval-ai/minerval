"use client";

import Link from "next/link";
import { useActionState } from "react";
import { LabelChoice } from "../../../components/admin/LabelChoice";
import type { MyLabels } from "../../../lib/admin-api";
import { addSourceAction, type AddSourceState } from "./actions";

// The form for adding a source: an address, and the document's title and
// text where the address cannot be read from where the deployment runs. The
// button is disabled while the submission is sent, because a submission
// holds owls and is not safe to send twice.
//
// Where the deployment holds material at more than one label, the person
// says which label the source is for. Nothing is preselected.
export function AddSourceForm({ labels }: { labels?: MyLabels | null }) {
  const [state, action, pending] = useActionState<AddSourceState, FormData>(addSourceAction, {});
  return (
    <>
      {state.submitted && (
        <div className="key-reveal" role="status">
          <span className="sc">Submitted</span>
          {state.submitted.waitingForReview
            ? "It is waiting for review. Nothing is read from it until it is admitted."
            : "It is queued to be read."}{" "}
          {state.submitted.contributionId && (
            <>
              <Link href={`/contributions/${state.submitted.contributionId}`}>The submission and its review →</Link>{" "}
            </>
          )}
          <Link href={`/sources/${state.submitted.sourceId}`}>The source&rsquo;s page →</Link>
        </div>
      )}
      <form action={action} className="admin-form">
        <label>
          Address
          <input name="url" type="url" required placeholder="https://" autoComplete="off" />
          <small>
            Where the document is. A source is known by its address: if the graph already holds
            one at this address, that source is what is submitted, as it was first read.
          </small>
        </label>
        {labels && (
          <LabelChoice
            mine={labels}
            what="Who may read the source, and what the agents record from it. It is chosen now and the source keeps it."
          />
        )}
        <label>
          Title
          <input name="title" maxLength={500} autoComplete="off" />
          <small>Optional. Left empty, the address stands in for it.</small>
        </label>
        <label>
          Text
          <textarea name="content" rows={8} />
          <small>
            Optional. Paste the document&rsquo;s text if its address cannot be fetched from where
            this deployment runs, or if what is at the address may change. The text is stored as
            you give it, with its fingerprint, and that is what is read.
          </small>
        </label>
        <div className="admin-form-foot">
          <button className="order-button" type="submit" disabled={pending}>
            {pending ? "Submitting…" : "Submit the source"}
          </button>
          {state.error && (
            <span className="admin-form-said admin-form-error" role="alert">
              {state.error}
            </span>
          )}
        </div>
      </form>
    </>
  );
}
