import { toReleases, type Query } from "./to-releases";

// The list moved to /releases.
export default async function OldReleasesAddress({ searchParams }: { searchParams: Promise<Query> }) {
  toReleases("", await searchParams);
}
