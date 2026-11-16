"use client";

import { useState } from "react";
import { CopyButton } from "./CopyButton";

export interface CodeTab {
  label: string;
  code: string;
  /** A line under the code: what to expect, or what to do next. */
  note?: string;
}

// The same thing done several ways (one client per tab, or MCP beside REST).
export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [i, setI] = useState(0);
  const tab = tabs[i]!;
  return (
    <div className="dc-code">
      <div className="dc-tabs" role="tablist">
        {tabs.map((t, j) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={i === j}
            onClick={() => setI(j)}
          >
            {t.label}
          </button>
        ))}
        <span className="dc-tabs-copy">
          <CopyButton text={tab.code} />
        </span>
      </div>
      <pre role="tabpanel">{tab.code}</pre>
      {tab.note && <p className="dc-code-note">{tab.note}</p>}
    </div>
  );
}
