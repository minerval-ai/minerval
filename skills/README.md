# Domain skills

A domain skill is the layer between an administrator's role and its task: how
the constitution's standards apply in one domain, what the domain's
characteristic objects are in the claim schema, what counts as evidence of
which grade there, and what tools and procedures the domain brings. A method
skill is the same layer for a kind of work rather than a subject (tracing
what a claim's support rests on). Authority runs in four layers: the
constitution, the role (whose prompt carries its own operating standards),
the skills the run loads, and the task. A skill may sharpen
how a role's obligations apply and may add procedures and tools; it never
removes an obligation, and where it appears to diverge from the constitution,
the constitution wins and the skill is defective.

This directory is not `plugin/skills/`. That directory holds the Agent Skill
for external Claude Code users of the MCP server
(`plugin/skills/claim-checking/SKILL.md`), which teaches an outside agent how
to check claims against the graph and never enters an admin prompt. The
skills here are loaded by the graph's own administrators, through
`src/llm/prompts/skills.ts` and the `load_skill` tool.

## Layout

```
skills/
  README.md                  this file
  <name>/
    SKILL.md                 the skill text, in role-addressed sections
    tools.json               the tool definitions the skill brings (optional)
```

One document per skill serves every role. The loader splices each role's
view from the same file, so the Steward's verification procedure and the
Reviewer's criteria cannot drift apart.

The format is the Agent Skills standard (agentskills.io): a directory named
for the skill, a `SKILL.md` with YAML frontmatter (`name`, `description`,
optional `metadata`) and a Markdown body, and any bundled files beside it.
A standard skill loader could read these files as they are, and the
`plugin/skills/` directory shows the same format serving Claude Code.

## Loading

Skills load on demand, as the standard intends. A role's prompt carries a
catalog of the skills it can load: each skill's name, description, latest
change, and the sections loading it gives that role. The agent reads a
skill with the `load_skill` tool (`src/llm/tools/skill-load-tools.ts`),
which returns the role's view as the tool result. Deciding which skills the
work calls for is the agent's judgment, like deciding which tools to call.

Every load is recorded: on the run's `agent_runs.skills`, and on the usage
context, so an assessment written after the load names it in
`claim_assessments.skills`. The record of which skills a run read is what
makes its prompt auditable; the Audit Agent can ask why a run did not load
a skill its work called for.

A skill's tools are not gated on the load. Every tool a skill declares for
a role is in that role's toolset (the Lean tools only where a checker is
configured), as tools are in the standard; the skill is the procedure for
using them well.

A claim's recorded domains, and a mandate's `grants.skills`, point to the
skills that cover the subject: the task message names them. A pointer, not
a load.

The Extractor is the one exception. It makes a single structured call with
no tools, so it has no turn in which to load anything, and its sections
(how to tag a claim's domains, how to record a passage) bear on every
extraction; its views are spliced into its prompt.

What is Minerval's own is small and deliberate: the body's H2 sections are
addressed to roles, so one document serves every administrator and
`load_skill` returns the sections addressed to the caller. The standard's
third tier (a skill's longer reference files, read only when needed) is not
built; a skill that outgrows one file would add a reference directory and a
read tool.

## SKILL.md

The file opens with YAML frontmatter:

- `name`: at most 64 characters, lowercase letters, digits, and hyphens. For
  a domain skill it is also the value written into `claims.domains` that
  activates the skill.
- `description`: third person, at most 1,024 characters, saying when the
  skill applies and when it does not.
- `metadata.minerval.version`: an integer, bumped on any change to the text
  or the tools.
- `metadata.minerval.since_epoch`: the pipeline epoch the current version
  took effect under (`config.pipelineEpoch`).
- `metadata.minerval.changelog`: a map from version to a one-line account
  of what that version changed, at most 300 characters. Required for the
  current version once it is past 1. The latest entry is shown on the
  skill's line in every role's catalog, so an agent told that a skill "now
  covers" a case can check the claim instead of trusting it (#493).
- `metadata.minerval.kind`: `domain` (the default) or `method`. A domain
  skill covers one subject and is pointed to by a claim's recorded domains.
  A method skill covers one kind of work any claim can call for; it claims
  no domain and never appears in the domain list the Extractor tags from.
- `metadata.minerval.domains`: for a domain skill, the `claims.domains`
  values that point to it, normally just the skill's name. A method skill
  omits it.

The body is Markdown addressed to the agents in the second person, as the
role prompts are. Its H2 headings are recognized by exact text and nothing
else is allowed at that level:

- `For every administrator`
- `For the Claim Steward`
- `For the Grantmaker`
- `For the Contribution Reviewer and the Dispute Arbitrator`
- `For the Audit Agent`
- `For the Curator`
- `For the Matcher`
- `For the Extractor`
- `For the researcher`
- `Standards for judging`
- `Failure modes`

Which sections a role's load returns is the `ROLE_VIEW` table in
`src/llm/prompts/skills.ts`, shown on the site under `/docs/skills`. Every
view is wrapped with a heading the agent can cite, `# Domain skill: <Name>
(version N)` or `# Method skill: <Name> (version N)`, and one sentence of
standing. The solver receives no skill: it is an instrument, and its prompt
is written without one. The researcher, the instrument an administrator
briefs and launches, often does a Steward's work on its behalf (a
provenance map, a literature search), so its load returns `For every
administrator` and `For the Claim Steward` as well as `For the researcher`,
which says what it leaves to the Steward.

Rules enforced by `tests/unit/llm/prompts/skills.test.ts`: the file is under
600 lines; only the headings above appear as H2s; the text contains no
em-dash character; and it contains no time-sensitive text (dates, "currently",
"recently"), because a skill is read for years.

## tools.json

An array of tool definitions in the Anthropic `Tool` shape (`name`,
`description`, `input_schema`) plus a `roles` list naming the roles whose
toolset the tool joins, whether or not the run loads the skill. Names carry a domain prefix (`lean_`), the way the
Elicit connector's tools carry `elicit_`. The definitions are declarative;
executors live in code, in the registry in `src/llm/tools/skill-tools.ts`,
which fails at startup if a declared tool has no executor or if a name
collides with an existing tool family.

## Versioning

Skills version with the code: same repository, same pull request. Bump
`version` on any change, add its `changelog` entry, and update `since_epoch`
when the change is
material enough to form a new claim cohort (see `docs/graph-epochs.md`).
Assessments and agent runs record the skills they were made under, so
"which assessments were made under version N" is a query.
