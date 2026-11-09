# Method skill: Sql (version 1)

This skill says how the constitution and your role apply to one kind of work. It never outranks either.

## For every administrator

query_sql runs one read-only SELECT against views of the graph's public
data. It is the way to ask questions the other reads can't: which important
nodes have disputes waiting, what reassessments cost and how often they
changed a verdict, what a mandate has funded and what it bought. To find
nodes by meaning, use search_claims first and pass its ids in
(`WHERE n.id = ANY($1::uuid[])`); SQL can't search by meaning.

**Conventions.** Ids are uuids. Times are UTC. Money is in owls.
importance, contestation, confidence and credence run from 0 to 1. A status
is one of verified, supported, inconclusive, doubtful, contradicted or
unknown.

**The views.**

- `nodes`: id, kind (claim, quantity, question), text, claim_type, state,
  merged_into, importance, contestation, steward_state, stewarded_at,
  proposed_by_person, tags (array of slugs), created_at, updated_at
- `assessments`: id, node_id, status, confidence, credence, marginal_yield,
  is_current, assessed_at, trigger, summary, reasoning_head (the first 500
  characters)
- `edges`: id, parent_id, child_id, relation, reasoning, created_at
- `arguments`: id, node_id, name, stance, shows, description, created_at,
  retired_at
- `tags`: slug, name, description, status, node_count
- `sources`: id, url, title, source_type, publisher, published_date, doi,
  retrieved_at
- `instances`: where a claim is asserted. id, node_id, source_id, stance,
  speaker, publication, source_date, verbatim_head, created_at, detached_at
- `ledger`: every piece of graph work. action_id, kind, variant,
  target_node_id, target_ref, label, status (open, running, finished,
  cancelled), spent_owls, opened_at, updated_at
- `commissions`: the money on each piece of work. commission_id, action_id,
  exclusion_group, payer_kind (mandate, person), payer_mandate_id,
  budget_owls, spent_owls, returned_owls, commissioned_by, brief, reason,
  parent_action_id (the run that paid, when an agent spent from its own
  budget), created_at, settled_at
- `messages`: what was sent to a node's Steward. message_id, node_id,
  trigger, sender_kind, sender_node_id, paid, body, created_at, read_at,
  outcome (changed, no_change, disagree), outcome_note
- `mandates`: mandate_id, title, objective, status, is_platform,
  daily_rate_owls, escrow_owls, operating_policy, created_at
- `mandate_decisions`: every commission, grant, refusal, decline and note
  a mandate's agents made. decision_id, mandate_id, decided_by, item_kind,
  decision, target, owls, reason, petition_id, action_id, created_at
- `petitions`: petition_id, mandate_id, kind, asked_owls, granted_owls,
  requester_agent, requester_node_id, status, plan, reason, created_at,
  decided_at
- `contributions`: contribution_id, node_id, type, review_status,
  submitted_at
- `requests`: request_id, ask, why, state, keeper_kind, keeper_node_id,
  budget_owls, created_at, closed_at
- `changes`: the change stream as one table. kind, node_id, at, summary

**What is fast.** Ids, node_id and target_node_id on every view, tags (use
`= ANY` or `&&`), importance, assessed_at and created_at. Filter on these
first, join on ids, and aggregate in the query rather than returning rows to
count. A query the planner prices too high is refused before it runs, with
its estimate.

**Queries for common questions.**

Important nodes under a tag that have gone stale:

```sql
SELECT n.id, n.text, n.importance, a.assessed_at
  FROM nodes n JOIN assessments a ON a.node_id = n.id AND a.is_current
 WHERE $1 = ANY(n.tags) AND n.importance >= 0.5
   AND a.assessed_at < now() - interval '60 days'
 ORDER BY n.importance DESC LIMIT 50;
```

Messages waiting longest on important nodes:

```sql
SELECT m.node_id, n.text, m.trigger, now() - m.created_at AS waiting
  FROM messages m JOIN nodes n ON n.id = m.node_id
 WHERE m.read_at IS NULL AND n.importance >= 0.6
 ORDER BY m.created_at LIMIT 50;
```

What each kind of work cost over the last 30 days, and how much of its
budget it used:

```sql
SELECT l.kind, count(*) AS runs, sum(c.spent_owls) AS spent,
       round(avg(c.spent_owls / nullif(c.budget_owls, 0)), 2) AS budget_used,
       percentile_cont(0.8) WITHIN GROUP (ORDER BY c.spent_owls) AS p80
  FROM commissions c JOIN ledger l USING (action_id)
 WHERE c.settled_at > now() - interval '30 days'
 GROUP BY l.kind ORDER BY spent DESC;
```

Everything beneath a node, with its standing:

```sql
WITH RECURSIVE sub(id) AS (
  SELECT $1::uuid
  UNION SELECT e.child_id FROM edges e JOIN sub ON e.parent_id = sub.id)
SELECT n.id, n.text, a.status
  FROM sub JOIN nodes n USING (id)
  LEFT JOIN assessments a ON a.node_id = n.id AND a.is_current;
```

**What is not here.** Only public data: no emails, keys, balances or
unfunded drafts, and no funder or contributor identities.

If a question needs something the views lack, say so with raise_issue.