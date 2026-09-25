-- Argument membership as a relation (#437). Constitution §7: different
-- arguments may share subclaims while arranging them differently. The single
-- argument_id column on claim_relationships could group an edge under at most
-- one argument, and the second grouping was silently lost. Membership now
-- lives in argument_subclaims, one row per (argument, edge); an edge with no
-- row is part of the claim's ungrouped basis. Existing groupings are carried
-- over before the column goes.
CREATE TABLE "argument_subclaims" (
	"argument_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "argument_subclaims_argument_id_relationship_id_pk" PRIMARY KEY("argument_id","relationship_id")
);
--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD CONSTRAINT "argument_subclaims_argument_id_arguments_id_fk" FOREIGN KEY ("argument_id") REFERENCES "public"."arguments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD CONSTRAINT "argument_subclaims_relationship_id_claim_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."claim_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_argument_subclaims_relationship" ON "argument_subclaims" USING btree ("relationship_id");--> statement-breakpoint
INSERT INTO "argument_subclaims" ("argument_id", "relationship_id", "created_at")
SELECT cr."argument_id", cr."id", cr."created_at"
  FROM "claim_relationships" cr
  JOIN "arguments" a ON a."id" = cr."argument_id"
 WHERE cr."argument_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "claim_relationships" DROP CONSTRAINT "claim_relationships_argument_id_arguments_id_fk";
--> statement-breakpoint
ALTER TABLE "claim_relationships" DROP COLUMN "argument_id";
