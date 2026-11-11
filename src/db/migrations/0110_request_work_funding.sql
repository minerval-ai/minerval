-- What a run on a request's full work was funded at, and what the work was
-- priced at when it started (#885). A commission's budget is its payer's
-- choice and may be below the request's quote; the work log says so, so a
-- starved partial result can be told from a real one. NULL on scoping
-- passes, on contributors' work, and on every row from before this.
ALTER TABLE "request_work" ADD COLUMN "budget_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "request_work" ADD COLUMN "quote_micro_usd" bigint;
