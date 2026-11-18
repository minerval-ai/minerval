import { toReleases, type Query } from "../to-releases";

// Setting a flow of pages moved to /releases/new.
export default async function OldNewReleaseAddress({ searchParams }: { searchParams: Promise<Query> }) {
  toReleases("/new", await searchParams);
}
