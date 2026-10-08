# Minerval

What to link to to prove your point on the internet is an underappreciated
unsolved problem, even when you are 'demonstrably' right. None of the existing
solutions are really adequate. Some random paper on Arxiv whose jargony
abstract plausibly says something adjacent to the thing you're saying? A blog
post by some guy your interlocutor doesn't know and doesn't trust? A news
article? The Wikipedia page for an adjacent topic? A link to your conversation
with Claude where you controlled the framing of the question? None of these
things is likely to satisfy the objector.

## What is Minerval?

Minerval is an open source project to build a database of claims about the
world, figure out what the important ones are, and ask LLMs to assess their
epistemic statuses.[^claims] Its claim pages
([example](https://minerval.ai/claims/0d59fb15-7dc1-49b1-b9d9-9462f17d2d21/map))
are intended to be the place that one links to or consults for the canonical,
neutral epistemic status of any claim, much as Wikipedia is the canonical (and
at least aspirationally neutral) place one goes for a standard introduction to
any given topic.

Minerval decomposes every claim to its bedrock, weighs it against the
evidence, and keeps the verdict current as the world changes. The graph is
maintained by LLM administrators operating under a public
[constitution](admin_constitution.md); every judgment carries a reasoning
trace, and every decision is open to challenge. Like Wikipedia, the graph is a
public good, and the payoff is what gets built on it: the site at
[minerval.ai](https://minerval.ai), a
[browser extension](https://chromewebstore.google.com/detail/minerval/ojpdkgmlbffliefddfendfakpiiopkci)
that annotates the web by verdict, and an API and MCP server that ground AI
agents in claims that have already been weighed.

If done properly, with today's best LLMs,[^llms] this should allow for
actually good mass fact-checking, in the same way that Pangram allows actually
good mass slop-detection.[^integration]

I am aware of the long history of failed attempts at similar projects, and why
most ideas in the category are indeed doomed. I am also very aware of the
challenges of doing actually good epistemic work across domains with even the
best of today's LLMs. For more details on how I approach the problem, please
read our [constitution](admin_constitution.md).

## Where it's going

In the long term, I aim to turn Minerval into a central institution that
organizes the funding of research and knowledge production across domains. To
efficiently allocate attention in a scientific domain, we must first have a
map of the work to be done, and then a mechanism for pricing that
work.[^pricing] Minerval does both. By delegating funding decisions to
grantmaker agents ([docs/allocation.md](docs/allocation.md)), it aims to solve
the information asymmetry problem in the market for science.

## Status

I have built an [eval suite](https://minerval.ai/docs/evals) measuring
properties which, if robustly satisfied at the graph level by the multi-agent
system that administers the graph, would ensure that it can scale efficiently
without losing coherence or accuracy (stability, path independence,
consistency, and adversarial robustness).[^adversarial] Our
[current mapped subdomains](https://minerval.ai/claims) were built for the
Future of Life Foundation's
[Epistack competition](https://flf.org/epistack-competition/), where Minerval
was [selected as a winner](https://www.lesswrong.com/posts/mxzvL3hYFCcutQqcR/flf-s-epistemic-case-study-competition-results).
They look about right, but we need to run larger multi-agent tests to be
confident that these properties hold.

## Who's behind this

Minerval is built by [Jackson Hurley](https://jacksonhurley.com/).[^corp] At
this time, Minerval is just me and Claude Code. I am actively looking for
cofounders. If you like the vision and want to work on it, please
[reach out](https://minerval.ai/about#contact). If you know the perfect
person, please put us in touch!

[^claims]: Claims are canonical forms of public claims about the world. More
    details in [part II of our constitution](admin_constitution.md#part-ii-the-claim-layer).
[^llms]: Nobody will use this, and no one should use it, if the outputs are
    noticeably worse than what they could get by opening a new tab and simply
    asking their own frontier model.
[^integration]: Including via our browser extension or, ideally, since no one
    uses browser extensions, direct integration with platforms such as
    LessWrong, Substack (similar to what they've done with Pangram), or X.
[^pricing]: A complex problem. See
    [Allocating Attention in Claimspace](https://jacksonhurley.com/allocating-attention-in-claimspace).
[^adversarial]: If Minerval succeeds at becoming a canonical source, people
    will try to influence it. Minerval invites contributions and new evidence,
    but that comes with substantial attack surface area for bad-faith actors.
    The plan here is to set up a test environment and give agents the task of
    manipulating the graph's administration into supporting their position,
    then keep adjusting until relentless frontier agents robustly fail at
    red-teaming.
[^corp]: I have incorporated Minerval, Inc. as a vanilla Delaware C-Corp, but
    I have no immediate plans to either raise money from VCs or provide
    excludable goods and services, with the very minor exception of the chat
    feature in the browser extension/API.

## This repository

This repository is the whole system: the API and agent pipeline, the web app,
the browser extension, the Claude Code plugin, the Lean checker, the
evaluation harness, and the infrastructure. The rest of this README is for
people who want to read or run the code. The
[documentation on the site](https://minerval.ai/docs) covers the same ground
for readers, including every agent's complete system prompt.

## Design commitments

Most epistemic tools work at the level of documents: an article gets
fact-checked, a page gets written up encyclopedically. But disputes live at
the level of *claims*, and the same claim recurs across thousands of
documents. Minerval takes the claim as its atomic unit and does the expensive
work once. A claim is extracted, canonicalized, decomposed, and assessed a
single time, then reused everywhere it appears.

A few commitments, argued in full in the [constitution](admin_constitution.md),
shape everything downstream:

- **Clarity over resolution.** The system's job is to make the structure of a
  claim visible (what it rests on, where consensus exists, which
  disagreements are empirical and which come down to values or definitions),
  not to declare winners. A well-mapped unresolvable disagreement is a
  success, not a failure.

- **Decomposition stops at what is uncontested.** Claims decompose into
  subclaims until they reach bedrock, and bedrock is where no informed person
  in the live discourse would actually dispute the claim, not where it
  becomes logically primitive. "Special relativity is empirically valid" is
  load-bearing for a physics claim, but it is settled, so it is a leaf.
  Effort belongs on live disagreements.

- **Identity by decomposition.** Two formulations are the same claim if and
  only if they decompose identically; that is the basis for deduplication. A
  claim and its denial are one node, because they pose the same question. The
  disagreement is represented *on* the claim, with each recorded appearance
  carrying a stance.

- **Arguments as structure.** A claim can have several independent lines of
  reasoning for and against it ("God exists" has the cosmological argument,
  the teleological argument, the argument from evil). Each is a named grouping
  of subclaims with a short written form stating the inference. Arguments are
  structural, never epistemic: whether an argument is *sound* is itself a
  claim in the graph.

- **Honest uncertainty.** A claim's assessment is one of six statuses
  (`verified`, `supported`, `contested`, `unsupported`, `contradicted`,
  `unknown`), never a binary, and every assessment carries a reasoning trace
  explaining how the verdict was reached.

- **Effort follows importance.** Not every claim deserves the full treatment.
  Each claim carries an importance score, roughly consequence-if-wrong times
  how actively it is disputed or consulted. Work on the graph is funded
  through mandates (see [Allocation](#allocation) below), and importance
  anchors what that work is worth, so the most consequential claims are
  assessed first while minor ones stay searchable stubs until someone funds
  them.

- **Openness.** Anyone can contribute challenges, evidence, merge and split
  proposals, and new arguments. Contributions flow through reviewed,
  appealable governance, with the reasoning on the public record.

## How it works

```
   SOURCE              INGESTION                     GRAPH
 ┌─────────┐   ┌──────────────────────────┐   ┌────────────┐
 │ URL or  │──▶│ Extractor → Matcher →    │──▶│ Postgres   │
 │ document│   │ Claim Steward            │   │ + pgvector │
 └─────────┘   └──────────────────────────┘   └─────┬──────┘
                                                    │ read
   GOVERNANCE (ongoing)                             ▼
 ┌─────────────────────────────────────┐      ┌───────────┐     web ·
 │ Claim Steward · Curator ·           │◀────▶│    API    │──▶  extension ·
 │ Consistency Checker · Contribution  │      │ (Fastify) │     MCP clients
 │ Reviewer · Dispute Arbitrator ·     │      └───────────┘
 │ Audit Agent · Grantmaker · Lookout  │
 └─────────────────────────────────────┘
```

Ingestion is the expensive, write-side work. Serving is cheap, with no LLM in
the read path. The graph is maintained by ten LLM administrators, each bound
by the constitution and each with a bounded domain.

**Building the graph**

- **Extractor** reads a source and surfaces the discrete, reusable claims it
  asserts. It is deliberately selective: the claims a reader would want
  checked, not every sentence.
- **Matcher** is the identity gate. For each proposed claim it searches the
  graph under multiple framings, including the negation, and decides whether
  to match or create. The other agents also call it before creating anything.

**Keeping it honest**

- **Claim Steward** owns a single claim end to end: it decomposes it,
  maintains its canonical form and arguments, sets its importance, and
  assesses it, re-judging as evidence and the claims it depends on change.
  Decomposing and assessing are one open-ended judgment, so they belong to one
  owner.
- **Curator** owns the connective tissue *between* claims: merging duplicates
  the Matcher missed, splitting conflations, proposing cross-claim edges. It
  never overrides a Steward's verdict.
- **Consistency Checker** reads a region of the graph at a time for verdicts
  that conflict with their neighbors' or don't follow from what they rest on,
  and raises each find with the Steward whose claim looks wrong. It writes no
  verdict itself.
- **Contribution Reviewer**, **Dispute Arbitrator**, and **Audit Agent** run
  governance: policy review of incoming contributions, adjudication of
  escalations and appeals, and sampled quality control over the system's own
  decisions.
- **Grantmaker** designs and stewards a funded mandate: it surveys the
  territory, values the work on offer, grows its own plan, moves budget
  between peer mandates, and may refuse money that would warp the graph.
- **Lookout** is a mandate's standing watch. Woken by a heartbeat or a
  trigger (the daily retraction poll, a poke), it reads the graph, the
  retraction record, and the open web, and raises candidates for its
  Grantmaker: a claim to reassess, a source to ingest. It judges relevance,
  never truth, and can neither write an assessment nor move money.

**Instruments.** A few more agents serve the administrators without
administering anything. The **Researcher** runs one bounded investigation for
the agent that launched it (replicate a finding, trace a statistic to its
origin, map a literature) and reports back. The **Solver** makes one bounded
attempt on a formal mathematical statement, with Lean and a computer-algebra
sandbox, and reports to the claim's Steward. The **Tagger** labels claims
with topic tags for navigation. The **Extension Agent** sits behind the
browser extension, judging on-page phrasings against the graph and powering
its chat; it never writes to the graph.

Model choice follows the value of the judgment. Narrow, saturating calls
(matching, tagging, the Lookout's relevance call, the Consistency Checker's
sweep) run on a cheap model via OpenRouter. The load-bearing epistemic work
(extraction, stewardship, curation, arbitration, audit, grantmaking, solving)
runs on the strongest available Claude model. Defaults live in
[`src/llm/models.ts`](src/llm/models.ts) and [`src/config.ts`](src/config.ts),
and every agent can be pointed at another model with its `*_MODEL`
environment variable.

### Allocation

One engine decides where the system spends its attention. Every potential
action (assess this claim, ingest that source, plan that mandate) is a row on
a shared action ledger. Mandates and people place money on those rows, and an
action runs exactly when its allocations cover its expected cost; nothing
else decides what runs. Money is denominated in owls, one owl per dollar of
metered model cost. Mandates are public, funded programs of work on the
graph, each stewarded by its own Grantmaker and watched by the Lookouts it
posts. See [docs/allocation.md](docs/allocation.md).

### Further reading

- [docs/architecture.md](docs/architecture.md): domain model, assessment
  semantics, workers and failure handling, persistence, serving surfaces.
- [docs/policies.md](docs/policies.md): the operating policies the agents
  apply on top of the constitution.
- [docs/mathematics.md](docs/mathematics.md): mathematics as the flagship
  domain (formal statements, the Lean checker, the solver, prizes).
- [docs/mcp.md](docs/mcp.md): the MCP server and its tools.

## Surfaces

- **Web app.** [minerval.ai](https://minerval.ai), a Next.js app for
  browsing claims, decomposition trees, arguments, assessments, and
  contribution history, and for browsing and funding mandates.
- **API.** Fastify at `api.claimgraph.io`. Reads are public; anything that
  writes or spends model tokens requires a key. Interactive OpenAPI docs are
  at `/docs` on the API host.
- **Browser extension.** Reads the page with you, underlining each recognized
  claim by what the graph knows about it, with a chat grounded in the graph.
  Available on the
  [Chrome Web Store](https://chromewebstore.google.com/detail/minerval/ojpdkgmlbffliefddfendfakpiiopkci);
  built with Plasmo in [extension/](extension/).
- **MCP server.** Remote MCP over streamable HTTP at `POST /mcp`, with OAuth
  2.1 so hosted clients (such as Claude.ai) can connect. Tools for searching
  and reading the graph, running the pipeline's judgments, and contributing.
  See [docs/mcp.md](docs/mcp.md).
- **Claude Code plugin.** Packages the MCP server with slash commands, a
  fact-checker subagent, and a skill. This repository doubles as its
  marketplace; see [plugin/](plugin/).

## Repository layout

| Path | Contents |
|------|----------|
| [`src/`](src/) | The API (Fastify), the agent pipeline (`llm/`, `workers/`), services, the MCP server, and the Drizzle schema (`db/`) |
| [`web/`](web/) | The Next.js web app deployed at minerval.ai |
| [`extension/`](extension/) | The Plasmo browser extension |
| [`plugin/`](plugin/) | The Claude Code / Cowork plugin |
| [`lean-checker/`](lean-checker/) | The Lean checker service for formal mathematical statements |
| [`skills/`](skills/) | Skills the agents load for particular domains |
| [`corpus/`](corpus/) | The evaluation harness: pinned document clusters, scoring rubric, LLM-judge scoring |
| [`tests/`](tests/) | Unit and database tests |
| [`scripts/`](scripts/) | Operational scripts: seeding, backfills, repairs, eval content |
| [`docs/`](docs/) | Architecture, policies, allocation, mathematics, MCP, accounts, reputation, infrastructure |
| [`infra/`](infra/) | AWS CDK stacks (ECS Fargate, RDS PostgreSQL, SQS) |
| [`admin_constitution.md`](admin_constitution.md) | The constitution every administrator agent is bound by |

## Running locally

The whole pipeline runs on a laptop: docker-compose provides Postgres with
pgvector, and the job queue runs in memory with handlers identical to the SQS
ones used in production. You need Node.js 22, Docker, and API keys for
Anthropic (the strong-tier agents), OpenAI (embeddings), and OpenRouter (the
cheap-tier agents). To run without OpenRouter, point `MATCHER_MODEL`,
`TAGGER_MODEL`, `LOOKOUT_MODEL`, and `CONSISTENCY_MODEL` at a Claude model
instead; `.env.example` documents each one.

```bash
docker compose up -d          # Postgres + pgvector
cp .env.example .env          # fill in the API keys
npm install
npm run db:migrate
npm run dev                   # API + workers on :3000
```

`npm test` runs the unit tests; `npm run typecheck` checks types.

## Evaluation

Agent changes are graded, not eyeballed. The corpus harness runs the real
application over pinned clusters of source documents, drains the pipeline to
quiescence, and has an LLM judge (deliberately a different model from the
agent under test) score the resulting graph against the constitution. The
graph-level evals for stability, path independence, consistency, and
adversarial robustness build on it. Results, costs, and recorded replays are
published at [minerval.ai/docs/evals](https://minerval.ai/docs/evals); the
harness is in [corpus/](corpus/).

## Contributing

To the knowledge graph: submit challenges, evidence, and proposals through
the web app, the API, or the MCP server. They flow through the reviewed
governance pipeline described above.

To the code: issues and pull requests are welcome. Start with
[docs/architecture.md](docs/architecture.md) to get oriented.

## License

The code is MIT; see [LICENSE](LICENSE).

The claim graph content (claims, assessments, arguments, and the
nanopublication exports built from them) is dedicated to the public domain
under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Each
nanopub records the dedication in its publication-info graph via
`dct:license`. Contributions to the knowledge graph are accepted under the
same CC0 dedication.

---

*"The owl of Minerva spreads its wings only with the falling of the dusk."* (Hegel)

Understanding, Hegel thought, arrives only in retrospect. Minerval is an
attempt to do better: to map claims as they are made, not after the dust has
settled.
