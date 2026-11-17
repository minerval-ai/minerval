"use client";

import { useState } from "react";

// An identity or other value a person is asked to pass on: shown whole, in a
// field that selects it on a click, with a button that copies it.
export function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="w-row" style={{ flexWrap: "nowrap" }}>
      <input
        className="w-input w-mono"
        readOnly
        value={value}
        aria-label="Your sign-in ID"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className="w-btn"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
