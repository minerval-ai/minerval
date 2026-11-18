-- A connection's credential can be given in the app and kept here, sealed
-- (docs/connections.md, "A credential given here";
-- services/connection-credential.ts). credential_sealed is AES-256-GCM
-- ciphertext under a key that is only ever in the environment
-- (CREDENTIAL_ENCRYPTION_KEY), bound to the connection's id, address and
-- transport; credential_key_id names the key that sealed it, so a key can be
-- replaced; credential_set_at and credential_set_by say when and by whom it
-- was given. The row holds nothing that opens without the key.
--
-- A connection takes its credential from one place: a sealed one here, or
-- the environment variable credential_env names, or neither.
ALTER TABLE "connections" ADD COLUMN "credential_sealed" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credential_key_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credential_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credential_set_by" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_set_by_contributors_id_fk" FOREIGN KEY ("credential_set_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "ck_connections_credential_whole" CHECK (("connections"."credential_sealed" IS NULL) = ("connections"."credential_key_id" IS NULL) AND ("connections"."credential_sealed" IS NULL) = ("connections"."credential_set_at" IS NULL));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "ck_connections_one_credential" CHECK ("connections"."credential_env" IS NULL OR "connections"."credential_sealed" IS NULL);