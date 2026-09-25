"use client";

import { useState } from "react";
import s from "./replay.module.css";

// A JSON value, pretty and collapsible by key. Strings render verbatim
// (whitespace kept) so a prompt or a tool's text output reads as written.

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function Leaf({ v }: { v: unknown }) {
  if (typeof v === "string") {
    return v.includes("\n") || v.length > 80
      ? <pre className={s.jsonStr}>{v}</pre>
      : <span className={s.jsonStr}>&quot;{v}&quot;</span>;
  }
  if (v === null) return <span className={s.jsonNull}>null</span>;
  if (typeof v === "number" || typeof v === "boolean") return <span className={s.jsonNum}>{String(v)}</span>;
  if (v === undefined) return <span className={s.jsonNull}>undefined</span>;
  return <span>{String(v)}</span>;
}

function Node({ k, v, depth, open }: { k: string | null; v: unknown; depth: number; open: boolean }) {
  const [isOpen, setOpen] = useState(open);
  const composite = isPlain(v) || Array.isArray(v);
  if (!composite) {
    return (
      <div className={s.jsonRow}>
        {k !== null ? <span className={s.jsonKey}>{k}: </span> : null}
        <Leaf v={v} />
      </div>
    );
  }
  const entries: Array<[string, unknown]> = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  const brackets = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  return (
    <div className={s.jsonRow}>
      <button type="button" className={s.jsonToggle} onClick={() => setOpen((o) => !o)} aria-expanded={isOpen}>
        <span className={s.jsonCaret}>{isOpen ? "−" : "+"}</span>
        {k !== null ? <span className={s.jsonKey}>{k}: </span> : null}
        <span className={s.jsonNull}>{brackets[0]}{isOpen ? "" : ` ${entries.length} ${Array.isArray(v) ? "items" : "keys"} ${brackets[1]}`}</span>
      </button>
      {isOpen ? (
        <div className={s.jsonChildren}>
          {entries.map(([ck, cv]) => <Node key={ck} k={ck} v={cv} depth={depth + 1} open={depth < 1} />)}
          <span className={s.jsonNull}>{brackets[1]}</span>
        </div>
      ) : null}
    </div>
  );
}

export function JsonTree({ value, open = true }: { value: unknown; open?: boolean }) {
  if (value === undefined) return <span className={s.dim}>none</span>;
  return <div className={s.json}><Node k={null} v={value} depth={0} open={open} /></div>;
}
