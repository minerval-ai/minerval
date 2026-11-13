import { NextResponse } from "next/server";
import { auth } from "../../../../../../auth";
import { pathSegment } from "@/lib/account-api";

// One file into an open file set (PUT /file-sets/:id/files/<path>;
// docs/file-sets.md). The browser's bytes are handed to the API as a stream,
// as they arrive: nothing here reads the file into memory or parses it, so a
// file of any size and type passes through, and the API hashes it as it
// writes it to the deployment's store. The answer is the API's own: the
// file's size and SHA-256, or its refusal in its words.
//
// Only a members-only build has this route. The API asks for the permission
// to direct and a signed-in person, which this request is: it carries the
// web tier's key and names the person in the server's own session.

const BASE = process.env.MINERVAL_API_URL?.replace(/\/$/, "");
const KEY = process.env.MINERVAL_API_KEY;

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const session = await auth();
  if (!session?.externalId) return NextResponse.json({ error: "You are not signed in." }, { status: 401 });
  if (!BASE) return NextResponse.json({ error: "This site is not connected to the deployment's API." }, { status: 503 });
  const { id, path } = await params;
  let target: string;
  try {
    target = `${BASE}/file-sets/${pathSegment(id)}/files/${path.map((part) => pathSegment(part)).join("/")}`;
  } catch {
    return NextResponse.json({ error: "A file's path cannot have a part that is . or .." }, { status: 400 });
  }
  const res = await fetch(target, {
    method: "PUT",
    headers: {
      ...(KEY ? { "x-api-key": KEY } : {}),
      "x-acting-user": session.externalId,
      "content-type": "application/octet-stream",
      ...(req.headers.get("content-length") ? { "content-length": req.headers.get("content-length")! } : {}),
    },
    body: req.body,
    // A request whose body is a stream says so.
    duplex: "half",
    cache: "no-store",
  } as RequestInit & { duplex: "half" });
  const body = await res.text();
  return new NextResponse(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}
