import { toReleases, type Query } from "../to-releases";

// One release's page moved to /releases/:id.
export default async function ShowingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Query> }) {
  const { id } = await params;
  toReleases(`/${encodeURIComponent(id)}`, await searchParams);
}
