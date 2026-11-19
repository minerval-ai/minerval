-- Which agents a connection is offered to is the administrator's choice,
-- role by role (connections.offered_to; CONNECTION_ROLES in
-- src/connections.ts; docs/connections.md, "Which agents").
--
-- A connection added from now on is offered to every role that works with
-- tools at a label reading its own, but for the few that start unticked
-- with a reason. A connection that exists keeps the three roles it was
-- offered to before, since a migration should not widen what an
-- administrator chose to let agents read: the others are ticked on the
-- connection's page.
ALTER TABLE "connections" ADD COLUMN "offered_to" text[] DEFAULT '{"steward","researcher","lookout"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "offered_to" SET DEFAULT '{"steward","researcher","lookout","grantmaker","program_officer","curator","consistency_checker","contribution_reviewer","dispute_arbitrator","assistant"}';
