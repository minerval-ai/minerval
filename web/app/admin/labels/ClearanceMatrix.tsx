"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";
import { setProviderClearanceAction } from "../actions";

// What each label may be sent to, as one matrix: a row for each label besides
// public, a column for each model provider and outside service. Ticks change
// only on this page until Save, which sends each changed row as its own
// request (the API clears providers one label at a time: PUT
// /labels/{label}/providers), one after the other, and says what each did.

export interface MatrixProvider {
  name: string;
  /** How the column is headed: "Anthropic", "Web search". */
  heading: string;
  kind: "model_provider" | "outside_service";
  description: string;
  configured: boolean;
}

export interface MatrixRow {
  label: string;
  /** The label as the page draws it (components/work/ui.tsx Lbl). */
  chip: ReactNode;
  cleared: string[];
  /** What cannot be served at the label as it is cleared now, one line. */
  problem: string | null;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function ClearanceMatrix({
  providers,
  rows,
  editable,
  publicChip,
}: {
  providers: MatrixProvider[];
  rows: MatrixRow[];
  editable: boolean;
  publicChip: ReactNode;
}) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Array<{ label: string; error?: string; notice?: string }>>([]);

  const saved = new Map(rows.map((r) => [r.label, r.cleared]));
  const ticked = (label: string) => edits[label] ?? saved.get(label) ?? [];
  const changed = rows.filter((r) => edits[r.label] && !same(edits[r.label], r.cleared)).map((r) => r.label);
  const changedCells = changed.reduce((n, label) => {
    const before = saved.get(label) ?? [];
    const after = ticked(label);
    return n + providers.filter((p) => before.includes(p.name) !== after.includes(p.name)).length;
  }, 0);

  const models = providers.filter((p) => p.kind === "model_provider");
  const services = providers.filter((p) => p.kind === "outside_service");
  const ordered = [...models, ...services];

  function toggle(label: string, provider: string, on: boolean) {
    const now = ticked(label).filter((p) => p !== provider);
    setEdits({ ...edits, [label]: on ? [...now, provider] : now });
    setSaid([]);
  }

  async function save() {
    setBusy(true);
    const results: typeof said = [];
    const left = { ...edits };
    for (const label of changed) {
      const form = new FormData();
      form.set("label", label);
      for (const p of ticked(label)) form.append("providers", p);
      const result = await setProviderClearanceAction({}, form);
      results.push({ label, ...result });
      if (!result.error) delete left[label];
    }
    setEdits(left);
    setSaid(results);
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <div className="w-tbox">
        <table className="w-t w-labels-matrix" aria-label="What each label may be sent to">
          <thead>
            <tr>
              <th className="w-labels-group" />
              {models.length > 0 && (
                <th className="w-labels-group" colSpan={models.length}>
                  Model providers
                </th>
              )}
              {services.length > 0 && (
                <th className="w-labels-group" colSpan={services.length}>
                  Outside services
                </th>
              )}
            </tr>
            <tr>
              <th style={{ width: 130 }}>Label</th>
              {ordered.map((p) => (
                <th
                  key={p.name}
                  className={[
                    "w-labels-col",
                    !p.configured && "w-labels-off",
                    p === services[0] && "w-labels-first-service",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title={p.configured ? p.description : `Not set up in this deployment. ${p.description}`}
                >
                  {p.heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{publicChip}</td>
              <td colSpan={ordered.length} className="w-labels-all" title="Every provider is cleared for public, always">
                Everything
              </td>
            </tr>
            {rows.map((row) => {
              const now = ticked(row.label);
              return (
                <Fragment key={row.label}>
                  <tr className={row.problem ? "w-labels-has-problem" : undefined}>
                    <td>{row.chip}</td>
                    {ordered.map((p) => {
                      const on = now.includes(p.name);
                      const was = row.cleared.includes(p.name);
                      // A provider not set up is offered only to take back a clearance it still has.
                      const offered = editable && (p.configured || was);
                      const cls = [
                        "w-labels-cell",
                        on !== was && "w-labels-changed",
                        !p.configured && "w-labels-off",
                        p === services[0] && "w-labels-first-service",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <td key={p.name} className={cls} title={on !== was ? (on ? "Changed: will be cleared" : "Changed: will be taken back") : undefined}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!offered || busy}
                            onChange={(e) => toggle(row.label, p.name, e.target.checked)}
                            aria-label={`${p.heading} cleared for ${row.label}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                  {row.problem && (
                    <tr className="w-labels-problem">
                      <td colSpan={ordered.length + 1}>{row.problem}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {said.length > 0 && (
        <div className="w-col" style={{ gap: 4 }}>
          {said.map((s) => (
            <span key={s.label} className={s.error ? "w-said w-error" : "w-said"} role={s.error ? "alert" : "status"}>
              {s.error ? `${s.label}: ${s.error}` : s.notice}
            </span>
          ))}
        </div>
      )}

      {changed.length > 0 && (
        <div className="w-savebar">
          <span className="w-small" style={{ color: "var(--w-accent)", fontWeight: 500 }}>
            {changedCells} {changedCells === 1 ? "change" : "changes"} · {changed.length}{" "}
            {changed.length === 1 ? "label" : "labels"}
          </span>
          <span className="w-small w-muted">Each one ticked is sent the text of every agent run at the label.</span>
          <span className="w-spacer w-row">
            <button className="w-btn w-ghost w-sm" type="button" disabled={busy} onClick={() => setEdits({})}>
              Discard
            </button>
            <button className="w-btn w-pri w-sm" type="button" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
          </span>
        </div>
      )}
    </>
  );
}
