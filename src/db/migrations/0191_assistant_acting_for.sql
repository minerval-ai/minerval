-- A conversation with the Assistant started while its user acted as an
-- organization is that organization's (docs/organizations.md, "Acting as the
-- organization"). NULL, every row today, is the user's own.
ALTER TABLE "assistant_conversations" ADD COLUMN "acting_for" uuid;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_acting_for_contributors_id_fk" FOREIGN KEY ("acting_for") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;