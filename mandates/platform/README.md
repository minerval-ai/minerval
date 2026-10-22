# Platform funding requests

Each `.json` file here is one decision by Minerval to put its own money
behind a mandate. Merging the pull request that adds the file is what
funds it. This README explains the process (#529;
docs/allocation.md, "Platform mandates").

## What a request is, and what it isn't

The platform is a funder like any other. Its mandates are designed in a
granting conversation with the Grantmaker. The Grantmaker surveys the graph,
writes the mandate, quotes it, and can decline it, just as it can for any
person's mandate. A request file doesn't write or change a mandate. It holds:

- `conversation_id`: the platform conversation the draft came from. It's
  public: `GET /grant-conversations/platform/<id>`.
- `draft`: a snapshot of the Grantmaker's draft, exactly as the conversation
  holds it, so reviewers can read it in the diff.
- `mandate_sha256`: the hash that pins that draft. If the Grantmaker revises
  the draft after review, funding is refused, and the request has to be
  written again from the new draft.
- `budget_owls`: the most Minerval will escrow. It must cover the
  Grantmaker's quote. The work is metered as it runs, and unspent budget
  refunds when the mandate closes.
- `rationale`: why Minerval pays for this. These are the only words in the
  file that are the platform's own. They appear in the pull request and never
  on the graph: funding buys attention, never conclusions or framing.

## The flow

1. **Converse.** With a platform-grantmaking key (minted with the operator
   key, `POST /operator/platform-grantmaking-keys`, and accepted only on the
   conversation routes):

   ```sh
   MINERVAL_PLATFORM_GRANTMAKING_KEY=… npm run platform-mandates -- converse "what the platform wants"
   MINERVAL_PLATFORM_GRANTMAKING_KEY=… npm run platform-mandates -- converse --conversation <id> "…"
   ```

   Talk until the Grantmaker proposes a mandate or declines one. A decline
   stands: argue with its reasons in the conversation if they're wrong, but
   there is no route around it.

2. **Request.** Once the conversation is `proposed`:

   ```sh
   npm run platform-mandates -- request <id> --slug <slug> --budget <owls> \
     --rationale "why Minerval funds this" --pr-body /tmp/body.md
   ```

   This writes `mandates/platform/<slug>.json` and a pull-request body that
   lays out the draft and the conversation. Open the PR with that body.

3. **Review.** CI checks the file against the live conversation
   (`npm run platform-mandates -- verify`). Reviewers judge whether the
   platform should pay for this draft. The mandate itself is the
   Grantmaker's call.

4. **Merge.** After Deploy succeeds on `main`, the Platform mandates workflow
   funds the draft with the operator key, under the merged pull request that
   last changed the file. In one transaction it buys the owls at cost,
   escrows them, and creates the grant. It records the PR and who merged it
   on the grant, comments the mandate's link on the PR, and the mandate page
   links back to the PR. A file that reaches `main` without a merged pull
   request is refused.

Once it's funded, the mandate is stewarded like any other. Its Grantmaker
runs the review passes, regrants and lookouts, and decides when it is done.
Leave the file in place: it's the record, and the workflow skips
conversations that are already funded.
