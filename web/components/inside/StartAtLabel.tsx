"use client";

import type { MyLabels } from "../../lib/admin-api";

// The label a conversation starts at, chosen before its first message: a
// granting conversation (and the mandate it drafts) or a conversation with
// the Assistant. It is the client-side twin of admin/LabelChoice, for a
// composer that sends with fetch rather than a form. Shown only where the
// deployment holds material at more than one label (must_choose); nothing is
// preselected, so nothing is filed where more people read it by leaving a
// field alone, and the API refuses a start with no label (LABEL_REQUIRED).
export function StartAtLabel({
  mine,
  value,
  onChange,
  what,
  disabled,
}: {
  mine: MyLabels | null | undefined;
  value: string;
  onChange: (label: string) => void;
  /** What the label decides here, in a sentence. */
  what: string;
  disabled?: boolean;
}) {
  if (!mine?.must_choose) return null;
  const chosen = mine.labels.find((l) => l.name === value);
  return (
    <div className="ask-label">
      <label>
        <span className="sc">Label</span>{" "}
        <select value={value} onChange={(e) => onChange(e.target.value)} required disabled={disabled}>
          <option value="" disabled>
            Choose a label
          </option>
          {mine.labels.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <small>
        {what} {chosen ? chosen.who_reads : ""}
      </small>
    </div>
  );
}

/** Whether a start may be sent: a label is chosen, or none is asked for. */
export function labelReady(mine: MyLabels | null | undefined, value: string): boolean {
  return !mine?.must_choose || value !== "";
}
