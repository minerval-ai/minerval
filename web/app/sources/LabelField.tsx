"use client";

import { useState } from "react";
import { Tip } from "@/components/work/ui";

// Choosing the label of something new (a source, a file set, a connection),
// in the workspace's form style. The same rule as components/admin/LabelChoice:
// asked only where the deployment holds material at more than one label,
// nothing preselected, the labels the person reads, each with who reads it in
// the API's own words, shown under the field for the one chosen.

export interface LabelOption {
  name: string;
  who_reads: string;
}

export function LabelField({
  mine,
  tip,
}: {
  mine: { must_choose: boolean; labels: LabelOption[] };
  /** What the label decides for this thing, on hover. */
  tip: string;
}) {
  const [chosen, setChosen] = useState("");
  if (!mine.must_choose) return null;
  const who = mine.labels.find((l) => l.name === chosen)?.who_reads;
  return (
    <div className="w-field">
      <label htmlFor="w-label-field" className="w-row" style={{ gap: 6 }}>
        Label <Tip>{tip}</Tip>
      </label>
      <select
        id="w-label-field"
        name="label"
        className="w-select"
        required
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
      >
        <option value="" disabled>
          Choose a label
        </option>
        {mine.labels.map((l) => (
          <option key={l.name} value={l.name}>
            {l.name}
          </option>
        ))}
      </select>
      <span className="w-help">{who ?? "Required here: this deployment holds material at more than one label."}</span>
    </div>
  );
}
