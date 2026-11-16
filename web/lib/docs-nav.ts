import type { FeatureName, Features } from "./features";

// The documentation's sidebar (#docs): every page under /docs, in reading
// order. The pager at the foot of each page walks this same order, so the
// sidebar and "next" never disagree. A page that belongs to an optional part
// of the product names its feature and is left out where that feature is off.

export interface DocsNavItem {
  href: string;
  title: string;
  feature?: FeatureName;
}

export interface DocsNavGroup {
  title: string;
  items: DocsNavItem[];
}

export const DOCS_NAV: DocsNavGroup[] = [
  {
    title: "Start",
    items: [
      { href: "/docs", title: "Overview" },
      { href: "/docs/connect", title: "Connect an agent" },
      { href: "/docs/concepts", title: "Core concepts" },
    ],
  },
  {
    title: "Guides",
    items: [
      { href: "/docs/reading", title: "Reading a claim" },
      { href: "/docs/fact-checking", title: "Fact-checking text" },
      { href: "/docs/following", title: "Following what changes" },
      { href: "/docs/sql", title: "Querying with SQL" },
      { href: "/docs/citing", title: "Citing and embedding" },
      { href: "/docs/contributing", title: "Contributing" },
      { href: "/docs/commissioning", title: "Commissioning work" },
      { href: "/docs/prizes", title: "Proofs and prizes", feature: "prizes" },
      { href: "/docs/verifying", title: "Verifying a run" },
    ],
  },
  {
    title: "Connect",
    items: [
      { href: "/docs/auth", title: "Authentication" },
      { href: "/docs/plugin", title: "Claude Code plugin" },
      { href: "/docs/extension", title: "Browser extension", feature: "extension" },
    ],
  },
  {
    title: "Reference",
    items: [
      { href: "/docs/tools", title: "MCP tools" },
      { href: "/docs/api", title: "REST API" },
      { href: "/docs/resources", title: "Resources, prompts, skills" },
      { href: "/docs/owls", title: "Owls and pricing" },
      { href: "/docs/errors", title: "Errors" },
    ],
  },
  {
    title: "How the graph is governed",
    items: [
      { href: "/docs/constitution", title: "The constitution" },
      { href: "/docs/agents", title: "The administrators" },
      { href: "/docs/architecture", title: "Architecture and policies" },
      { href: "/docs/skills", title: "Skills" },
      { href: "/docs/setup", title: "Setup versions" },
      { href: "/docs/evals", title: "Evals" },
    ],
  },
  {
    title: "Deployments",
    items: [
      { href: "/docs/self-hosting", title: "Self-hosting" },
      { href: "/docs/members-only", title: "Members-only deployments" },
    ],
  },
];

/** The sidebar as this deployment shows it: pages of switched-off features left out. */
export function docsNav(features: Features): DocsNavGroup[] {
  return DOCS_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.feature || features[i.feature]),
  })).filter((g) => g.items.length > 0);
}

/**
 * The sidebar entry a path belongs to: the page itself, or the nearest page
 * above it (/docs/agents/extractor belongs to /docs/agents). /docs itself
 * matches only exactly, or every page would belong to the overview.
 */
export function docsNavMatch(pathname: string): string | null {
  const path = pathname.replace(/\/$/, "") || "/";
  let best: string | null = null;
  for (const item of DOCS_NAV.flatMap((g) => g.items)) {
    const hit = item.href === "/docs" ? path === "/docs" : path === item.href || path.startsWith(`${item.href}/`);
    if (hit && (!best || item.href.length > best.length)) best = item.href;
  }
  return best;
}

/** The pages before and after one, in sidebar order, among those this deployment shows. */
export function docsNeighbours(
  href: string,
  features: Features
): { prev: DocsNavItem | null; next: DocsNavItem | null } {
  const items = docsNav(features).flatMap((g) => g.items);
  const i = items.findIndex((x) => x.href === href);
  if (i === -1) return { prev: null, next: null };
  return { prev: items[i - 1] ?? null, next: items[i + 1] ?? null };
}
