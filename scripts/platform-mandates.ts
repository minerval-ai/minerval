/**
 * Platform mandates through the Grantmaker (#529): the operator's (or an
 * agent's) side of the flow, from the first message to the funded grant.
 *
 *   converse [--conversation <id>] <message…>
 *       Open or continue one of the platform's granting conversations, with
 *       MINERVAL_PLATFORM_GRANTMAKING_KEY. Prints the Grantmaker's reply,
 *       the conversation's state, and the standing draft's hash. Nothing
 *       here can fund anything: the key is refused on /fund.
 *   show <conversation-id>
 *       Print a platform conversation from its public route.
 *   request <conversation-id> --slug <slug> --budget <owls> --rationale <text>
 *          [--pr-body <path>]
 *       Write mandates/platform/<slug>.json from the conversation's standing
 *       draft, and the pull-request body that lays the draft out for review.
 *       The rationale is the platform's reason for paying; the mandate is the
 *       Grantmaker's draft, untouched.
 *   verify [--offline] [files…]
 *       Check request files (all of mandates/platform/*.json by default):
 *       well-formed, the snapshot hashes to the pin, the budget covers the
 *       quote, and (online) the live conversation still holds that draft.
 *       Run on every pull request that touches mandates/platform/.
 *   fund [files…]
 *       After deploy on main: for each request whose conversation is not yet
 *       funded, find the merged pull request that last changed the file,
 *       and fund the pinned draft under it with MINERVAL_OPERATOR_KEY.
 *       Comments the mandate's link on the pull request. A request that
 *       reached main without a merged pull request is refused: the review
 *       is the approval.
 *
 * Environment: MINERVAL_API_URL (default https://api.claimgraph.io),
 * MINERVAL_SITE_URL (default https://minerval.ai), and for `fund`,
 * GITHUB_TOKEN and GITHUB_REPOSITORY.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildRequest,
  checkAgainstConversation,
  renderPullRequestBody,
  serializeRequest,
  validateRequest,
  SLUG,
  type PublicPlatformConversation,
} from "./platform-mandates/lib.js";

const REQUEST_DIR = "mandates/platform";
const API = (process.env.MINERVAL_API_URL || "https://api.claimgraph.io").replace(/\/$/, "");
const SITE = (process.env.MINERVAL_SITE_URL || "https://minerval.ai").replace(/\/$/, "");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined) fail(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body: body as T };
}

function conversationUrl(id: string): string {
  return `${API}/grant-conversations/platform/${id}`;
}

async function getPublicConversation(id: string): Promise<PublicPlatformConversation | null> {
  const { status, body } = await api<{ conversation: PublicPlatformConversation }>(
    `/grant-conversations/platform/${id}`
  );
  if (status === 404) return null;
  if (status !== 200) fail(`reading conversation ${id} failed (${status}): ${JSON.stringify(body)}`);
  return body.conversation;
}

// ---------------------------------------------------------------------------
// converse / show
// ---------------------------------------------------------------------------

async function converse(args: string[]): Promise<void> {
  const key = process.env.MINERVAL_PLATFORM_GRANTMAKING_KEY;
  if (!key) fail("MINERVAL_PLATFORM_GRANTMAKING_KEY is not set (mint one with the operator key: POST /operator/platform-grantmaking-keys)");
  const id = flag(args, "--conversation");
  const message = args.join(" ").trim();
  if (!message) fail("say something: converse [--conversation <id>] <message…>");
  const { status, body } = await api<{ conversation?: { id: string; status: string }; error?: string; code?: string }>(
    id ? `/grant-conversations/${id}/messages` : `/grant-conversations`,
    { method: "POST", body: { message }, headers: { "x-api-key": key } }
  );
  if (status >= 300 || !body.conversation) fail(`the conversation call failed (${status}): ${JSON.stringify(body)}`);
  // The reply comes in the background: read back through the public route
  // until the turn is done, then show the reply, the state, and the hash a
  // request would pin, exactly as a reviewer will see them.
  let convo = await getPublicConversation(body.conversation.id);
  if (!convo) fail("the conversation is not readable as a platform conversation");
  if (convo.turn?.state === "replying") process.stderr.write("Grantmaker is replying");
  while (convo.turn?.state === "replying") {
    await new Promise((r) => setTimeout(r, 10_000));
    process.stderr.write(".");
    convo = (await getPublicConversation(convo.id)) ?? fail("the conversation disappeared");
  }
  process.stderr.write("\n");
  if (convo.turn?.state === "failed") {
    fail(`the Grantmaker's turn failed: ${convo.turn.error ?? "no reason recorded"} (the message is saved; send a short follow-up)`);
  }
  const last = convo.messages[convo.messages.length - 1];
  console.log(last?.role === "assistant" ? last.content : "(no reply)");
  console.log("");
  console.log(`conversation: ${convo.id}`);
  console.log(`status:       ${convo.status}`);
  if (convo.draft) {
    console.log(`draft:        ${convo.draft.title} (quoted ${convo.draft.expected_cost_owls} owls)`);
    console.log(`draft sha256: ${convo.draft_sha256}`);
  }
  console.log(`public:       ${conversationUrl(convo.id)}`);
}

async function show(args: string[]): Promise<void> {
  const id = args[0] ?? fail("show <conversation-id>");
  const convo = (await getPublicConversation(id)) ?? fail("no platform granting conversation has that id");
  for (const m of convo.messages) {
    console.log(`--- ${m.role === "user" ? "Minerval" : "Grantmaker"}${m.at ? ` (${m.at})` : ""}`);
    console.log(m.content.trim());
    console.log("");
  }
  console.log(`status: ${convo.status}`);
  if (convo.draft) {
    console.log(JSON.stringify(convo.draft, null, 2));
    console.log(`draft sha256: ${convo.draft_sha256}`);
  }
}

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

async function request(args: string[]): Promise<void> {
  const slug = flag(args, "--slug") ?? fail("--slug <slug> is required");
  const budget = Number(flag(args, "--budget") ?? fail("--budget <owls> is required"));
  const rationale = flag(args, "--rationale") ?? fail("--rationale <text> is required");
  const prBody = flag(args, "--pr-body");
  const id = args[0] ?? fail("request <conversation-id> --slug … --budget … --rationale …");
  if (!SLUG.test(slug)) fail(`"${slug}" is not a lowercase-hyphenated slug`);
  const path = join(REQUEST_DIR, `${slug}.json`);
  if (existsSync(path)) fail(`${path} already exists; a request file is one funding decision`);

  const convo = (await getPublicConversation(id)) ?? fail("no platform granting conversation has that id");
  const req = buildRequest({ convo, budgetOwls: budget, rationale });
  const validated = validateRequest(req, slug);
  if (!validated.ok) fail(`the request would not be valid:\n- ${validated.problems.join("\n- ")}`);

  writeFileSync(path, serializeRequest(req));
  const body = renderPullRequestBody({ request: req, convo, slug, conversationUrl: conversationUrl(id) });
  if (prBody) writeFileSync(prBody, body + "\n");
  console.log(`wrote ${path}${prBody ? ` and ${prBody}` : ""}`);
  if (!prBody) {
    console.log("");
    console.log(body);
  }
}

// ---------------------------------------------------------------------------
// verify / fund
// ---------------------------------------------------------------------------

function requestFiles(args: string[]): string[] {
  if (args.length > 0) return args;
  if (!existsSync(REQUEST_DIR)) return [];
  return readdirSync(REQUEST_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(REQUEST_DIR, f));
}

function readRequest(file: string) {
  const slug = basename(file, ".json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false as const, problems: [`not valid JSON: ${(err as Error).message}`] };
  }
  return validateRequest(raw, slug);
}

async function verify(args: string[]): Promise<void> {
  const offline = args.includes("--offline");
  const files = requestFiles(args.filter((a) => a !== "--offline"));
  let failures = 0;
  for (const file of files) {
    const v = readRequest(file);
    if (!v.ok) {
      failures++;
      console.error(`✗ ${file}\n  - ${v.problems.join("\n  - ")}`);
      continue;
    }
    if (offline) {
      console.log(`✓ ${file} (offline)`);
      continue;
    }
    const check = checkAgainstConversation(v.request, await getPublicConversation(v.request.conversation_id));
    if (check.state === "refused") {
      failures++;
      console.error(`✗ ${file}\n  - ${check.problem}`);
    } else if (check.state === "funded") {
      console.log(`✓ ${file} (funded: ${SITE}/mandates/${check.grantId})`);
    } else {
      console.log(`✓ ${file} (fundable: merging funds ${v.request.budget_owls} owls)`);
    }
  }
  if (files.length === 0) console.log("no request files");
  if (failures > 0) process.exit(1);
}

async function github<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN || fail("GITHUB_TOKEN is not set");
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * The approval for a request file's current contents: the merged pull
 * request into main that last changed the file. Null when the file reached
 * main some other way, which is refused.
 */
