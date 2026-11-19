-- Bearer keys go (docs/organizations.md, phase 9). The API keys an account
-- held before it became an organization stop: nobody signs in as an
-- organization, a deployment reaches minerval.ai over its own connection,
-- and since phase 1 each organization's page has shown which of these keys
-- were still used. Each is recorded on its organization's log as the
-- operator's act, with the reason, so its admins see what stopped and when.
-- Keys a member made to act as the organization (acting_for) are the
-- member's, and stay.
WITH revoked AS (
  UPDATE "api_keys" k SET "revoked_at" = now()
    FROM "contributors" c
   WHERE c."id" = k."user_id" AND c."kind" = 'organization' AND k."revoked_at" IS NULL
  RETURNING k."user_id", k."id", k."key_prefix"
)
INSERT INTO "organization_log" ("organization_id", "actor_id", "credential", "kind", "detail")
SELECT "user_id", NULL, 'operator', 'old_key_revoked',
       jsonb_build_object('key_id', "id", 'key_prefix', "key_prefix",
         'why', 'Bearer keys were retired: a deployment reaches minerval.ai over its own connection, and a member acts as the organization signed in as themselves.')
  FROM revoked;
