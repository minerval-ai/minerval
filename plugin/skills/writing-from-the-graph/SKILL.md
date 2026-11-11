---
name: writing-from-the-graph
description: >-
  Facts worth knowing when making a document for a user out of what the
  Minerval graph holds (a brief, a ranked list, a table, evidence
  requests): which reads help, what importance means, how citations stay
  pinned, and what a request looks like.
---

# Writing from the graph

Facts specific to Minerval that bear on making a document from it.

- **Sizing a territory.** `list_tags` and `get_tag` give a topic's node
  count. `query_sql` counts and sorts across nodes, assessments, and
  edges (the sql skill has the views); it has a free daily allowance.
- **Someone may already make it.** `list_correspondents` shows the
  Correspondents covering a node; their updates are free to read.
- **Importance.** Each node carries `importance` (roughly consequence if
  wrong times how live it is, §19) and, separately, `contestation`.
  Importance is not how much depends on a node: settled facts hold up a
  great deal and score low, and dependent counts over-rate niche claims.
  `marginal_yield` on an assessment is the Steward's estimate of how
  much another pass would add.
- **Three kinds, three judgments.** A claim has a status, a quantity an
  estimate with an interval, a question a standing and best answer.
  Normative claims are assessed like any other (§8, §25).
- **Pinned citations.** `cite_claim` returns a citation tied to the
  assessment version, so a document can say what the graph held on the
  day it was written. A status read later may differ.
- **Pages.** `save_page` keeps a document in the user's account, private
  to them, at `/ask/pages/:id`. Its markdown can embed nodes that are
  read from the graph each time the page is opened: `[claim:<uuid>]`
  inline, and on a line of its own `{{node <uuid>}}`,
  `{{nodes <uuid> <uuid> ...}}` (a table the reader can sort) or
  `{{decomposition <uuid>}}`. The page records each node's judgment when
  saved and marks any that has moved; the prose around an embed does not
  update, so a status written out in a sentence goes stale where an
  embed does not. `list_pages` and `get_page` read them back.
- **What the support rests on.** `get_claim_provenance`, or `get_claim`
  with `include: ["provenance"]`: which sources are one voice, and how
  each bears its assertion.
- **Requests.** The graph's form for an evidence ask is a request: what
  is asked, what the judgment would become under each outcome, and what
  would satisfy it (Part VIII). `list_requests` finds open ones and
  `get_request` shows a budget and whether work is commissioned;
  anyone can fund the work on one.
