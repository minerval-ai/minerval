-- The kinds' agents (constitution §4, Part VIII): a probability a source
-- states for a claim is recorded on its instance, and a research run that
-- takes up a funded request names the request.
ALTER TABLE "claim_instances" ADD COLUMN "stated_probability" real;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_research_runs_request" ON "research_runs" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "claim_instances" ADD CONSTRAINT "ck_instances_stated_probability" CHECK ("claim_instances"."stated_probability" IS NULL OR ("claim_instances"."stated_probability" >= 0 AND "claim_instances"."stated_probability" <= 1));