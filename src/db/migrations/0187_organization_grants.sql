-- What an organization grants, to its members and its deployments, from
-- one list (docs/organizations.md, "What an organization grants"). The
-- deployments' grants move here from deployment_grants, which 0188 drops;
-- the grant phase 2 called `act` becomes the four it is now split into.
CREATE TABLE "organization_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid,
	"deployment_id" uuid,
	"permission" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_by" uuid,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "ck_organization_grants_one_grantee" CHECK (("organization_grants"."account_id" IS NULL) <> ("organization_grants"."deployment_id" IS NULL)),
	CONSTRAINT "ck_organization_grants_permission" CHECK (("organization_grants"."account_id" IS NOT NULL AND "organization_grants"."permission" IN ('spend', 'buy', 'speak', 'propose', 'take_up', 'claim_prizes'))
        OR ("organization_grants"."deployment_id" IS NOT NULL AND "organization_grants"."permission" IN ('read_feed', 'report_usage', 'publish', 'spend', 'speak', 'propose', 'take_up')))
);
--> statement-breakpoint
ALTER TABLE "organization_grants" ADD CONSTRAINT "organization_grants_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_grants" ADD CONSTRAINT "organization_grants_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_grants" ADD CONSTRAINT "organization_grants_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_grants" ADD CONSTRAINT "organization_grants_granted_by_contributors_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_grants" ADD CONSTRAINT "organization_grants_withdrawn_by_contributors_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organization_grants_member_live" ON "organization_grants" USING btree ("organization_id","account_id","permission") WHERE "organization_grants"."withdrawn_at" IS NULL AND "organization_grants"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organization_grants_deployment_live" ON "organization_grants" USING btree ("deployment_id","permission") WHERE "organization_grants"."withdrawn_at" IS NULL AND "organization_grants"."deployment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_organization_grants_org" ON "organization_grants" USING btree ("organization_id");;--> statement-breakpoint
INSERT INTO "organization_grants" ("organization_id", "deployment_id", "permission", "granted_by", "granted_at", "withdrawn_by", "withdrawn_at")
SELECT d."organization_id", g."deployment_id", p.permission, g."granted_by", g."granted_at", g."withdrawn_by", g."withdrawn_at"
  FROM "deployment_grants" g
  JOIN "deployments" d ON d."id" = g."deployment_id"
  CROSS JOIN LATERAL unnest(
    CASE WHEN g."grant" = 'act' THEN ARRAY['spend', 'speak', 'propose', 'take_up'] ELSE ARRAY[g."grant"] END
  ) AS p(permission);
