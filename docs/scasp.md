# s(CASP) export

`GET /claims/:id/scasp?max_depth=3` (MCP: `export_claim_scasp`) renders a
claim's decomposition as a logic program for
[s(CASP)](https://github.com/SWI-Prolog-Packs/sCASP), the goal-directed
answer-set solver. Load it and the embedded query asks whether the claim
follows from the premises the graph records. s(CASP) answers with the
assumptions that make it follow and a justification tree, which `#pred`
lines render in the claims' own words:

```bash
scasp --tree --human claim.pl
```

The export renders existing state, like the nanopublication export
(docs/vocab.md). It walks the same tree `get_decomposition` returns, with the
same depth bound (1 to 8, default 3) and node cap. Exported text resolves
`[[claim:...]]` references to claim text (§12), and the content is CC0.

## The encoding

`holds(C)` says claim C is true and `-holds(C)` says it is false. This is
classical negation: s(CASP) admits no model that holds both. Each claim's
atom is `c_` followed by its id without hyphens.

**Arguments.** Each named argument in the tree becomes a rule whose body is its
premises. The rule's strength comes from the Steward's rating of the
inference (`mv:verdict`):

| Rating | Rule for an argument *for* P | Against P |
| --- | --- | --- |
| `certain` | `holds(P) :- premises.` | `-holds(P) :- premises.` |
| `likely` | `holds(P) :- premises, not -holds(P).` | `-holds(P) :- premises, not holds(P).` |
| `slight`, `none`, unevaluated | comment only | comment only |

A likely argument is defeasible. When likely arguments on both sides fire,
the result is two models, one for each reading, which is how s(CASP) shows a
contested claim. Two certain arguments that conflict leave no model, which
flags an inconsistency in the graph. An argument that takes no side, rests on
a question or quantity, or sits under a claim whose children the node cap cut
off stays a comment, with the reason written beside it. An unevaluated
argument is not encoded at all, because that would state a judgment the graph
has not made.

**Edges.** A relation contributes a rule of its own only where its meaning
gives one (`RELATION_GUIDANCE` in src/schemas/common.ts):

- `requires`: `-holds(P) :- -holds(C).` The parent is false without the
  premise.
- `assumes`: `ill_posed(P) :- -holds(C).` If the framework fails, the parent
  is beside the point rather than false.
- `supports`, `contradicts`, `specifies`, `defines`: no rule. They weigh on
  the parent only through the arguments that group them.

**Basis.** A claim that no encoded argument concludes takes its own verdict.
This covers leaves, claims at the depth bound, and claims whose arguments
were all left as comments:

| Status | Encoded as |
| --- | --- |
| `verified`, `supported` | `holds(C).` |
| `doubtful`, `contradicted` | `-holds(C).` |
| `inconclusive`, `unknown`, unassessed | open: `holds(C) :- not -holds(C).` and `-holds(C) :- not holds(C).` |

An open claim forms an even loop, so s(CASP) explores both readings and names
the open premises a conclusion depends on.

**The raw graph.** `assessed(C, Status)` and `edge(Parent, Child, Relation)`
record the graph as it stands. A reader who wants a different basis policy can
write their own rules over these facts, for example treating `doubtful` as
open.
