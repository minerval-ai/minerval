"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { pageOf, type WorkIcon, type WorkSignal } from "../../lib/work-sections";
import type { WorkCounts } from "../../lib/work-counts";
import { Mark } from "../../app/Mark";
import { Icon } from "./icons";

// The sidebar of a members-only deployment (components/work/Shell.tsx places
// it). It marks the page being read from the address in the browser, because
// the shell is rendered once around every page; and it reads the counts
// beside its entries after the page has drawn (app/api/work/counts), so no
// page waits on them.

export interface SidebarSection {
  name: string | null;
  pages: Array<{ href: string; name: string; icon: WorkIcon; also?: string[]; signal?: WorkSignal }>;
}

export function Sidebar({
  sections,
  person,
  role,
  initials,
  tools,
}: {
  sections: SidebarSection[];
  person: string;
  role: string;
  initials: string;
  tools: React.ReactNode;
}) {
  const path = usePathname() ?? "";
  const router = useRouter();
  const here = pageOf(sections, path);
  const [counts, setCounts] = useState<WorkCounts | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/work/counts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => live && c && setCounts(c as WorkCounts))
      .catch(() => {});
    return () => {
      live = false;
    };
    // Read again on each page: a decision made on one page changes the counts.
  }, [path]);

  return (
    <nav className="w-side" aria-label="Workspace">
      <Link className="w-brand" href="/inbox">
        <Mark size={20} />
        <span className="w-brand-name">Minerval</span>
        {counts?.deployment && <span className="w-brand-dep" title={counts.deployment}>{counts.deployment}</span>}
      </Link>
      <form
        className="w-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get("q");
          if (typeof q === "string" && q.trim()) router.push(`/claims?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <Icon name="search" size={14} />
        <input name="q" type="search" placeholder="Search claims" aria-label="Search claims" />
      </form>
      {sections.map((s) => (
        <div key={s.name ?? "first"} style={{ display: "contents" }}>
          {s.name && <div className="w-nav-h">{s.name}</div>}
          {s.pages.map((p) => (
            <Link
              key={p.href}
              className="w-nav-a"
              href={p.href}
              aria-current={p.href === here ? "page" : undefined}
            >
              <Icon name={p.icon} />
              {p.name}
              {p.signal && <Signal signal={p.signal} counts={counts} />}
            </Link>
          ))}
        </div>
      ))}
      <div className="w-me">
        <Link className="w-me-who" href="/account" title="Your account">
          <span className="w-avatar">{initials}</span>
          <span style={{ minWidth: 0 }}>
            <span className="w-me-name">{person}</span>
            <span className="w-me-role">{role}</span>
          </span>
        </Link>
        <div className="w-me-tools">{tools}</div>
      </div>
    </nav>
  );
}

function Signal({ signal, counts }: { signal: WorkSignal; counts: WorkCounts | null }) {
  if (!counts) return null;
  if (signal === "health" || signal === "connections" || signal === "public_graph") {
    const state = counts[signal];
    if (!state || state === "ok") return null;
    const words = state === "bad" ? "Something has failed" : "Something needs attention";
    return <span className={`w-dot w-${state}`} title={words} aria-label={words} />;
  }
  const n = counts[signal];
  if (!n) return null;
  return <span className={signal === "inbox" ? "w-count w-hot" : "w-count"}>{n > 99 ? "99+" : n}</span>;
}
