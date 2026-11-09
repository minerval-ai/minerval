-- Read-only SQL over the graph's public data (sql-service.ts).
--
-- Every view exposes only what the public API already serves: no funder or
-- contributor identities, no emails, keys, balances or unfunded drafts. A
-- parity test (tests/db/sql-views.test.ts) holds each column to a reviewed
-- list. Readers reach these views through the group role minerval_sql, which
-- has SELECT here and nothing on the base tables; its login roles (one for
-- the graph's agents, one for outside callers, each with its own connection
-- limit) are created by the operator, not by a migration, because their
-- passwords are secrets.
CREATE SCHEMA IF NOT EXISTS public_read;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.nodes AS
SELECT c.id, c.kind, c.text, c.claim_type, c.state, c.merged_into, c.importance, c.contestation,
       c.steward_state, c.stewarded_at, (c.created_by = 'user') AS proposed_by_person,
       COALESCE((SELECT array_agg(t.slug ORDER BY t.slug) FROM taggings tg JOIN tags t ON t.id = tg.tag_id
                  WHERE tg.subject_kind = 'claim' AND tg.subject_id = c.id), '{}') AS tags,
       c.created_at, c.updated_at
  FROM claims c;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.assessments AS
SELECT a.id, a.claim_id AS node_id, a.status, a.confidence, a.claim_credence AS credence, a.marginal_yield,
       a.is_current, a.assessed_at, a.trigger, a.summary, left(a.reasoning_trace, 500) AS reasoning_head
  FROM assessments a;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.edges AS
SELECT r.id, r.parent_claim_id AS parent_id, r.child_claim_id AS child_id, r.relation_type AS relation,
       r.reasoning, r.created_at
  FROM claim_relationships r;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.arguments AS
SELECT a.id, a.claim_id AS node_id, a.name, a.stance, a.shows, a.description, a.created_at, a.retired_at
  FROM arguments a;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.tags AS
SELECT t.slug, t.name, t.description, t.status,
       (SELECT count(*) FROM taggings tg WHERE tg.tag_id = t.id AND tg.subject_kind = 'claim')::int AS node_count
  FROM tags t;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.sources AS
SELECT s.id, s.url, s.title, s.source_type, s.publisher, s.published_date, s.doi, s.retrieved_at
  FROM sources s;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.instances AS
SELECT i.id, i.claim_id AS node_id, i.source_id, i.stance, i.speaker, i.publication, i.source_date,
       left(i.verbatim_text, 500) AS verbatim_head, i.created_at, i.detached_at
  FROM claim_instances i;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.ledger AS
SELECT a.id AS action_id, a.kind, a.variant, a.claim_id AS target_node_id, a.target_ref, a.label,
       CASE a.status WHEN 'done' THEN 'finished' WHEN 'superseded' THEN 'finished' ELSE a.status END AS status,
       a.metered_cost_micro_usd / 1e6 AS spent_owls, a.created_at AS opened_at, a.updated_at
  FROM actions a;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.commissions AS
SELECT al.id AS commission_id, al.action_id, al.exclusion_group,
       CASE WHEN al.grant_id IS NOT NULL THEN 'mandate' ELSE 'person' END AS payer_kind,
       al.grant_id AS payer_mandate_id,
       al.amount_micro_usd / 1e6 AS budget_owls, al.spent_micro_usd / 1e6 AS spent_owls,
       CASE WHEN al.released_at IS NOT NULL THEN (al.amount_micro_usd - al.spent_micro_usd) / 1e6 ELSE 0 END AS returned_owls,
       al.commissioned_by, al.brief, al.reason, al.parent_action_id, al.created_at, al.released_at AS settled_at
  FROM action_allocations al;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.messages AS
SELECT m.id AS message_id, m.node_id, m.trigger, m.sender_kind, m.sender_node_id, m.paid, m.body,
       m.created_at, m.read_at, m.outcome, m.outcome_note
  FROM node_messages m;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.mandates AS
SELECT g.id AS mandate_id, g.mandate->>'title' AS title, g.mandate->>'objective' AS objective, g.status,
       g.is_platform, g.daily_budget_micro_usd / 1e6 AS daily_rate_owls, j.budget_micro_usd / 1e6 AS escrow_owls,
       g.mandate->'operating_policy' AS operating_policy, g.created_at
  FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.mandate_decisions AS
SELECT d.id AS decision_id, d.grant_id AS mandate_id, d.decided_by, d.item_kind, d.decision, d.target,
       d.owls_micro_usd / 1e6 AS owls, d.reason, d.petition_id, d.action_id, d.created_at
  FROM mandate_decisions d;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.petitions AS
SELECT p.id AS petition_id, p.grant_id AS mandate_id, p.kind, p.asked_micro_usd / 1e6 AS asked_owls,
       p.granted_micro_usd / 1e6 AS granted_owls, p.requester_agent, p.requester_node_id, p.status,
       p.plan, p.reason, p.created_at, p.decided_at
  FROM petitions p;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.contributions AS
SELECT c.id AS contribution_id, c.claim_id AS node_id, c.contribution_type AS type, c.review_status,
       c.submitted_at
  FROM contributions c;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_read.requests AS
SELECT r.id AS request_id, r.ask, r.why, r.state, r.keeper_kind, r.keeper_claim_id AS keeper_node_id,
       r.budget_micro_usd / 1e6 AS budget_owls, r.created_at, r.closed_at
  FROM requests r;
--> statement-breakpoint
-- The change stream, as one table: what moved, when, on which node.
CREATE OR REPLACE VIEW public_read.changes AS
SELECT 'assessed'::text AS kind, a.claim_id AS node_id, a.assessed_at AS at, a.status AS summary FROM assessments a
UNION ALL
SELECT 'message_arrived', m.node_id, m.created_at, m.trigger FROM node_messages m WHERE m.trigger <> 'message_reply'
UNION ALL
SELECT 'message_answered', m.node_id, m.answered_at, m.outcome FROM node_messages m WHERE m.answered_at IS NOT NULL
UNION ALL
SELECT 'work_commissioned', al.claim_id, al.created_at, al.exclusion_group FROM action_allocations al WHERE al.commissioned_by IS NOT NULL
UNION ALL
SELECT 'run_finished', a.claim_id, a.updated_at, a.kind FROM actions a WHERE a.status = 'done'
UNION ALL
SELECT 'contribution_accepted', c.claim_id, c.submitted_at, c.contribution_type FROM contributions c WHERE c.review_status = 'accepted'
UNION ALL
SELECT 'petition_decided', p.requester_node_id, p.decided_at, p.status FROM petitions p WHERE p.decided_at IS NOT NULL
UNION ALL
SELECT 'request_filed', r.keeper_claim_id, r.created_at, left(r.ask, 200) FROM requests r;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minerval_sql') THEN
    CREATE ROLE minerval_sql NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public_read TO minerval_sql;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public_read TO minerval_sql;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public_read GRANT SELECT ON TABLES TO minerval_sql;
--> statement-breakpoint
-- Per-account bookkeeping for callers' SQL (sql-service.ts): one query at a
-- time, and the day's database time against the free allowance.
CREATE TABLE IF NOT EXISTS sql_usage (
  account_key text NOT NULL,
  day date NOT NULL,
  seconds double precision NOT NULL DEFAULT 0,
  queries integer NOT NULL DEFAULT 0,
  running_until timestamptz,
  PRIMARY KEY (account_key, day)
);
