"use client";

import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import { Tip } from "@/components/work/ui";
import { LabelField, type LabelOption } from "../LabelField";
import { addSourceAction, type AddSourceState } from "./actions";

// The form for adding a source, in the drawer of the Sources page: an
// address, and the document's title and text where the address cannot be
// read from where the deployment runs. The button is disabled while the
// submission is sent, because a submission holds owls and is not safe to
// send twice.
//
// Where the deployment holds material at more than one label, the person
// says which label the source is for. Nothing is preselected.
export function AddSourceForm({
  labels,
  cost,
  party,
  close,
}: {
  labels?: { must_choose: boolean; labels: LabelOption[] } | null;
  /** The owl line: the ceiling held and the balance. */
  cost?: ReactNode;
  /** The line on whose material it is recorded as. */
  party?: ReactNode;
  /** The address of the page without the drawer. */
  close: string;
}) {
  const [state, action, pending] = useActionState<AddSourceState, FormData>(addSourceAction, {});
  if (state.submitted) {
    return (
      <div className="w-col">
        <div className="w-banner w-ok" role="status">
          {state.submitted.waitingForReview
            ? "Submitted. It waits for review; nothing is read from it until it is admitted."
            : "Submitted. It is queued to be read."}
        </div>
        <div className="w-row">
          {state.submitted.contributionId && (
            <Link className="w-btn" href={`/contributions/${state.submitted.contributionId}`}>
              The submission and its review
            </Link>
          )}
          <Link className="w-btn" href={`/sources/${state.submitted.sourceId}`}>
            The source&rsquo;s page
          </Link>
          <Link className="w-btn w-ghost" href={close} scroll={false}>
            Done
          </Link>
        </div>
      </div>
    );
  }
  return (
    <form action={action} className="w-form">
      <div className="w-field">
        <label htmlFor="s-url">URL</label>
        <input id="s-url" className="w-input" name="url" type="url" required placeholder="https://" autoComplete="off" />
        <span className="w-help">An address the graph already holds reuses that source, as it was first read</span>
      </div>
      {labels && (
        <LabelField
          mine={labels}
          tip="Who may read the source and what agents record from it. Chosen now; the source keeps it. Its text goes only to the model providers and outside services cleared for this label."
        />
      )}
      <div className="w-field">
        <label htmlFor="s-title">
          Title <span className="w-faint" style={{ fontWeight: 400 }}>optional</span>
        </label>
        <input id="s-title" className="w-input" name="title" maxLength={500} autoComplete="off" placeholder="The address stands in if empty" />
      </div>
      <div className="w-field">
        <label htmlFor="s-text" className="w-row" style={{ gap: 6 }}>
          Paste text <span className="w-faint" style={{ fontWeight: 400 }}>optional</span>{" "}
          <Tip>The text is stored as you give it, with its fingerprint, and that is what is read.</Tip>
        </label>
        <textarea id="s-text" className="w-input" name="content" rows={7} placeholder="Paste the document's text" />
        <span className="w-help">For an address that can&rsquo;t be fetched from here, or may change</span>
      </div>
      {cost && <div className="w-banner w-small">{cost}</div>}
      {party && <div className="w-row w-muted w-small">{party}</div>}
      <div className="w-form-foot">
        <button className="w-btn w-pri" type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Add source"}
        </button>
        <Link className="w-btn w-ghost" href={close} scroll={false}>
          Cancel
        </Link>
        <span className="w-faint w-small">Reviewed before anything is read</span>
        {state.error && (
          <span className="w-said w-error" role="alert">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
