"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { pageOf } from "./inside/nav";

// The band's links (components/MembersBand.tsx), with the section of the page
// being read marked. It reads the address in the browser because the gate
// that places the band is rendered once for every page.
export function MembersBandLinks({
  sections,
}: {
  sections: Array<{
    name: string;
    href: string;
    pages: Array<{ href: string }>;
  }>;
}) {
  const path = usePathname() ?? "";
  const here = pageOf(sections, path);
  return (
    <nav className="members-band" aria-label="This deployment">
      {sections.map((s) => (
        <Link key={s.name} href={s.href} aria-current={s.pages.some((p) => p.href === here) ? "true" : undefined}>
          {s.name}
        </Link>
      ))}
    </nav>
  );
}
