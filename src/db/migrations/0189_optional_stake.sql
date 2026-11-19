-- A connection's or a file set's stake is optional (docs/connections.md,
-- "What a connection is"; docs/file-sets.md). It was required, and for an
-- organization's own systems it was mostly a sentence that said again what
-- the party already says. An interest that bears on one claim is the
-- Steward's to record for that claim (constitution §9). Where a stake is
-- given it is recorded on every source kept, as before; NULL records none.
-- Rows that have one keep it.
ALTER TABLE "connections" ALTER COLUMN "stake" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "file_sets" ALTER COLUMN "stake" DROP NOT NULL;