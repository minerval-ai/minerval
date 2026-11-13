import { NextResponse } from "next/server";
import { auth } from "../../../../../../auth";
import { AccountApiError } from "@/lib/account-api";
import { takePackageFile } from "@/lib/inside-api";

// One signed package as a file, for a person to carry to the public graph
// where the network does not join the two (docs/published-pages.md,
// "Sending"). Taking the file is an act: the API records who took it and
// when, so this answers a form's POST and never a link's GET, and a page
// that is only opened takes nothing. Only a members-only build has this
// route; the API asks for the permission to direct.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.externalId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const { id } = await params;
  try {
    const taken = await takePackageFile(session.externalId, id);
    return new NextResponse(JSON.stringify(taken.package, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${taken.file_name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const status = err instanceof AccountApiError ? err.status : 502;
    return NextResponse.json({ error: err instanceof Error ? err.message : "The package could not be taken." }, { status });
  }
}
