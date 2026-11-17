import type { Metadata } from "next";
import { viewer } from "@/components/admin/access";
import { ShowingsView, type ShowingsQuery } from "./ShowingsView";

export const metadata: Metadata = { title: "Showings · Minerval" };
export const dynamic = "force-dynamic";

// Every showing the reader may see (GET /showings; docs/showing-a-page.md):
// pages asked to be shown from a label they read, and pages shown to a label
// they read, or outside. The list itself is ShowingsView, which
// /showings/new also draws behind its drawer.

export default async function ShowingsPage({ searchParams }: { searchParams: Promise<ShowingsQuery> }) {
  const who = await viewer();
  if (!who) return null;
  return <ShowingsView who={who} query={await searchParams} />;
}