async function approvalFor(file: string): Promise<{ number: number; url: string; mergedBy: string } | null> {
  const repo = process.env.GITHUB_REPOSITORY || fail("GITHUB_REPOSITORY is not set");
  const sha = execFileSync("git", ["log", "-1", "--format=%H", "--", file], { encoding: "utf8" }).trim();
  if (!sha) return null;
  const pulls = await github<Array<{ number: number; merged_at: string | null; base: { ref: string } }>>(
    `/repos/${repo}/commits/${sha}/pulls`
  );
  const merged = pulls.find((p) => p.merged_at && p.base.ref === "main");
  if (!merged) return null;
  const pr = await github<{ html_url: string; merged_by: { login: string } | null }>(
    `/repos/${repo}/pulls/${merged.number}`
  );
  if (!pr.merged_by) return null;
  return { number: merged.number, url: pr.html_url, mergedBy: pr.merged_by.login };
}

async function fund(args: string[]): Promise<void> {
  const files = requestFiles(args);
  let failures = 0;
  for (const file of files) {
    const v = readRequest(file);
    if (!v.ok) {
      failures++;
      console.error(`✗ ${file}\n  - ${v.problems.join("\n  - ")}`);
      continue;
    }
    const req = v.request;
    const check = checkAgainstConversation(req, await getPublicConversation(req.conversation_id));
    if (check.state === "funded") {
      console.log(`· ${file}: already funded (${SITE}/mandates/${check.grantId})`);
      continue;
    }
    if (check.state === "refused") {
      failures++;
      console.error(`✗ ${file}: ${check.problem}`);
      continue;
    }
    const approval = await approvalFor(relative(process.cwd(), file));
    if (!approval) {
      failures++;
      console.error(`✗ ${file}: not funded; it reached main without a merged pull request, and the review is the approval`);
      continue;
    }
    const operatorKey = process.env.MINERVAL_OPERATOR_KEY || fail("MINERVAL_OPERATOR_KEY is not set");
    const { status, body } = await api<{ grant_id?: string; already_funded?: boolean; error?: string; code?: string }>(
      "/operator/platform-mandates/fund",
      {
        method: "POST",
        headers: { "x-operator-key": operatorKey, "x-operator-actor": `github:${approval.mergedBy}` },
        body: {
          conversation_id: req.conversation_id,
          budget_owls: req.budget_owls,
          mandate_sha256: req.mandate_sha256,
          approval_url: approval.url,
          approved_by: approval.mergedBy,
        },
      }
    );
    if (status >= 300 || !body.grant_id) {
      failures++;
      console.error(`✗ ${file}: funding refused (${status} ${body.code ?? ""}): ${body.error ?? JSON.stringify(body)}`);
      continue;
    }
    const link = `${SITE}/mandates/${body.grant_id}`;
    console.log(`✓ ${file}: funded ${req.budget_owls} owls under ${approval.url} (${link})`);
    if (!body.already_funded) {
      const repo = process.env.GITHUB_REPOSITORY!;
      await github(`/repos/${repo}/issues/${approval.number}/comments`, {
        method: "POST",
        body: {
          body:
            `Funded: the Grantmaker's draft is now a live platform mandate with ${req.budget_owls} owls ` +
            `escrowed, bought at cost.\n\n${link}\n\n` +
            `From here the mandate is stewarded like any other: its Grantmaker runs the review passes, ` +
            `regrants, and lookouts, and decides when it is done.`,
        },
      }).catch((err) => console.error(`  (could not comment on #${approval.number}: ${(err as Error).message})`));
    }
  }
  if (files.length === 0) console.log("no request files");
  if (failures > 0) process.exit(1);
}

// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = {
  converse,
  show,
  request,
  verify,
  fund,
};
const run = command ? commands[command] : undefined;
if (!run) {
  fail("usage: platform-mandates <converse|show|request|verify|fund> … (see the header of scripts/platform-mandates.ts)");
}
run(rest).catch((err) => fail((err as Error).stack ?? String(err)));
