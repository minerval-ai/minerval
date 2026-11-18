import { toReleases, type Query } from "./to-releases";

// The list moved to /releases.
export default async function ShowingsPage({ searchParams }: { searchParams: Promise<Query> }) {
  toReleases("", await searchParams);
}
