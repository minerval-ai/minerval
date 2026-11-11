import { apiConfigured, fetchClaimCard } from "@/lib/api";
import { isEmbeddableId } from "@/lib/embed";
import { renderBadge, renderBadgeNotice } from "@/lib/embed-render";

// The badge: a claim's judgment in one line, as a small image for a README
// or a forum post. It still says the judgment whole (status, confidence,
// dispute), and its title carries the "as of" date.

function svg(body: string, status: number, cache: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": cache,
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isEmbeddableId(id)) return svg(renderBadgeNotice("not_found"), 404, "public, max-age=60");
  if (!apiConfigured()) return svg(renderBadgeNotice("unavailable"), 503, "no-store");
  try {
    const card = await fetchClaimCard(id);
    if (!card) return svg(renderBadgeNotice("not_found"), 404, "public, max-age=60");
    // Image proxies cache what they fetch; keep it short so a reassessment
    // shows within minutes.
    return svg(renderBadge(card, new Date().toISOString()), 200, "public, max-age=600");
  } catch {
    return svg(renderBadgeNotice("unavailable"), 503, "no-store");
  }
}
