/**
 * The MCP client for connections (src/connections.ts): the deployment as a
 * client of a server an organization runs over its own data.
 *
 * It generalizes the one fixed client the Steward already had, for Elicit
 * (llm/tools/elicit-tools.ts): the same SDK client over the same transport,
 * the server's own tool schemas used as given, and a failure that comes
 * back as a value the caller reports, never a throw that ends an agent's
 * run. Two things differ, each for a reason.
 *
 * It keeps no connection between calls. Elicit's client is opened once and
 * reused, and a call that fails on a dead connection is simply made again
 * by the next run. Here a call that failed in flight must not be sent twice
 * by this code: the deployment cannot prove a connection's tool only reads,
 * so a repeat could do twice whatever the tool does. Opening a connection
 * for each call means there is no stale one to fail on, and a failure is
 * reported to the agent, which decides whether to ask again.
 *
 * And nothing here is priced. Elicit bills per call, so its executor checks
 * the run's budget. A connection's calls cost the organization's own system
 * and no owls; what bounds them is the rate its administrator may set
 * (services/reading-service.ts).
 *
 * The credential is read from the environment variable the connection
 * names, at the moment of the call, and goes nowhere but the request's
 * header. It is never stored, logged or returned.
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  credentialHeaders,
  isConnectionTransport,
  isCredentialEnvName,
  type ServerToolDefinition,
} from "../connections.js";
import { sanitizeStoredText } from "./document-text.js";

/** What the client needs to know of a connection to reach its server. */
export interface ConnectionTarget {
  transport: string;
  url: string;
  /** The name of the environment variable that holds the credential; null when the server asks for none. */
  credentialEnv: string | null;
  credentialHeader: string;
  timeoutSeconds: number;
}

/**
 * Why a server could not be read. `kind` is for the code and the
 * administrator's view; `message` is one clause that completes "the
 * connection could not be read: ...".
 */
export interface ConnectionFailure {
  kind: "credential_missing" | "credential_refused" | "no_answer" | "unreachable" | "failed";
  message: string;
}

export type Listed = { ok: true; tools: ServerToolDefinition[] } | { ok: false; failure: ConnectionFailure };

export type Called =
  | {
      ok: true;
      /** The server answered with an error of its own: the text is what it said. */
      isError: boolean;
      /** The result as text, as it will be stored. */
      text: string;
    }
  | { ok: false; failure: ConnectionFailure };

/** A server's tool list comes in pages; this many is far past any real server and stops a loop. */
const MAX_TOOL_LIST_PAGES = 50;

/** An error's message is shown to an agent and an administrator, so it is kept to a line. */
const FAILURE_MESSAGE_MAX_CHARS = 300;

/**
 * Whether the environment holds a connection's credential. True for a
 * connection that needs none. Only ever a yes or a no: the value is not
 * read here.
 */
export function credentialPresent(credentialEnv: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (credentialEnv === null) return true;
  return (env[credentialEnv] ?? "").length > 0;
}

function transportFor(target: ConnectionTarget): { ok: true; transport: Transport } | { ok: false; failure: ConnectionFailure } {
  let headers: Record<string, string> = {};
  if (target.credentialEnv !== null) {
    // The name was checked when the connection was saved; checked again
    // here so that a row written any other way cannot name another secret.
    const credential = isCredentialEnvName(target.credentialEnv) ? (process.env[target.credentialEnv] ?? "") : "";
    if (!credential) {
      return {
        ok: false,
        failure: {
          kind: "credential_missing",
          message: `the environment variable ${target.credentialEnv}, which holds its credential, is not set where the deployment runs`,
        },
      };
    }
    headers = credentialHeaders(target.credentialHeader, credential);
  }
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    return { ok: false, failure: { kind: "failed", message: "its address is not a URL" } };
  }
  if (!isConnectionTransport(target.transport)) {
    return { ok: false, failure: { kind: "failed", message: `this deployment does not speak the transport "${target.transport}"` } };
  }
  // A redirect is refused, not followed: the credential is for the address
  // an administrator gave, and a server that answers "go elsewhere" would
  // otherwise be handed it at an address nobody chose.
  const requestInit: RequestInit = { headers, redirect: "error" };
  if (target.transport === "sse") {
    return {
      ok: true,
      transport: new SSEClientTransport(url, {
        requestInit,
        // The stream itself is opened with a GET the SDK makes through
        // EventSource, which takes its headers from here.
        eventSourceInit: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              redirect: "error",
              headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
            }),
        },
      }),
    };
  }
  return { ok: true, transport: new StreamableHTTPClientTransport(url, { requestInit }) };
}

