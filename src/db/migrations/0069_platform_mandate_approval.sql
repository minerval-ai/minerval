-- The public approval behind a platform-funded mandate (#529). A platform
-- mandate is designed by the Grantmaker in a conversation the platform
-- account holds, like any funder's; its money is approved in a reviewed
-- pull request, and the operator route that funds it records the approval
-- here: the PR's URL, who merged it, and the hash of the draft it pinned.
-- Null on every existing row and on every mandate a person funds.
ALTER TABLE "grants" ADD COLUMN "platform_approval" jsonb;
