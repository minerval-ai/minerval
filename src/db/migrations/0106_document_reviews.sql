ALTER TABLE "examinations" DROP CONSTRAINT "ck_examinations_trigger";--> statement-breakpoint
ALTER TABLE "examinations" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_examinations_request" ON "examinations" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "examinations" ADD CONSTRAINT "ck_examinations_trigger" CHECK ("examinations"."trigger" IN ('claim', 'request', 'mechanical', 'mandate'));