/** An error from the SDK or the network as a failure an agent and an administrator can read. */
function failureOf(err: unknown, timeoutSeconds: number): ConnectionFailure {
  const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const code = e?.code;
  const raw = typeof e?.message === "string" ? e.message : String(err);
  const brief = raw.replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_MAX_CHARS);
  if (code === 401 || code === 403 || /\b(401|403)\b|unauthorized|forbidden/i.test(raw)) {
    return {
      kind: "credential_refused",
      message: `the system refused the deployment's credential (${code === 401 || code === 403 ? `HTTP ${code}` : brief}); it may have expired or been withdrawn`,
    };
  }
  // The SDK's RequestTimeout.
  if (code === -32001 || /timed out|timeout/i.test(raw)) {
    return { kind: "no_answer", message: `the system did not answer within ${timeoutSeconds} seconds` };
  }
  const causeCode = typeof e?.cause?.code === "string" ? e.cause.code : null;
  if (causeCode || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|network/i.test(raw)) {
    return {
      kind: "unreachable",
      message: `the system could not be reached${causeCode ? ` (${causeCode})` : ""}`,
    };
  }
  return { kind: "failed", message: brief || "the call failed" };
}

/** Open a connection, do one thing over it, and close it, whatever happened. */
async function withClient<T>(
  target: ConnectionTarget,
  work: (client: Client, timeoutMs: number) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; failure: ConnectionFailure }> {
  const made = transportFor(target);
  if (!made.ok) return made;
  const timeoutMs = Math.max(1, target.timeoutSeconds) * 1000;
  const client = new Client({ name: "minerval-connection", version: "0.1.0" });
  try {
    await client.connect(made.transport, { timeout: timeoutMs });
    return { ok: true, value: await work(client, timeoutMs) };
  } catch (err) {
    return { ok: false, failure: failureOf(err, target.timeoutSeconds) };
  } finally {
    // A server that keeps sessions is told this one is over, so that a
    // connection opened for each call does not leave one behind each time.
    if (made.transport instanceof StreamableHTTPClientTransport) {
      await made.transport.terminateSession().catch(() => undefined);
    }
    await client.close().catch(() => undefined);
  }
}

/** The tools the server lists now, each as the server defines it. */
export async function listServerTools(target: ConnectionTarget): Promise<Listed> {
  const result = await withClient(target, async (client, timeoutMs) => {
    const tools: ServerToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
      for (const t of listed.tools) {
        tools.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          annotations: t.annotations ? ({ ...t.annotations } as Record<string, unknown>) : null,
        });
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return tools;
  });
  return result.ok ? { ok: true, tools: result.value } : result;
}

type ContentBlock = {
  type: string;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  uri?: unknown;
  resource?: { uri?: unknown; text?: unknown; blob?: unknown; mimeType?: unknown };
};

/**
 * A result's content as the text that is stored: text blocks as they are,
 * an embedded resource's text, and one line for anything that is not text
 * (an image, a blob, a link), naming its type, size and SHA-256 so the
 * record says it was returned without holding its bytes.
 */
export function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const blocks = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
  const parts: string[] = [];
  const binary = (kind: string, mime: unknown, base64: unknown): string => {
    const bytes = typeof base64 === "string" ? Buffer.from(base64, "base64") : Buffer.alloc(0);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return `[${kind} returned and not kept: ${typeof mime === "string" ? mime : "unknown type"}, ${bytes.byteLength} bytes, sha256 ${digest}]`;
  };
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && typeof block.resource?.text === "string") parts.push(block.resource.text);
    else if (block.type === "resource") parts.push(binary("resource", block.resource?.mimeType, block.resource?.blob));
    else if (block.type === "image" || block.type === "audio") parts.push(binary(block.type, block.mimeType, block.data));
    else if (block.type === "resource_link") parts.push(`[link returned: ${typeof block.uri === "string" ? block.uri : "no address"}]`);
    else parts.push(`[${block.type} returned and not kept]`);
  }
  // A server may answer in structured content alone.
  if (parts.length === 0 && result.structuredContent !== undefined && result.structuredContent !== null) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return sanitizeStoredText(parts.join("\n"));
}

/** Make one call to one of the server's tools. Sent once, never retried. */
export async function callServerTool(
  target: ConnectionTarget,
  tool: string,
  args: Record<string, unknown>
): Promise<Called> {
  const result = await withClient(target, async (client, timeoutMs) => {
    const answered = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
    return {
      isError: answered.isError === true,
      text: resultText(answered as { content?: unknown; structuredContent?: unknown }),
    };
  });
  return result.ok ? { ok: true, ...result.value } : result;
}
