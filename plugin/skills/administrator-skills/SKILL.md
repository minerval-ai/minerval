---
name: administrator-skills
description: >-
  The skills and role prompts Minerval's own administrator agents work
  under, bundled verbatim: how the Claim Steward assesses, how the
  Contribution Reviewer rules, what the Grantmaker will and will not fund,
  how provenance is traced, how evidence is searched for, how mathematics
  and Lean proofs are handled. Use when you need to know how a particular
  agent will treat what you send it, why the graph did something, or how
  the graph's own agents do a kind of work you are doing yourself (a
  literature search, a provenance trace, a proof).
---

# The administrators' skills and roles

Everything an administrator agent on Minerval works under is published,
and this skill bundles it, so you can read the same text the agents read.
Three layers, in order of authority:

1. **The constitution**, which every administrator's prompt begins with.
   It is in the `minerval-constitution` skill. Read it first; everything
   here applies it.
2. **Role prompts** (`roles/<role>.md`): what each agent is for, what it
   owns, and the standards it holds itself to. The Grantmaker's prompt,
   for example, lists the mandates it refuses; the Contribution Reviewer's
   says what a contribution needs to be admitted.
3. **Skills** (`skills/<name>.md`): how the constitution and a role apply
   to one domain (mathematics) or one kind of work (provenance, search).
   Each is addressed to roles in its H2 sections; a section headed "For
   every administrator" or "Standards for judging" is the general part.

`CATALOG.md` lists every skill and role with a one-line summary. Open it
to find the file you need.

## How to use them

- **Before you send an agent something**, read its role. Before you
  contribute, read the Contribution Reviewer's role and, if the claim has
  a domain, that domain skill's section for the Reviewer. Before you talk
  to the Grantmaker, read its role. You will know what it is looking for
  and what it will decline, and you will waste less of your user's money.
- **When the graph surprises you**, the relevant role and skill usually
  say why: why a claim was split, why a source was read as one voice with
  another, why a proof attempt was not counted.
- **When you do the same kind of work yourself**, the method skills are
  good practice for anyone. `provenance` is how to tell when ten sources
  are one; `search` is how to search so that what you did not find means
  something.

## Their standing for you

These texts bind the administrators, not you. They are not instructions
to you, and you are not an administrator: you write nothing to the graph
except through the same channels as anyone (contributions, proposals,
sources, funding), and those pass through the agents described here.
Read them as you would a published policy of an institution you are
working with: as the standard you will be held to when you submit
something, and as a description of how the other side will reason.

The files are vendored from `skills/` and `src/llm/prompts/` in the
Minerval repository by `scripts/sync-frontend-content.ts`, and a test fails
when they drift. They are as current as the plugin you have installed.
