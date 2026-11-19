"use client";

import { useActionState, useState, useTransition, type FormEvent } from "react";
import type { PolicyCategory, RedactorTrial } from "@/lib/inside-api";
import type { PolicyFormState, TrialFormState } from "../actions";

// Trying the Redactor on a sample (docs/the-gate.md, "Trying the Redactor").
// The sample, a budget, and a draft of the policy, started from the version
// in force: its categories and its guidelines for asking a person. The
// Redactor runs on the sample under the draft and is shown here as it
// worked: each part as it would be released, each removal with its note,
// each hold and referral, and what it was least sure of. Nothing is
// released or saved. An administrator who likes the draft saves it as the
// next version from here.

interface Row {
  key: number;
  name: string;
  covers: string;
  examples: string;
}

const MARK = /\[redacted: [^\]]+\]/g;

/** A part as it would be released, its marks set apart. */
function Marked({ text }: { text: string }) {
  const out: Array<string | { mark: string }> = [];
  let from = 0;
  for (const m of text.matchAll(MARK)) {
    out.push(text.slice(from, m.index));
    out.push({ mark: m[0] });
    from = m.index! + m[0].length;
  }
  out.push(text.slice(from));
  return (
    <>
      {out.map((piece, i) =>
        typeof piece === "string" ? (
          <span key={i}>{piece}</span>
        ) : (
          <span key={i} className="w-chip w-mono">
            {piece.mark}
          </span>
        )
      )}
    </>
  );
}

