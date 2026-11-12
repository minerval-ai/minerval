ALTER TABLE "api_keys" ADD COLUMN "work_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_requests" ADD COLUMN "work_label" text;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "work_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_work_label_labels_name_fk" FOREIGN KEY ("work_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_requests" ADD CONSTRAINT "oauth_authorization_requests_work_label_labels_name_fk" FOREIGN KEY ("work_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_work_label_labels_name_fk" FOREIGN KEY ("work_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;