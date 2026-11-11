-- The public class of a Steward failure (#846). claims.steward_error holds
-- raw error text (provider error bodies with request ids, Postgres messages
-- naming internal roles and relations, hostnames), which was being published
-- as it stood in GET /monitors and in plan-item explanations. This column
-- holds one of a few fixed words chosen when the error is written
-- (src/services/steward-park-reason.ts): credentials_fault, model_refusal,
-- database_fault, tool_failure, provider_error, other. Public surfaces show
-- only this; the raw text stays for logs and the service-scoped report.
ALTER TABLE "claims" ADD COLUMN "steward_error_reason" text;
--> statement-breakpoint
-- Rows that failed before the column existed, classified from their stored
-- text by the same patterns the code uses (stewardErrorReasonSql; a unit
-- test holds this statement and that function together).
UPDATE claims
   SET steward_error_reason = CASE
    WHEN lower(steward_error) LIKE '%authentication\_error%'
         OR lower(steward_error) LIKE '%invalid x-api-key%'
         OR lower(steward_error) LIKE '%api key is invalid%'
         OR lower(steward_error) LIKE '%invalid api key%'
      THEN 'credentials_fault'
    WHEN lower(steward_error) LIKE '%refused the request%'
      THEN 'model_refusal'
    WHEN lower(steward_error) LIKE '%violates %'
         OR lower(steward_error) LIKE '%does not exist%'
         OR lower(steward_error) LIKE '%permission denied for%'
         OR lower(steward_error) LIKE '%deadlock detected%'
         OR lower(steward_error) LIKE '%syntax error at or near%'
         OR lower(steward_error) LIKE '%invalid input syntax%'
         OR lower(steward_error) LIKE '%could not serialize access%'
         OR lower(steward_error) LIKE '%statement timeout%'
         OR lower(steward_error) LIKE '%connection terminated%'
         OR lower(steward_error) LIKE '%too many clients%'
         OR lower(steward_error) LIKE '%sqlstate%'
      THEN 'database_fault'
    WHEN lower(steward_error) LIKE '%tool failed%'
         OR lower(steward_error) LIKE '%tool error%'
         OR lower(steward_error) LIKE '%tool\_use%'
         OR lower(steward_error) LIKE '%tool call%'
         OR lower(steward_error) LIKE '%unknown tool%'
      THEN 'tool_failure'
    WHEN lower(steward_error) LIKE '%invalid\_request\_error%'
         OR lower(steward_error) LIKE '%not\_found\_error%'
         OR lower(steward_error) LIKE '%permission\_error%'
         OR lower(steward_error) LIKE '%request\_too\_large%'
         OR lower(steward_error) LIKE '%overloaded\_error%'
         OR lower(steward_error) LIKE '%api\_error%'
         OR lower(steward_error) LIKE '%openrouter%'
         OR lower(steward_error) LIKE '%anthropic%'
         OR lower(steward_error) LIKE '%openai%'
         OR lower(steward_error) LIKE '%max\_tokens%'
         OR lower(steward_error) LIKE '%stop\_reason%'
         OR lower(steward_error) LIKE '%structured output%'
         OR lower(steward_error) LIKE '%context window%'
         OR lower(steward_error) LIKE '%prompt is too long%'
      THEN 'provider_error'
    ELSE 'other'
  END
 WHERE steward_error IS NOT NULL AND steward_error_reason IS NULL;
--> statement-breakpoint
-- A parked node's reason in public_read.nodes: null unless steward_state is
-- 'error', so a query can tell which unassessed nodes will not be judged on
-- their own, and why. The new column goes last, as replacing a view requires.
CREATE OR REPLACE VIEW public_read.nodes AS
SELECT c.id, c.kind, c.text, c.claim_type, c.state, c.merged_into, c.importance, c.contestation,
       c.steward_state, c.stewarded_at, (c.created_by = 'user') AS proposed_by_person,
       COALESCE((SELECT array_agg(t.slug ORDER BY t.slug) FROM taggings tg JOIN tags t ON t.id = tg.tag_id
                  WHERE tg.subject_kind = 'claim' AND tg.subject_id = c.id), '{}') AS tags,
       c.created_at, c.updated_at,
       CASE WHEN c.steward_state = 'error' THEN COALESCE(c.steward_error_reason, 'other') END AS steward_park_reason
  FROM claims c;
