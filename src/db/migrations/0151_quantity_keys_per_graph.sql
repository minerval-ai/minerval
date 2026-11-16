-- Identity per graph for the two quantity tables (review 3, finding 2).
--
-- The migration before this one put `origin` at the end of every key a
-- replicated table has besides its id, and left these two: a quantity's
-- definition and a claim's cut of a quantity, each keyed by the node alone.
-- So a cut a deployment recorded on a mirrored claim stood where the public
-- graph's own cut of that claim belongs, and the batch that brought it was
-- refused. Both keys now end with `origin` like the rest: the public graph's
-- row always applies, and a row of the deployment's own stands beside it.
-- Every row on the public graph is 'local', so there each key holds what it
-- held; the index behind it is rebuilt once, here.
ALTER TABLE "quantity_cuts" DROP CONSTRAINT "quantity_cuts_pkey";--> statement-breakpoint
ALTER TABLE "quantity_definitions" DROP CONSTRAINT "quantity_definitions_pkey";--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD CONSTRAINT "quantity_cuts_claim_id_origin_pk" PRIMARY KEY("claim_id","origin");--> statement-breakpoint
ALTER TABLE "quantity_definitions" ADD CONSTRAINT "quantity_definitions_claim_id_origin_pk" PRIMARY KEY("claim_id","origin");
--> statement-breakpoint
-- On a database that already has a second label, the guard against unseen
-- collisions is rebuilt on the keys as they now are. On the public graph the
-- step finds one label and changes nothing.
SELECT public.minerval_enforcement_sync();
