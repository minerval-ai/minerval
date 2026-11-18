import type { Metadata } from "next";
import { viewer } from "@/components/admin/access";
import { ReleasesView, type ReleasesQuery } from "./ReleasesView";

export const metadata: Metadata = { title: "Releases · Minerval" };
export const dynamic = "force-dynamic";

// Every release the reader may see (GET /releases; docs/releasing-a-page.md):
// pages asked to be released from a label they read, and pages released to a label
// they read, or outside. The list itself is ReleasesView, which
// /releases/new also draws behind its drawer.

export default async function ReleasesPage({ searchParams }: { searchParams: Promise<ReleasesQuery> }) {
  const who = await viewer();
  if (!who) return null;
  return <ReleasesView who={who} query={await searchParams} />;
}
