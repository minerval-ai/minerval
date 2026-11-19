import { auth } from "@/auth";
import { membersOnly } from "@/lib/members";

// One batch of the public graph's mirror feed, downloaded by a member of an
// organization to carry to one of its deployments the network does not join
// (docs/organizations.md, "Connecting by hand"): the next batch after the one
// named, exactly as signed, as a file. The API checks that the person is a
// member and the deployment holds read_feed, and logs the pull.

const BASE = process.env.MINERVAL_API_URL?.replace(/\/$/, "");
const KEY = process.env.MINERVAL_API_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.externalId || membersOnly() || !BASE) return new Response("Sign in on minerval.ai first.", { status: 401 });
  const { id } = await params;
  const url = new URL(request.url);
  const deployment = url.searchParams.get("deployment") ?? "";
  const after = Math.max(0, Math.trunc(Number(url.searchParams.get("after") ?? 0)) || 0);
  if (!UUID.test(id) || !UUID.test(deployment)) return new Response("No such deployment.", { status: 404 });
  const res = await fetch(`${BASE}/organizations/${id}/deployments/${deployment}/feed?after=${after}`, {
    headers: { ...(KEY ? { "x-api-key": KEY } : {}), "x-acting-user": session.externalId },
    cache: "no-store",
  });
  if (res.status === 204) {
    return new Response(`The feed has no batch after ${after}: the deployment is up to date.`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (!res.ok) {
    let words = `minerval.ai answered ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") words = body.error;
    } catch {
      // keep the plain words
    }
    return new Response(words, { status: res.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": res.headers.get("content-disposition") ?? "attachment",
      "cache-control": "no-store",
    },
  });
}
