# Domain skills

A domain skill is the layer between an administrator's role and its task: how
the constitution's standards apply in one domain, what the domain's
characteristic objects are in the claim schema, what counts as evidence of
which grade there, and what tools and procedures the domain brings. Every
admin prompt is assembled in four layers, in order of authority: the
constitution, the role (whose prompt carries its own operating standards),
the domain skills active for the run, and the task. A skill may sharpen how a role's obligations apply and may
add procedures and tools; it never removes an obligation, and where it
appears to diverge from the constitution, the constitution wins and the skill
is defective.

This directory is not `plugin/skills/`. That directory holds the Agent Skill
for external Claude Code users of the MCP server
(`plugin/skills/claim-checking/SKILL.md`), which teaches an outside agent how
to check claims against the graph and never enters an admin prompt. The
skills here are spliced into the system prompts of the graph's own
administrators by `src/llm/prompts/skills.ts`.

## Layout

```
skills/
  README.md                  this file
  <name>/
    SKILL.md                 the skill text, in role-addressed sections
    tools.json               the tool definitions the skill brings (optional)
```

One document per domain serves every role. The loader splices each role's
view from the same file, so the Steward's verification procedure and the
Reviewer's criteria cannot drift apart.

## SKILL.md

The file opens with YAML frontmatter:

- `name`: at most 64 characters, lowercase letters, digits, and hyphens. It
  is also the value written into `claims.domains` that activates the skill.
- `description`: third person, at most 1,024 characters, saying when the
  skill applies and when it does not.
- `metadata.minerval.version`: an integer, bumped on any change to the text
  or the tools.
- `metadata.minerval.since_epoch`: the pipeline epoch the current version
  took effect under (`config.pipelineEpoch`).
- `metadata.minerval.domains`: the `claims.domains` values that activate the
  skill, normally just the skill's name.

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
- `For the solver`
- `Standards for judging`
- `Failure modes`

Which role receives which sections is the `ROLE_VIEW` table in
`src/llm/prompts/skills.ts`, shown on the site under `/docs/skills`. Every
view is wrapped with a heading the agent can cite, `# Domain skill: <Name>
(version N)`, and one sentence of standing.

Rules enforced by `tests/unit/llm/prompts/skills.test.ts`: the file is under
600 lines; only the headings above appear as H2s; the text contains no
em-dash character; and it contains no time-sensitive text (dates, "currently",
"recently"), because a skill is read for years.

## tools.json

An array of tool definitions in the Anthropic `Tool` shape (`name`,
`description`, `input_schema`) plus a `roles` list naming the roles whose
toolset the tool joins. Names carry a domain prefix (`lean_`), the way the
Elicit connector's tools carry `elicit_`. The definitions are declarative;
executors live in code, in the registry in `src/llm/tools/skill-tools.ts`,
which fails at startup if a declared tool has no executor or if a name
collides with an existing tool family.

## Versioning

Skills version with the code: same repository, same pull request. Bump
`version` on any change and update `since_epoch` when the change is
material enough to form a new claim cohort (see `docs/graph-epochs.md`).
Assessments and agent runs record the skills they were made under, so
"which assessments were made under version N" is a query.
