import { toReleases, type Query } from "../../../to-releases";

// One page under a release moved to /releases/:id/pages/:pageId.
export default async function ShownPagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; pageId: string }>;
  searchParams: Promise<Query>;
}) {
  const { id, pageId } = await params;
  toReleases(`/${encodeURIComponent(id)}/pages/${encodeURIComponent(pageId)}`, await searchParams);
}
