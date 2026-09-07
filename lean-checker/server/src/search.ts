/**
 * `POST /v1/search`: a proxy to a Loogle instance pinned to the same
 * Mathlib (design section 6.1). The service never searches the public
 * internet on its own: the URL is configuration, and when it is not
 * configured the route says so plainly instead of guessing a host.
 */

export interface SearchHit {
  name: string;
  type: string;
  module: string;
  doc?: string;
}

export interface SearchResult {
  ok: boolean;
  backend: "pattern" | "natural";
  query: string;
  hits: SearchHit[];
  count: number;
  suggestions: string[];
  error?: string;
  header?: string;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Loogle's JSON endpoint is `GET /json?q=<query>` and answers
 * `{header, hits: [{name, type, module, doc}], count, suggestions, error}`.
 */
export async function searchLoogle(
  fetchImpl: FetchLike,
  baseUrl: string,
  query: string,
  limit: number,
  timeoutMs: number
): Promise<SearchResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/json?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      return { ok: false, backend: "pattern", query, hits: [], count: 0, suggestions: [], error: `loogle answered ${res.status}` };
    }
    const body = (await res.json()) as {
      header?: string;
      hits?: Array<{ name?: string; type?: string; module?: string; doc?: string }>;
      count?: number;
      suggestions?: string[];
      error?: string;
    };
    const hits: SearchHit[] = (body.hits ?? []).slice(0, limit).map((h) => ({
      name: h.name ?? "",
      type: h.type ?? "",
      module: h.module ?? "",
      ...(h.doc ? { doc: h.doc } : {}),
    }));
    const result: SearchResult = {
      ok: !body.error,
      backend: "pattern",
      query,
      hits,
      count: body.count ?? hits.length,
      suggestions: body.suggestions ?? [],
    };
    if (body.error) result.error = body.error;
    if (body.header) result.header = body.header;
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, backend: "pattern", query, hits: [], count: 0, suggestions: [], error: `loogle unreachable: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
