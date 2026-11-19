-- A key or an MCP client's consent may be made to act as an organization its
-- person may act for (docs/organizations.md, "Other credentials"). NULL, every
-- row today, is the person's own.
ALTER TABLE "api_keys" ADD COLUMN "acting_for" uuid;--> statement-breakpoint
ALTER TABLE "oauth_authorization_requests" ADD COLUMN "acting_for" uuid;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "acting_for" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_acting_for_contributors_id_fk" FOREIGN KEY ("acting_for") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_requests" ADD CONSTRAINT "oauth_authorization_requests_acting_for_contributors_id_fk" FOREIGN KEY ("acting_for") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_acting_for_contributors_id_fk" FOREIGN KEY ("acting_for") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;