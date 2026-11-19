-- An allowance on a grant of spend (docs/organizations.md, "What an
-- organization grants"): the owls of the organization that member or
-- deployment may spend, and what it has spent. NULL spends from the whole
-- balance, as every grant did before.
ALTER TABLE "organization_grants" ADD COLUMN "allowance_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "organization_grants" ADD COLUMN "allowance_spent_micro_usd" bigint DEFAULT 0 NOT NULL;