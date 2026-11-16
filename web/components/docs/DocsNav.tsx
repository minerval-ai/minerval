"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { docsNavMatch, type DocsNavGroup } from "@/lib/docs-nav";

// The documentation's left sidebar. On a wide screen it is always open and
// sticks beside the page; on a narrow one it folds into a "Docs menu"
// disclosure above the page, closed by default so the page's own heading is
// the first thing read, and closes again when a page is chosen.
export function DocsNav({ groups }: { groups: DocsNavGroup[] }) {
  const pathname = usePathname() ?? "/docs";
  const current = docsNavMatch(pathname);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    setOpen(!mq.matches);
    const onChange = (e: MediaQueryListEvent) => setOpen(!e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(max-width: 860px)").matches) setOpen(false);
  }, [pathname]);

  return (
    <nav className="docs-nav" aria-label="Documentation">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="sc docs-nav-toggle">Docs menu</summary>
        {groups.map((g) => (
          <div className="docs-nav-group" key={g.title}>
            <p className="sc docs-nav-title">{g.title}</p>
            <ul>
              {g.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={item.href === current ? "on" : undefined}
                    aria-current={item.href === current ? "page" : undefined}
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </nav>
  );
}
