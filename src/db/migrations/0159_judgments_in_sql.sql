-- Read-only SQL: is_current is true for every judgment in force.
--
-- public_read.assessments serves every assessment with a flag for the
-- current one. Since a node may carry a judgment at each label, the flag
-- has been true for one row a node: the version the session's clearance
-- goes by, which for a reader who holds two labels that do not read each
-- other is the more recently made of two in force. A query then read one
-- of the two and nothing told its author there was another.
--
-- The flag is now true for each version in force for the session (the rule
-- the *_versions views in public read by), so such a reader's query gets a
-- row for each judgment and nothing chooses between them by date. A version
-- that another version the session reads was made with sight of stays
-- false, as before. The columns are unchanged. Where a session has one
-- judgment in force for a node, which is every session on a deployment with
-- one label and nearly every session elsewhere, the view is what it was:
-- there the test is the constant true.
CREATE OR REPLACE VIEW public_read.assessments AS
SELECT a.id, a.claim_id AS node_id, a.status, a.confidence, a.claim_credence AS credence, a.marginal_yield,
       (a.is_current AND public.minerval_version_in_force('assessments', a.claim_id, a.sensitivity_label)) AS is_current,
       a.assessed_at, a.trigger, a.summary, left(a.reasoning_trace, 500) AS reasoning_head,
       a.relabeled_from
  FROM assessments a;
--> statement-breakpoint
-- A view a migration replaces belongs to the migrating role until the step
-- hands it to the role the label policies bind.
SELECT public.minerval_enforcement_sync();
