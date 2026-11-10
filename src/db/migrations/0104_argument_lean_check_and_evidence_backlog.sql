CREATE TABLE "argument_evidence_backlog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"argument_id" uuid NOT NULL,
	"url" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "arguments" ADD COLUMN "lean_check_id" uuid;--> statement-breakpoint
ALTER TABLE "argument_evidence_backlog" ADD CONSTRAINT "argument_evidence_backlog_argument_id_arguments_id_fk" FOREIGN KEY ("argument_id") REFERENCES "public"."arguments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_argument_evidence_backlog_url" ON "argument_evidence_backlog" USING btree ("argument_id","url");--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_lean_check_id_lean_checks_id_fk" FOREIGN KEY ("lean_check_id") REFERENCES "public"."lean_checks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- An argument's Lean check, from the /lean-checks/<id> entry its
-- evidence_urls carried: the accepted check, newest first, as the badge
-- read it.
UPDATE "arguments" ar
   SET "lean_check_id" = picked.id
  FROM (
    SELECT DISTINCT ON (a.id) a.id AS argument_id, lc.id
      FROM "arguments" a
      CROSS JOIN LATERAL unnest(a.evidence_urls) AS u
      JOIN "lean_checks" lc
        ON lc.id::text = substring(lower(u) from '/lean-checks/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:/|$)')
     ORDER BY a.id, (lc.verdict = 'accepted') DESC, COALESCE(lc.finished_at, lc.created_at) DESC
  ) picked
 WHERE ar.id = picked.argument_id;--> statement-breakpoint
-- Every other URL waits for the claim's Steward: a URL is not an instance.
INSERT INTO "argument_evidence_backlog" ("argument_id", "url")
SELECT DISTINCT a.id, btrim(u)
  FROM "arguments" a
  CROSS JOIN LATERAL unnest(a.evidence_urls) AS u
 WHERE btrim(u) <> ''
   AND lower(u) !~ '/lean-checks/'
ON CONFLICT DO NOTHING;
