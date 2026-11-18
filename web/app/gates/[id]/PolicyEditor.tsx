"use client";

import { useActionState, useState, useTransition, type FormEvent } from "react";
import type { PolicyCategory } from "@/lib/inside-api";
import type { PolicyFormState } from "../actions";

/** What a problem with the guidelines for asking a person is filed under (src/services/redaction-policy.ts, REFER_WHEN_PROBLEM). */
const REFER_WHEN_PROBLEM = "when to ask a person";

// A boundary's categories, edited as rows, saved as the policy's next
// version. What was typed stays when the save is refused (as KeepForm does),
// and each category's problem is shown beside it. The name is the whole of
// what a mark says, so each row previews its mark. Below them, the guidelines
// for when the Redactor asks a person rather than deciding alone, one a line,
// saved with the categories as part of the same version.

interface Row {
  key: number;
  name: string;
  covers: string;
  examples: string;
  /** The category as the version in force has it; absent for a new one. */
  was?: PolicyCategory;
}

const rowsOf = (categories: PolicyCategory[]): Row[] => categories.map((c, i) => ({ key: i, ...c, was: c }));

export function PolicyEditor({
  action,
  gateId,
  fromLabel,
  to,
  version,
  categories,
  referWhen,
}: {
  action: (previous: PolicyFormState, form: FormData) => Promise<PolicyFormState>;
  gateId: string;
  fromLabel: string;
  to: string;
  version: number;
  categories: PolicyCategory[];
  /** The version in force's guidelines for asking a person. */
  referWhen: string[];
}) {
  const referStart = referWhen.join("\n");
  const [refer, setRefer] = useState(referStart);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(categories));
  const [next, setNext] = useState(categories.length);
  const [state, formAction] = useActionState(action, {});
  const [pending, start] = useTransition();

  const edit = (key: number, field: "name" | "covers" | "examples", value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const add = () => {
    setRows((rs) => [...rs, { key: next, name: "", covers: "", examples: "" }]);
    setNext((n) => n + 1);
  };
  const remove = (key: number) => setRows((rs) => rs.filter((r) => r.key !== key));
  const discard = () => {
    setRefer(referStart);
    setRows(rowsOf(categories));
    setNext(categories.length);
  };
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    start(() => formAction(data));
  };

  const removed = categories.filter((c) => !rows.some((r) => r.was === c)).length;
  const changed = rows.filter((r) => !r.was || r.was.name !== r.name || r.was.covers !== r.covers || r.was.examples !== r.examples).length;
  const lines = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const referChanged = lines(refer).join("\n") !== lines(referStart).join("\n");
  const changes = changed + removed + (referChanged ? 1 : 0);
  const allProblems = state.problems ?? [];
  const referProblems = allProblems.filter((p) => p.category === REFER_WHEN_PROBLEM);
  const problems = allProblems.filter((p) => p.category !== REFER_WHEN_PROBLEM);
  const problemsOf = (r: Row) => problems.filter((p) => p.category.trim().toLowerCase() === (r.name.trim() || "(unnamed)").toLowerCase());
  const unplaced = problems.filter((p) => !rows.some((r) => problemsOf(r).includes(p)));

  return (
    <form onSubmit={send} className="w-form" style={{ gap: 12 }}>
      <input type="hidden" name="gate_id" value={gateId} />
      <input type="hidden" name="from_label" value={fromLabel} />
      <input type="hidden" name="to" value={to} />
      {rows.length === 0 && <div className="w-empty">No categories: nothing would be removed at this boundary.</div>}
      {rows.map((r, i) => {
        const own = problemsOf(r);
        const id = `cat-${r.key}`;
        return (
          <div className={own.length > 0 ? "w-card w-card-b w-gates-cat w-gates-bad" : "w-card w-card-b w-gates-cat"} key={r.key}>
            <div className="w-gates-cat-top">
              <div className="w-field">
                <label htmlFor={`${id}-name`} className="w-row" style={{ gap: 6 }}>
                  Name {!r.was && <span className="w-pill w-info">New</span>}
                </label>
                <input
                  id={`${id}-name`}
                  className={r.was && r.was.name !== r.name ? "w-input w-gates-edited" : "w-input"}
                  name="category_name"
                  value={r.name}
                  maxLength={80}
                  onChange={(e) => edit(r.key, "name", e.target.value)}
                  aria-invalid={own.length > 0 || undefined}
                  aria-describedby={own.length > 0 ? `${id}-err` : undefined}
                  placeholder={i === 0 ? "personal data" : undefined}
                />
              </div>
              <div className="w-field w-gates-markf">
                <span className="w-help">Mark</span>
                <span className="w-chip w-mono w-gates-mark" title="What a reader sees where a passage was removed">
                  [redacted: {r.name.trim() || "…"}]
                </span>
              </div>
              <button
                type="button"
                className="w-btn w-ghost w-sm"
                style={{ height: 32 }}
                onClick={() => remove(r.key)}
                aria-label={`Remove category ${r.name || "(unnamed)"}`}
                title="Remove category"
              >
                ✕
              </button>
            </div>
            {own.length > 0 && (
              <div id={`${id}-err`} role="alert" className="w-col" style={{ gap: 4 }}>
                {own.map((p, n) => (
                  <span className="w-gates-err" key={n}>
                    {p.problem}
                  </span>
                ))}
              </div>
            )}
            <div className="w-gates-pair">
              <div className="w-field">
                <label htmlFor={`${id}-cov`} className="w-row" style={{ gap: 6 }}>
                  Covers {r.was && r.was.covers !== r.covers && <span className="w-pill w-info">Edited</span>}
                </label>
                <textarea
                  id={`${id}-cov`}
                  className={r.was && r.was.covers !== r.covers ? "w-input w-gates-edited" : "w-input"}
                  name="category_covers"
                  rows={3}
                  value={r.covers}
                  onChange={(e) => edit(r.key, "covers", e.target.value)}
                />
              </div>
              <div className="w-field">
                <label htmlFor={`${id}-ex`} className="w-row" style={{ gap: 6 }}>
                  Examples {r.was && r.was.examples !== r.examples && <span className="w-pill w-info">Edited</span>}
                </label>
                <textarea
                  id={`${id}-ex`}
                  className={r.was && r.was.examples !== r.examples ? "w-input w-gates-edited" : "w-input"}
                  name="category_examples"
                  rows={3}
                  value={r.examples}
                  placeholder="Optional"
                  onChange={(e) => edit(r.key, "examples", e.target.value)}
                />
              </div>
            </div>
          </div>
        );
      })}
      <div>
        <button type="button" className="w-btn w-sm" onClick={add}>
          Add category
        </button>
      </div>
      <div className={referProblems.length > 0 ? "w-card w-card-b w-gates-bad" : "w-card w-card-b"}>
        <div className="w-field">
          <label htmlFor="refer-when" className="w-row" style={{ gap: 6 }}>
            When the Redactor asks a person {referChanged && <span className="w-pill w-info">Edited</span>}
          </label>
          <span className="w-help">
            One a line. Where one holds, the Redactor refers the item to the people who consent for it, with what it would do, even where
            the gate is set to its decision. It also refers anything else it finds a close call. Write these as you notice what you want
            to see; they are how a gate can be left to the Redactor and still bring you the cases that need you.
          </span>
          <textarea
            id="refer-when"
            className={referChanged ? "w-input w-gates-edited" : "w-input"}
            name="refer_when"
            rows={4}
            value={refer}
            placeholder={"A passage naming a customer, where it is unclear whether the customer is public\nAnything about an incident still under investigation"}
            onChange={(e) => setRefer(e.target.value)}
            aria-invalid={referProblems.length > 0 || undefined}
          />
          {referProblems.map((p, n) => (
            <span className="w-gates-err" role="alert" key={n}>
              {p.problem}
            </span>
          ))}
        </div>
      </div>
      {(changes > 0 || state.error || state.notice) && (
        <div className="w-savebar">
          <span style={{ whiteSpace: "nowrap" }}>
            {changes > 0 ? `${changes} unsaved change${changes === 1 ? "" : "s"}` : "No changes"}
            {removed > 0 && <span className="w-muted"> · {removed} removed</span>}
          </span>
          {state.error && (
            <span className="w-said w-error" role="alert" style={{ flex: "1 1 200px" }}>
              {state.error}
              {unplaced.map((p) => ` "${p.category}": ${p.problem}`).join("")}
            </span>
          )}
          <span className="w-spacer w-row" style={{ flexWrap: "nowrap" }}>
            <button type="button" className="w-btn w-ghost" onClick={discard} disabled={pending || changes === 0}>
              Discard
            </button>
            <button type="submit" className="w-btn w-pri" disabled={pending || changes === 0}>
              {pending ? "Saving…" : `Save as v${version + 1}`}
            </button>
          </span>
        </div>
      )}
    </form>
  );
}
