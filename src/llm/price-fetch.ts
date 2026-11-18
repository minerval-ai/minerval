/**
 * Reading the two price lists (price-sources.ts) over the network. Kept
 * apart from that module so its rules stay pure, and from the service so
 * the snapshot script can read the lists without a database.
 *
 * Both lists are public: the requests carry no key and nothing of this
 * deployment's, so no label's text goes anywhere by them.
 */
import {
  LITELLM_PRICES_URL,
  OPENROUTER_MODELS_URL,
  parseLiteLlmPrices,
  parseOpenRouterModels,
  type Listing,
  type PriceSourceName,
} from "./price-sources.js";

export interface FetchedListings {
  /** The lists that were read. */
  listings: Listing[];
  /** The lists that could not be, and why. */
  failures: Array<{ source: PriceSourceName; error: string }>;
}

const SOURCES: Array<{ source: PriceSourceName; url: string; parse: (body: unknown) => Listing["prices"] }> = [
  { source: "openrouter", url: OPENROUTER_MODELS_URL, parse: parseOpenRouterModels },
  { source: "litellm", url: LITELLM_PRICES_URL, parse: parseLiteLlmPrices },
];

/**
 * Read both lists. One that fails is reported, not thrown: the other still
 * prices new models, and a price in force waits for both.
 */
export async function fetchPriceListings(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000
): Promise<FetchedListings> {
  const results = await Promise.all(
    SOURCES.map(async ({ source, url, parse }) => {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText}`);
        const prices = parse(await res.json());
        if (prices.size === 0) throw new Error(`${url} listed no prices for Anthropic or OpenAI models`);
        return { listing: { source, prices } };
      } catch (err) {
        return { failure: { source, error: err instanceof Error ? err.message : String(err) } };
      }
    })
  );
  return {
    listings: results.flatMap((r) => ("listing" in r && r.listing ? [r.listing] : [])),
    failures: results.flatMap((r) => ("failure" in r && r.failure ? [r.failure] : [])),
  };
}