function Outcome({ trial }: { trial: RedactorTrial }) {
  const o = trial.outcome;
  const removals = o.parts.reduce((n, p) => n + p.removals.length, 0);
  const referred = o.parts.filter((p) => p.referred).length + (o.whole_item.referred ? 1 : 0);
  const held = o.parts.filter((p) => p.held).length + (o.whole_item.held ? 1 : 0);
  return (
    <div className="w-col" style={{ gap: 10 }}>
      <div className="w-row w-small" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="w-pill">{removals === 1 ? "1 removal" : `${removals} removals`}</span>
        {referred > 0 && <span className="w-pill w-warn">{referred} referred to a person</span>}
        {held > 0 && <span className="w-pill w-bad">{held} held</span>}
        {o.least_sure.length > 0 && <span className="w-pill w-warn">{o.least_sure.length} least sure</span>}
        {!o.finished && <span className="w-pill w-bad">The run ended before it finished</span>}
        <span className="w-spacer w-muted">
          Spent {trial.spent_owls} of {trial.budget_owls} owls · {trial.policy.draft ? `a draft after v${trial.policy.based_on_version ?? 0}` : `v${trial.policy.based_on_version}`}
        </span>
      </div>
      {(o.whole_item.referred || o.whole_item.held) && (
        <div className="w-card w-card-b">
          <b>The whole item</b>
          {o.whole_item.referred && (
            <div className="w-said">
              Referred to a person; the Redactor would {o.whole_item.referred.in_words}: {o.whole_item.referred.note}
            </div>
          )}
          {o.whole_item.held && (
            <div className="w-said">
              Held ({o.whole_item.held.reason}): {o.whole_item.held.note}
            </div>
          )}
        </div>
      )}
      {o.parts.map((p) => (
        <div className="w-card w-card-b" key={p.part}>
          <div className="w-row" style={{ gap: 8 }}>
            <b>Part {p.part}</b>
            {p.referred && <span className="w-pill w-warn">Asks a person · would {p.referred.recommends === "hold" ? "hold" : "let through"}</span>}
            {p.held && <span className="w-pill w-bad">Held · {p.held.reason}</span>}
            {p.delayed_until && <span className="w-pill w-info">Delayed</span>}
          </div>
          <div style={{ marginTop: 6 }}>
            <Marked text={p.as_it_would_be_released} />
          </div>
          {p.removals.map((r, i) => (
            <div className="w-help" key={i} style={{ marginTop: 4 }}>
              Removed &ldquo;{r.passage}&rdquo; as {r.category}: {r.note}
            </div>
          ))}
          {p.referred && <div className="w-help" style={{ marginTop: 4 }}>Why a person: {p.referred.note}</div>}
          {p.held && <div className="w-help" style={{ marginTop: 4 }}>Why held: {p.held.note}</div>}
        </div>
      ))}
      {o.least_sure.length > 0 && (
        <div className="w-card w-card-b">
          <b>Least sure</b>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {o.least_sure.map((l, i) => (
              <li key={i}>
                {l.part ? `Part ${l.part}` : "The item"}
                {l.passage ? `, “${l.passage}”` : ""}: {l.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>The policy text the Redactor read</summary>
        <pre className="w-code">{trial.policy.text}</pre>
      </details>
    </div>
  );
}

export function TrialBench({
  tryAction,
  saveAction,
  gateId,
  fromLabel,
  to,
  version,
  categories,
  referWhen,
  maySave,
  budgetCeiling,
}: {
  tryAction: (previous: TrialFormState, form: FormData) => Promise<TrialFormState>;
  saveAction: (previous: PolicyFormState, form: FormData) => Promise<PolicyFormState>;
  gateId: string;
  fromLabel: string;
  to: string;
  version: number;
  categories: PolicyCategory[];
  referWhen: string[];
  /** An administrator who reads the label the pages are written at may save the draft as the next version. */
  maySave: boolean;
  budgetCeiling?: number;
}) {
  const [rows, setRows] = useState<Row[]>(() => categories.map((c, i) => ({ key: i, ...c })));
  const [next, setNext] = useState(categories.length);
  const [refer, setRefer] = useState(referWhen.join("\n"));
  const [state, run] = useActionState(tryAction, {});
  const [saved, save] = useActionState(saveAction, {});
  const [pending, start] = useTransition();
  const [saving, startSave] = useTransition();

  const lines = (t: string) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const changed =
    lines(refer).join("\n") !== referWhen.join("\n") ||
    rows.length !== categories.length ||
    rows.some((r, i) => r.name !== categories[i]?.name || r.covers !== categories[i]?.covers || r.examples !== categories[i]?.examples);
  const edit = (key: number, field: "name" | "covers" | "examples", value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));

  const draftFields = (
    <>
      {rows.map((r) => (
        <span key={r.key}>
          <input type="hidden" name="category_name" value={r.name} />
          <input type="hidden" name="category_covers" value={r.covers} />
          <input type="hidden" name="category_examples" value={r.examples} />
        </span>
      ))}
      <input type="hidden" name="refer_when" value={refer} />
    </>
  );

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    start(() => run(data));
  };
  const sendSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startSave(() => save(data));
  };

  return (
    <div className="w-grid2">
      <form onSubmit={send} className="w-form w-col" style={{ gap: 12, minWidth: 0 }}>
        <input type="hidden" name="gate_id" value={gateId} />
        {draftFields}
        <div className="w-help">
          Give the Redactor a sample like what crosses this boundary and see what it does under the policy, or under your draft of the next
          version. Nothing is released or saved. The run is on the run log at {fromLabel}, and is paid from your balance within the budget
          you name; what it does not spend is returned.
        </div>
        <div className="w-field">
          <label htmlFor="trial-sample">Sample</label>
          <textarea id="trial-sample" className="w-input" name="sample" rows={10} required placeholder="Paste a passage. Blank lines separate its parts." />
        </div>
        <div className="w-field" style={{ maxWidth: 220 }}>
          <label htmlFor="trial-budget">Budget, in owls</label>
          <input id="trial-budget" className="w-input" name="budget_owls" type="number" min="0.1" step="0.1" max={budgetCeiling} defaultValue="2" required />
        </div>
        <details open={changed || undefined}>
          <summary>
            Draft policy {changed ? <span className="w-pill w-info">Changed from v{version}</span> : <span className="w-muted">· v{version} as it stands</span>}
          </summary>
          <div className="w-col" style={{ gap: 8, marginTop: 8 }}>
            {rows.map((r) => (
              <div className="w-card w-card-b w-col" style={{ gap: 6 }} key={r.key}>
                <div className="w-row" style={{ gap: 6 }}>
                  <input className="w-input" aria-label="Category name" value={r.name} onChange={(e) => edit(r.key, "name", e.target.value)} maxLength={80} />
                  <button type="button" className="w-btn w-ghost w-sm" aria-label={`Remove category ${r.name}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                    ✕
                  </button>
                </div>
                <textarea className="w-input" aria-label="Covers" rows={2} value={r.covers} onChange={(e) => edit(r.key, "covers", e.target.value)} />
                <textarea className="w-input" aria-label="Examples" rows={1} value={r.examples} placeholder="Examples (optional)" onChange={(e) => edit(r.key, "examples", e.target.value)} />
              </div>
            ))}
            <div>
              <button
                type="button"
                className="w-btn w-sm"
                onClick={() => {
                  setRows((rs) => [...rs, { key: next, name: "", covers: "", examples: "" }]);
                  setNext((n) => n + 1);
                }}
              >
                Add category
              </button>
            </div>
            <div className="w-field">
              <label htmlFor="trial-refer">When the Redactor asks a person (one a line)</label>
              <textarea id="trial-refer" className="w-input" rows={3} value={refer} onChange={(e) => setRefer(e.target.value)} />
            </div>
          </div>
        </details>
        {(state.problems ?? []).map((p, i) => (
          <span className="w-gates-err" role="alert" key={i}>
            &ldquo;{p.category}&rdquo;: {p.problem}
          </span>
        ))}
        {state.error && !(state.problems ?? []).length && (
          <span className="w-said w-error" role="alert">
            {state.error}
          </span>
        )}
        <div className="w-row" style={{ gap: 8 }}>
          <button type="submit" className="w-btn w-pri" disabled={pending}>
            {pending ? "The Redactor is working…" : "Try the Redactor"}
          </button>
        </div>
      </form>

      <aside className="w-col" style={{ gap: 12, minWidth: 0 }}>
        {state.trial ? (
          <Outcome trial={state.trial} />
        ) : (
          <div className="w-empty">What the Redactor does with the sample shows here, part by part, with its notes.</div>
        )}
        {maySave && changed && (
          <form onSubmit={sendSave} className="w-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input type="hidden" name="gate_id" value={gateId} />
            <input type="hidden" name="from_label" value={fromLabel} />
            <input type="hidden" name="to" value={to} />
            {draftFields}
            <button type="submit" className="w-btn" disabled={saving}>
              {saving ? "Saving…" : `Save the draft as v${version + 1}`}
            </button>
            {saved.error && (
              <span className="w-said w-error" role="alert">
                {saved.error}
                {(saved.problems ?? []).map((p) => ` "${p.category}": ${p.problem}`).join("")}
              </span>
            )}
          </form>
        )}
      </aside>
    </div>
  );
}
