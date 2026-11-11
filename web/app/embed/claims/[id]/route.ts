import type { NextRequest } from "next/server";
import { apiConfigured, fetchClaimCard } from "@/lib/api";
import { isEmbeddableId } from "@/lib/embed";
import { renderEmbedNotice, renderEmbedPage } from "@/lib/embed-render";

// The embed page: one claim's card and nothing else, for an iframe on someone
// else's site. A route handler rather than a page, so none of the site's
// shell comes with it: the root layout's masthead, footer and theme script,
// and the client runtime, would all load inside every host page's iframe.
// The response is one small self-contained document.
//
// It may be framed from anywhere (next.config.mjs sets frame-ancestors for
// /embed/*), is kept out of search (noindex), and tells its parent how tall
// it is so a host script can fit the frame (lib/embed-render.ts).

function html(body: string, status: number, cache: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cache,
      "X-Robots-Tag": "noindex",
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const asked = req.nextUrl.searchParams.get("theme");
  const opts = {
    theme: asked === "light" || asked === "dark" ? asked : null,
    origin: req.nextUrl.origin,
    now: new Date().toISOString(),
  } as const;

  if (!isEmbeddableId(id)) return html(renderEmbedNotice("not_found", "", opts), 404, "public, max-age=60");
  // An embed asserts what the live graph holds, so there is no sample-data
  // fallback (the citation route makes the same choice).
  if (!apiConfigured()) return html(renderEmbedNotice("unavailable", id, opts), 503, "no-store");
  try {
    const card = await fetchClaimCard(id);
    if (!card) return html(renderEmbedNotice("not_found", id, opts), 404, "public, max-age=60");
    // Short, so a reassessment reaches embeds within minutes; the card says
    // "as of" for the copies that outlive it.
    return html(renderEmbedPage(card, opts), 200, "public, max-age=300");
  } catch {
    return html(renderEmbedNotice("unavailable", id, opts), 503, "no-store");
  }
}
