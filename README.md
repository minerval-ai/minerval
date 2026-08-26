# Minerval

**LLMs as epistemic infrastructure.**

Minerval turns documents into a shared, queryable graph of claims. An LLM
pipeline reads a source, pulls out the atomic claims it asserts, decides
whether each already exists in the graph, decomposes it into the subclaims and
arguments it rests on, and assesses its validity — with every judgment traced
and open to challenge. The graph is live at [minerval.ai](https://minerval.ai),
served by a public API at `api.claimgraph.io`, and reachable from a browser
extension and an MCP server.

This repository contains the whole system: the API and agent pipeline, the web
app, the extension, the evaluation harness, and the infrastructure.

## The idea

Most epistemic tools work at the level of documents — an article is
fact-checked, a page is encyclopedic. But disputes live at the level of
*claims*, and the same claim recurs across thousands of documents. Minerval
takes the claim as its atomic unit and does the expensive work once: a claim is
extracted, canonicalized, decomposed, and assessed a single time, then reused
everywhere it appears.

A few commitments, argued in full in the [constitution](admin_constitution.md),
shape everything downstream:

- **Clarity over resolution.** The system's job is to make the structure of a
  claim visible — what it rests on, where consensus exists, which
  disagreements are empirical and which come down to values or definitions —
  not to declare winners. A well-mapped unresolvable disagreement is a
  success, not a failure.

- **Decomposition, stopped by contestedness.** Claims decompose into subclaims
  until they reach bedrock, and bedrock is where no informed person in the live
  discourse would actually dispute the claim — not where it becomes logically
  primitive. "Special relativity is empirically valid" is load-bearing for a
  physics claim, but it is settled, so it is a leaf. Effort belongs on live
  disagreements.

- **Identity by decomposition.** Two formulations are the same claim if and
  only if they decompose identically — the basis for deduplication. A claim
  and its denial are one node: they pose the same question, so the
  disagreement is represented *on* the claim, with each recorded appearance
  carrying a stance.

- **Arguments as structure.** A claim can have several independent lines of
  reasoning for and against it ("God exists" has the cosmological argument,
  the teleological argument, the argument from evil). Each is a named grouping
  of subclaims with a short written form stating the inference. Arguments are
  structural, never epistemic: whether an argument is *sound* is itself a
  claim in the graph.

- **Honest uncertainty.** A claim's assessment is one of six statuses —
  `verified`, `supported`, `contested`, `unsupported`, `contradicted`,
  `unknown` — never a binary, and every assessment carries a reasoning trace
  explaining how the verdict was reached.

- **Effort proportional to importance.** Not every claim deserves the full
  treatment. Each claim carries an importance score — roughly
  consequence-if-wrong × contestability — that anchors the expected-value
  estimates the allocation engine funds work by, so the most consequential
  claims draw assessment first while minor ones remain searchable stubs
  until someone's allocation covers them (see docs/allocation.md: the owl
  economy, mandates, and the action ledger).

- **Openness.** Anyone can contribute — challenges, evidence, merge and split
  proposals, new arguments — and contributions flow through reviewed,
  appealable governance with the reasoning on the public record.

## How it works

```
   SOURCE               INGESTION                    GRAPH
 ┌─────────┐   ┌───────────────────────────┐   ┌───────────┐
 │ URL or  │──▶│ Extractor → Matcher →     │──▶│ Postgres  │
 │ document│   │ onboard → Claim Steward   │   │ + pgvector│
 └─────────┘   └───────────────────────────┘   └─────┬─────┘
                                                     │ read
   GOVERNANCE (ongoing)                              ▼
 ┌──────────────────────────────────────┐      ┌───────────┐     web ·
 │ Claim Steward (decompose + assess) · │◀────▶│    API    │──▶  extension ·
 │ Curator · Contribution Reviewer ·    │      │ (Fastify) │     MCP clients
 │ Dispute Arbitrator · Audit Agent     │      └───────────┘
 └──────────────────────────────────────┘
```

Ingestion is the expensive, write-side work; serving is cheap, with no LLM in
the read path. The graph is maintained by a small organization of LLM agents,
each bound by the constitution, each with a bounded domain:

- **Extractor** reads a source and surfaces the discrete, reusable claims it
  asserts — deliberately selective: the claims a reader would want checked,
  not every sentence.
- **Matcher** is the identity gate. For each proposed claim it searches the
  graph agentically — under multiple framings, including the negation — and
  decides match-or-create. It is also a tool the other agents call before
  creating anything.
- **Claim Steward** owns a single claim end to end: it decomposes it,
  maintains its canonical form and arguments, sets its importance, and
  assesses it — re-judging as evidence and depended-on claims change.
  Decomposing and assessing are one open-ended judgment, so they belong to one
  owner, not to fire-once scorers.
- **Curator** owns the connective tissue *between* claims: merging duplicates
  the Matcher missed, splitting conflations, proposing cross-claim edges. It
  never overrides a Steward's verdict.
