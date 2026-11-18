"use client";

import { useState } from "react";
import { WorkForm } from "@/components/work/WorkForm";
import { addLabelReadAction } from "../actions";

// "+ Add": a small form, opened in the row, to say a label also reads
// another. Choosing the label shows first who the pair widens reading for,
// followed through every label that reads this one (lib/label-chain.ts), so
// nobody widens access without seeing to whom.

export function AddRead({ label, candidates }: { label: string; candidates: Array<{ name: string; widens: string }> }) {
  const [chosen, setChosen] = useState("");
  const widens = candidates.find((c) => c.name === chosen)?.widens;
  return (
    <details className="w-labels-add">
      <summary className="w-btn w-ghost w-sm" style={{ height: 22, padding: "0 6px" }}>
        + Add
      </summary>
      <div className="w-labels-add-b">
        <WorkForm action={addLabelReadAction} submit="Add" inline small primary>
          <input type="hidden" name="label" value={label} />
          <select
            className="w-select"
            name="reads"
            required
            value={chosen}
            onChange={(e) => setChosen(e.currentTarget.value)}
            aria-label={`${label} may also read`}
            style={{ height: 26, width: "auto" }}
          >
            <option value="" disabled>
              Choose a label
            </option>
            {candidates.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </WorkForm>
        <span className="w-help" role="status" style={widens ? { color: "var(--w-warn)" } : undefined}>
          {widens ?? `Widens at once what holders of ${label}, and runs at it, read. Logged.`}
        </span>
      </div>
    </details>
  );
}
