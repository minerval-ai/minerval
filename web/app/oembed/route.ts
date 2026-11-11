import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiConfigured, fetchClaimCard } from "@/lib/api";
import {
  EMBED_DEFAULT_WIDTH, claimIdFromPageUrl, estimateEmbedHeight, iframeSnippet,
} from "@/lib/embed";

// oEmbed (oembed.com) for claim pages: a publishing tool given a claim's URL
// asks here and gets the iframe to place. JSON only; the answer is a "rich"
// embed whose html is the same iframe the claim page's Embed panel offers.

const CACHE_AGE = 600;

function error(status: number, message: string) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

// A consumer's limit, when it gave a usable one.
function limit(raw: string | null): number | null {
  if (!raw || !/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const format = q.get("format") ?? "json";
  if (format !== "json") return error(501, "only format=json is implemented");
  const url = q.get("url");
  if (!url) return error(400, "url is required: the address of a claim page");

  const origin = req.nextUrl.origin;
  const id = claimIdFromPageUrl(url, [origin]);
  if (!id) return error(404, "url is not a claim page on this site");
  if (!apiConfigured()) return error(503, "not connected to the live graph");

  let card;
  try {
    card = await fetchClaimCard(id);
  } catch {
    return error(503, "the claim could not be read; try again shortly");
  }
  if (!card) return error(404, "no claim at this address");

  const maxwidth = limit(q.get("maxwidth"));
  const maxheight = limit(q.get("maxheight"));
  // The card's usual width, or the consumer's limit where that is narrower.
  const width = maxwidth == null ? EMBED_DEFAULT_WIDTH : Math.min(maxwidth, EMBED_DEFAULT_WIDTH);
  const fitted = estimateEmbedHeight(card.text.length, width, card.kind);
  // Where the limit is shorter than the card needs, the frame scrolls.
  const height = maxheight == null ? fitted : Math.min(fitted, maxheight);
  const { html } = iframeSnippet(origin, card.id, card.text, { width, height });

  return NextResponse.json(
    {
      version: "1.0",
      type: "rich",
      title: card.text,
      provider_name: "Minerval",
      provider_url: origin,
      cache_age: CACHE_AGE,
      html,
      width,
      height,
    },
    {
      headers: {
        "Cache-Control": `public, max-age=${CACHE_AGE}`,
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