- **Contribution Reviewer**, **Dispute Arbitrator**, and **Audit Agent** run
  governance: policy review of incoming contributions, adjudication of
  escalations and appeals, and sampled quality control over the system's own
  decisions.
- **Grantmaker** designs and stewards funded mandates: it surveys the
  territory (graph and web), writes its mandate's valuations over the shared
  action ledger, grows its own plan, moves budget between peer mandates, and
  may refuse money that would warp the graph.
- **Extension Agent** lives outside governance, behind the browser extension:
  it judges on-page phrasings against graph state and powers the in-page chat.
  It never writes to the graph.

Model choice follows the value of the judgment: matching is a saturating task
and runs on Claude Haiku; the load-bearing epistemic work — stewardship,
structural adjudication, arbitration, audit, grantmaking — runs on the
strongest available Claude models, and background assessments choose between
a standard and a strong pass by marginal return on compute. Model ids are
centralized in [`src/llm/models.ts`](src/llm/models.ts).

The full picture — domain model, assessment semantics, workers and failure
handling, persistence, serving surfaces — is in
[docs/architecture.md](docs/architecture.md); the resource-allocation stack
(owls, mandates, the action ledger) is in
[docs/allocation.md](docs/allocation.md).

## Surfaces

- **Web app** — [minerval.ai](https://minerval.ai), a Next.js app for
  browsing claims, decomposition trees, arguments, assessments, and
  contribution history.
- **Mandates** — [minerval.ai/mandates](https://minerval.ai/mandates):
  public funded programs of work on the graph, each stewarded by its own
  Grantmaker agent and open to anyone's contribution.
- **API** — Fastify at `api.claimgraph.io`. Reads are public; anything that
  writes or spends model tokens requires a key. Interactive OpenAPI docs at
  `/docs` on the API host.
- **Browser extension** — reads the page with you, underlining each recognized
  claim by what the graph knows about it, with a chat grounded in the graph.
  Built with Plasmo; see [extension/](extension/).
- **MCP server** — remote MCP over streamable HTTP at `POST /mcp`, with OAuth
  2.1 so hosted clients (such as Claude.ai) can connect. Tools for searching
  and reading the graph, running the pipeline's judgments, and contributing.
  See [docs/mcp.md](docs/mcp.md).

## Repository layout

| Path | Contents |
|------|----------|
| [`src/`](src/) | The API (Fastify), the agent pipeline (`llm/`, `workers/`), services, and the Drizzle schema (`db/`) |
| [`web/`](web/) | The Next.js web app deployed at minerval.ai |
| [`extension/`](extension/) | The Plasmo browser extension |
| [`corpus/`](corpus/) | The evaluation harness: pinned document clusters, scoring rubric, LLM-judge scoring |
| [`docs/`](docs/) | Architecture, policies, MCP, accounts, reputation, graph epochs, infrastructure |
| [`infra/`](infra/) | AWS CDK stacks (ECS Fargate, RDS PostgreSQL, SQS) |
| [`admin_constitution.md`](admin_constitution.md) | The constitution every administrator agent is bound by |

## Running locally

The whole pipeline runs on a laptop: docker-compose provides Postgres with
pgvector, and the job queue runs in-memory with handlers identical to the SQS
ones used in production. You need Node.js 20+, Docker, an Anthropic API key
(agents), and an OpenAI API key (embeddings).

```bash
docker compose up -d          # Postgres + pgvector
cp .env.example .env          # fill in ANTHROPIC_API_KEY and OPENAI_API_KEY
npm install
npm run db:migrate
npm run dev                   # API + workers on :3000
```

`npm test` runs the unit tests; `npm run typecheck` checks types.

## Evaluation

Agent changes are graded, not eyeballed. The corpus harness runs the real
application over pinned clusters of source documents, drains the pipeline to
quiescence, and has an LLM judge — deliberately a different model from the
agent under test — score the resulting graph against the constitution. Runs
are compared release over release. See [corpus/](corpus/).

## Contributing

Two graphs accept contributions here. The knowledge graph is open now: submit
challenges, evidence, and proposals through the web app, API, or MCP server,
and they flow through the reviewed governance pipeline described above. For
the codebase, issues and pull requests are welcome — start with
[docs/architecture.md](docs/architecture.md) to get oriented.

## License

The code is MIT — see [LICENSE](LICENSE).

The claim graph content — claims, assessments, arguments, and the
nanopublication exports built from them — is dedicated to the public domain
under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Each
nanopub records the dedication in its publication-info graph via
`dct:license`. Contributions to the knowledge graph are accepted under the
same CC0 dedication.

---

*"The owl of Minerva spreads its wings only with the falling of the dusk."* — Hegel

Understanding, Hegel thought, arrives only in retrospect. Minerval is an
attempt to do better: to map claims as they are made, not after the dust has
settled.
