"use client";

import { useMemo, useState } from "react";
import type { CatalogGroup, ToolCost } from "@/lib/tool-catalog";

const COST_LABEL: Record<ToolCost, string> = {
  read: "free",
  write: "free write",
  charged: "charged",
  escrow: "escrow",
};

const FILTERS: { key: ToolCost | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "read", label: "Free reads" },
  { key: "write", label: "Writes" },
  { key: "charged", label: "Charged" },
  { key: "escrow", label: "Escrow" },
];

// The catalog, filterable by words and by what a call costs. Every tool is in
// the server-rendered page; filtering only hides rows.
export function ToolList({ groups }: { groups: CatalogGroup[] }) {
  const [q, setQ] = useState("");
  const [cost, setCost] = useState<ToolCost | "all">("all");
  const all = useMemo(() => groups.flatMap((g) => g.tools), [groups]);
  const count = (k: ToolCost | "all") => (k === "all" ? all.length : all.filter((t) => t.cost === k).length);
  const words = q.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      tools: g.tools.filter(
        (t) =>
          (cost === "all" || t.cost === cost) &&
          (!words || `${t.name} ${t.summary} ${t.route ?? ""}`.toLowerCase().includes(words))
      ),
    }))
    .filter((g) => g.tools.length > 0);

  return (
    <>
      <div className="dc-cat-controls">
        <input
          id="tool-filter"
          type="search"
          placeholder="Filter by name, description or route"
          aria-label="Filter tools"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="dc-chip"
            aria-pressed={cost === f.key}
            onClick={() => setCost(f.key)}
          >
            {f.label}
            <span>{count(f.key)}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && (
        <p className="dc-small">
          No tool matches. Try a word for what you want to do, such as &ldquo;mandate&rdquo; or &ldquo;source&rdquo;.
        </p>
      )}
      {shown.map((g) => (
        <section className="dc-tgroup" key={g.key}>
          <h2 id={g.key}>
            {g.title} <span>{g.tools.length}</span>
          </h2>
          {g.tools.map((t) => (
            <div className="dc-tool" id={t.name} key={t.name}>
              <div className="dc-tool-name">
                {t.name}
                <span className={`dc-pill dc-${t.cost}`}>{COST_LABEL[t.cost]}</span>
              </div>
              <div className="dc-tool-desc">
                {t.summary}
                <div className="dc-tool-meta">
                  {t.route ?? "written for MCP"}
                  {t.params.length > 0 && (
                    <>
                      {" · ("}
                      {t.params.map((p, i) => (
                        <span key={p.name}>
                          {i > 0 && ", "}
                          {p.required ? <b>{p.name}</b> : `${p.name}?`}
                        </span>
                      ))}
                      {")"}
                    </>
                  )}
                  {t.fields && " · fields"}
                </div>
              </div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
