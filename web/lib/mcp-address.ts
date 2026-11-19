import "server-only";
import { membersOnly } from "./members";

// The address an agent connects to over MCP, as the pages that tell people
// how to connect show it (/docs/connect, the home page's MCP tab).
//
// On the public graph it is fixed, and the pages stay static. A members-only
// deployment has its own: the API's public address (hosting.api_base_url,
// PUBLIC_API_BASE_URL) followed by /mcp. The API publishes it as the
// `resource` of its OAuth discovery document, which is open to anyone
// (src/routes/oauth.ts), so it is read from there: the page shows exactly
// what a connecting client will be told, and nothing has to be set twice.
//
// It is not the web app's own address. The web app of a members-only
// deployment refuses every request from someone not signed in
// (proxy.members.ts), and a client registering itself is not signed in yet.
// That is the mistake this is here to prevent: an administrator pastes the
// address they sign in at into Claude.ai, and the connector cannot register.

export const PUBLIC_API_BASE = "https://api.claimgraph.io";

export interface McpAddress {
  /** The API's public address, without a trailing slash; null when it could not be read. */
  apiBase: string | null;
  /** apiBase + "/mcp"; null when it could not be read. */
  mcpUrl: string | null;
  /**
   * Why a client outside this network cannot connect at this address, in one
   * sentence for whoever set it; null when nothing is wrong with it.
   */
  problem: string | null;
}

/**
 * Whether a host can only be reached from this machine or its own network:
 * a loopback or private address, or a name with no dot in it (a container's
 * name, such as "api"). The API's own preflight check `mcp_address` uses the
 * same rule (src/preflight-deployment.ts).
 */
export function hostIsLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return host === "::1" || /^(fc|fd|fe80:)/.test(host);
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return !host.includes(".");
}

/** What is wrong with `base` as the address hosted clients connect to; null when nothing is. */
export function mcpAddressProblem(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `The API's public address is "${base}", which is not an address.`;
  }
  if (hostIsLocal(url.hostname)) {
    return `The API's public address is ${url.origin}, which can only be reached from the machine or network the API runs on, so a hosted client such as Claude.ai cannot reach it.`;
  }
  if (url.protocol !== "https:") {
    return `The API's public address is ${url.origin}, which is not HTTPS. Hosted clients such as Claude.ai connect only over HTTPS.`;
  }
  if (url.origin === PUBLIC_API_BASE) {
    return `The API's public address is ${url.origin}, which is public Minerval's API, not this deployment's.`;
  }
  return null;
}

export async function mcpAddress(): Promise<McpAddress> {
  if (!membersOnly()) return { apiBase: PUBLIC_API_BASE, mcpUrl: `${PUBLIC_API_BASE}/mcp`, problem: null };
  const base = process.env.MINERVAL_API_URL?.replace(/\/$/, "");
  if (!base) return { apiBase: null, mcpUrl: null, problem: "The web app is not told where its API is (MINERVAL_API_URL)." };
  try {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { cache: "no-store" });
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    const body = (await res.json()) as { resource?: unknown };
    if (typeof body.resource !== "string") throw new Error("it named no resource");
    const mcpUrl = body.resource.replace(/\/$/, "");
    const apiBase = mcpUrl.replace(/\/mcp$/, "");
    return { apiBase, mcpUrl, problem: mcpAddressProblem(apiBase) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { apiBase: null, mcpUrl: null, problem: `The API's discovery document could not be read (${why}).` };
  }
}
