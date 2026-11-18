"use client";

import Link from "next/link";
import { useState } from "react";
import { WorkForm } from "@/components/work/WorkForm";
import { Boundary, Lbl, Tip, shortDay } from "@/components/work/ui";
import { askShowingAction } from "../actions";
import "../showings.css";

// The choices of a new release, each a card, and what follows from them in
// at most four lines beside. A client component only so that those lines
// follow the choices as they are made; the form posts to the same server
// action as before (askShowingAction), which redirects to the new showing.

export function NewShowingForm({
  nodeId,
  pages,
  at,
  labels,
  gates,
}: {
  nodeId: string;
  pages: Array<{ label: string; assessedAt: string }>;
  at: string | null;
  labels: Array<{ name: string; whoReads: string; reads: string[] }>;
  gates: Array<{ id: string; from: string; to: string }>;
}) {
  const [page, setPage] = useState<string>(pages.length === 1 ? pages[0]!.label : (pages.find((p) => p.label === at)?.label ?? ""));
  const [to, setTo] = useState<string>("");
  const [form, setForm] = useState<string>("");
  const [scope, setScope] = useState<string>("");
  const dest = to === "outside" ? "outside" : to.replace(/^label:/, "");
  const gate = page && dest ? gates.find((g) => g.from === page && g.to === dest) : undefined;

  // A label that reads the page's label already has the page whole, and the API refuses it.
  const reads = (l: { name: string; reads: string[] }) => !!page && (l.name === page || l.reads.includes(page));

  return (
    <WorkForm action={askShowingAction} submit="Release" primary extra={<Link className="w-btn" href="/releases">Cancel</Link>}>
      <input type="hidden" name="node_id" value={nodeId} />

      <fieldset className="w-field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="w-label" style={{ marginBottom: 5 }}>
          Page{" "}
          <Tip>
            What was written at that label: the assessment, its arguments and their evaluations, the readings of its sources, its subclaims. Another
            label&apos;s page is a separate release.
          </Tip>
        </legend>
        <div className="w-showings-opts">
          {pages.map((p) => (
            <label key={p.label} className="w-option">
              <input type="radio" name="page_label" value={p.label} required checked={page === p.label} onChange={() => setPage(p.label)} />
              <span>
                <Lbl name={p.label} />
                <span className="w-showings-m">assessed {shortDay(p.assessedAt)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="w-field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="w-label" style={{ marginBottom: 5 }}>
          Release to{" "}
          <Tip>Labels you do not read are not offered, because a label&apos;s name is not shown to people who may not read it.</Tip>
        </legend>
        <div className="w-showings-opts">
          {labels.map((l) => {
            const off = reads(l);
            return (
              <label key={l.name} className="w-option" title={off ? `${l.name} reads ${page}, so its readers have this page whole` : l.whoReads}>
                <input
                  type="radio"
                  name="to"
                  value={`label:${l.name}`}
                  required
                  disabled={off}
                  checked={to === `label:${l.name}` && !off}
                  onChange={() => setTo(`label:${l.name}`)}
                />
                <span>
                  <Lbl name={l.name} />
                  <span className="w-showings-m">{off ? `Already reads ${page}` : l.name === "public" ? "every member" : "arrives as a source there"}</span>
                </span>
              </label>
            );
          })}
          <label className="w-option">
            <input type="radio" name="to" value="outside" required checked={to === "outside"} onChange={() => setTo("outside")} />
            <span>
              <Lbl name="outside" />
              <span className="w-showings-m">
                the public graph{" "}
                <Tip>
                  Released parts go in a signed package to the public graph under the organisation&apos;s account, reviewed there like any contribution. A
                  node that exists only here is first proposed, in words a person here writes or approves.
                </Tip>
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <div className="w-field">
        <span className="w-label">Kind</span>
        <div className="w-seg w-showings-seg" role="radiogroup" aria-label="Kind">
          <label>
            <input type="radio" name="form" value="once" required checked={form === "once"} onChange={() => setForm("once")} />
            Once
          </label>
          <label>
            <input type="radio" name="form" value="standing" required checked={form === "standing"} onChange={() => setForm("standing")} />
            Standing
          </label>
        </div>
        <div className="w-showings-help">
          <span>This page, as it stands today</span>
          <span>
            Every later assessment follows{" "}
            <Tip>One not released shows to them as held, with why. Later results can&apos;t be left out unseen. You can end it; what was released stays released.</Tip>
          </span>
        </div>
      </div>

      <div className="w-field">
        <span className="w-label">Covers</span>
        <div className="w-seg w-showings-seg" role="radiogroup" aria-label="Covers">
          <label>
            <input type="radio" name="scope" value="node" required checked={scope === "node"} onChange={() => setScope("node")} />
            This node
          </label>
          <label>
            <input type="radio" name="scope" value="under" required checked={scope === "under"} onChange={() => setScope("under")} />
            With what&apos;s under it
          </label>
        </div>
        <div className="w-showings-help">
          <span>Subclaims show only how they bear</span>
          <span>Each node under it is released the same way; later ones join</span>
        </div>
      </div>

      <div className="w-showings-what" aria-live="polite">
        <div className="w-showings-what-h">What happens</div>
        {page && dest ? (
          <div>
            Through the{" "}
            <span style={{ display: "inline-flex", verticalAlign: "-2px" }}>
              <Boundary from={page} to={dest} />
            </span>{" "}
            boundary: redacted, audited, then released under its rules ·{" "}
            <Link href={gate ? `/gates/${gate.id}` : "/gates"}>{gate ? "Boundary" : "Boundaries"}</Link>
          </div>
        ) : (
          <div className="w-muted">Choose the page and who it is released to.</div>
        )}
        {form && (
          <div>
            {form === "standing"
              ? `Each later assessment${page ? ` at ${page}` : ""} follows; one not released shows to them as held.`
              : "The page goes as it stands today, dated; nothing is undertaken about later ones."}
            {scope === "under" ? " Nodes under it are covered too." : scope === "node" ? " This node alone." : ""}
          </div>
        )}
        <div>Redaction and its check are paid from the budget of the work that produced the page.</div>
        {dest === "outside" && <div>Released parts leave in a signed package, under the organisation&apos;s account.</div>}
      </div>

      <details className="w-showings-always">
        <summary>Always shown with the page</summary>
        <ul>
          <li>The verdict, with any credence</li>
          <li>The kinds of evidence it was made on</li>
          <li>That each source exists, and whether an outside party supplied it</li>
          <li>How the page was made</li>
          <li>How many passages were removed under each category</li>
        </ul>
        <span className="w-help">Nothing is removed from these. Holding any of them holds the whole page.</span>
      </details>

      <span className="w-help">
        Recorded with your name and permissions{" "}
        <Tip>The people it is released to can read who asked and what they held. For a release outside, only the permissions are given, not the name.</Tip>
      </span>
    </WorkForm>
  );
}
