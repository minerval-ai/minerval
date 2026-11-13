/**
 * Published pages on the graph that receives them: the routes
 * (docs/published-pages.md, "On the public graph";
 * services/published-page-service.ts). Mounted on every graph, as every
 * route of the public graph is; the public graph is where they are used.
 *
 *   POST /publishers: register a deployment's signing key to the calling
 *     account. Any account may.
 *   GET  /publishers/:account_id: a publisher's public record.
 *   POST /published-pages: submit a signed package. Any account may, for
 *     a key it registered.
 *   GET  /published-pages?node_id=|account_id=: the published pages of a
 *     node or of a publisher.
 *   GET  /published-pages/:published_page_id: one published page in the
 *     shape of a node's page, with its record and history.
 *   GET  /published-pages/:published_page_id/package: one package exactly
 *     as signed, for anyone to check.
 *
 * A publisher has no standing an account lacks. Its package is a source it
 * submits; the submission is a contribution on the node, reviewed as any
 * contribution is; and what its page is worth is the node's Steward's
 * judgment.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { loadConfig } from "../config.js";
import { gateContributor } from "../server/contributor-gate.js";
import { chargeAgenticOp, refundAgenticOp } from "../server/plugins/quota.js";
import { attachChargeContribution } from "../services/owl-ledger-service.js";
import { HOSTING_WORDS } from "../published-page/verify.js";
import {
  DECLARED_INTEREST_MAX_CHARS,
  PublishedPageError,
  admitPackage,
  examinePackage,
  listPublishedPages,
  packageAsSigned,
  publisherRecord,
  readPublishedPage,
  registerPublisher,
} from "../services/published-page-service.js";

const UUID = { type: "string", format: "uuid" } as const;

const STATUS: Record<string, number> = {
  UNREGISTERED_KEY: 403,
  NOT_YOUR_KEY: 403,
  KEY_REGISTERED: 409,
  NODE_NOT_FOUND: 404,
  NODE_NOT_ACTIVE: 409,
  OUT_OF_ORDER: 409,
  CHAIN_BROKEN: 409,
  NOT_ADMITTED: 409,
  HOSTING_DIFFERS: 409,
  TOO_LARGE: 413,
  DOES_NOT_VERIFY: 422,
};

export async function publishedPageRoutes(app: FastifyInstance): Promise<void> {
  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PublishedPageError) {
      return reply.code(STATUS[err.code] ?? 400).send({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
    }
    throw err;
  };

  app.post<{ Body: { public_key: string; hosting: string; signature: string; declared_interest?: string } }>("/publishers", {
    schema: {
      tags: ["published pages"],
      summary: "Register a deployment's signing key to your account, so that pages it publishes can be submitted under it",
      description:
        "A publisher is an account that has registered the key its deployment signs packages with. The registration is a public record: your account, " +
        "the key, and where the deployment runs, as one of own_machines (the organization's own machines), minerval (Minerval's machines) or " +
        "third_party (a third party's machines). `signature` is the key's signature over a statement naming your account and that hosting, which the " +
        "deployment produces, so that nobody registers a key they do not hold. `declared_interest` is what you say of your own interest in what you " +
        "publish, in a sentence or two; it is shown with every page. Registering gives no standing: a page you publish is reviewed and weighed as any " +
        "contribution is. Registering a key again retires the earlier registration, which stays on record.",
      body: {
        type: "object",
        required: ["public_key", "hosting", "signature"],
        properties: {
          public_key: { type: "string", minLength: 40, maxLength: 200 },
          hosting: { type: "string", enum: Object.keys(HOSTING_WORDS) },
          signature: { type: "string", minLength: 40, maxLength: 200 },
          declared_interest: { type: "string", maxLength: DECLARED_INTEREST_MAX_CHARS },
        },
      },
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const account = request.contributorExternalId;
      if (!account) return reply.code(403).send({ error: { code: "NO_CONTRIBUTOR_IDENTITY", message: "API key is not bound to a contributor identity" } });
      try {
        return reply.code(201).send(
          await registerPublisher({
            accountId: request.auth!.userId!,
            account,
            publicKey: request.body.public_key,
            hosting: request.body.hosting,
            signature: request.body.signature,
            declaredInterest: request.body.declared_interest,
          })
        );
      } catch (err) {
        return refuse(reply, err);
      }
    },
  });

  app.get<{ Params: { account_id: string } }>("/publishers/:account_id", {
    schema: {
      tags: ["published pages"],
      summary: "A publisher's public record: the keys it registered, where each deployment was said to run, and the pages it has published with their states",
      params: { type: "object", required: ["account_id"], properties: { account_id: UUID } },
    },
    handler: async (request, reply) => {
      const record = await publisherRecord(request.params.account_id);
      if (!record) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "This account has registered no deployment's key." } });
      return reply.send(record);
    },
  });

  app.post<{ Body: { package: unknown } }>("/published-pages", {
    // A package is larger than an ordinary request body and is parsed whole before its signature can be checked.
    bodyLimit: loadConfig().publishedPageMaxBytes + 4096,
    schema: {
      tags: ["published pages"],
      summary: "Submit a published page: a signed package from a deployment whose key your account registered",
      description:
        "A published page is another graph's page of a node, made there on evidence that is not public, as its Steward wrote it less what a policy " +
        "removed and what is held. The package is checked before anything is kept: its signature against your registered key, its released text " +
        "against the fingerprint recorded before anyone decided what to release, and its record's form. One that does not check out is refused with " +
        "what failed. The first package for a node under a showing files a contribution on that node, which is reviewed as any contribution is, and " +
        "is charged as a source submission, refunded if the review does not admit it. Admitted, the page is attached to the node as a source and its " +
        "Steward is told; the reassessment that takes it into the node's own assessment runs when someone funds it. Later packages of the same " +
        "publication are kept in order and cost nothing. The same package may be sent again and changes nothing.",
      body: { type: "object", required: ["package"], properties: { package: { type: "object", additionalProperties: true } } },
    },
    preHandler: app.authenticate,
    handler: async (request, reply) => {
      // Priced: the owl charge on a publication's first package bounds submissions, so no hourly count.
      const contributor = await gateContributor(request, reply, { priced: true });
      if (!contributor) return;
      let examined;
      try {
        examined = await examinePackage({ accountId: contributor.id, pkg: request.body.package });
      } catch (err) {
        return refuse(reply, err);
      }
      const first = !examined.already && !examined.publication?.contribution_id;
      // Charged like any source an account submits: the price buys the review the submission commands.
      const charge = first ? await chargeAgenticOp(request.auth, "source_ingest") : { allowed: true as const, entryId: null };
      if (!charge.allowed) return app.sendQuotaDenial(reply, charge);
      try {
        const admitted = await admitPackage(examined);
        if (first && charge.entryId && admitted.contribution_id) await attachChargeContribution(charge.entryId, admitted.contribution_id);
        return reply.code(admitted.status === "received" ? 201 : 200).send(admitted);
      } catch (err) {
        if (first) await refundAgenticOp(request.auth, "source_ingest").catch(() => {});
        return refuse(reply, err);
      }
    },
  });

  app.get<{ Querystring: { node_id?: string; account_id?: string } }>("/published-pages", {
    schema: {
      tags: ["published pages"],
      summary: "The published pages of a node, or of a publisher: each with its state now and where it stands on the node",
      description:
        "A published page is in one of four states: not_yet_assessed, released_whole, released_in_part (with how many parts are held and of which " +
        "kinds) or held (with why and since when). `on_the_node` says whether its submission was admitted, whether the page is on the node's page, " +
        "and which package of it the node's own assessment was made on, if any.",
      querystring: { type: "object", properties: { node_id: UUID, account_id: UUID } },
    },
    handler: async (request, reply) => {
      if (!request.query.node_id && !request.query.account_id) {
        return reply.code(400).send({ error: { code: "NEEDS_A_FILTER", message: "Name a node (node_id) or a publisher (account_id)." } });
      }
      return reply.send({ published_pages: await listPublishedPages({ nodeId: request.query.node_id, accountId: request.query.account_id }) });
    },
  });

  app.get<{ Params: { published_page_id: string }; Querystring: { package?: number } }>("/published-pages/:published_page_id", {
    schema: {
      tags: ["published pages"],
      summary: "One published page in the shape of a node's page, with removals marked and held parts in place, its record, its history and what was checked",
      description:
        "`page` is the page as its Steward wrote it: summary and reasoning by paragraph, arguments with their evaluations, readings of sources, " +
        "subclaims. A released part's text carries `[redacted: <category>]` where the publisher's policy removed a passage. A held part stands in its " +
        "place as what it was, who holds it and any reason given, which nobody checks. `record` is how the page was made, stamped by the publishing " +
        "deployment. `check` is what this graph confirmed when the package arrived and what such a check cannot show. Report the page as the " +
        "publisher's graph's assessment, apart from this graph's own assessment of the node.",
      params: { type: "object", required: ["published_page_id"], properties: { published_page_id: UUID } },
      querystring: { type: "object", properties: { package: { type: "integer", minimum: 1 } } },
    },
    handler: async (request, reply) => {
      const page = await readPublishedPage(request.params.published_page_id, { sequence: request.query.package });
      if (!page) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No published page has that id, or it has no such package." } });
      return reply.send(page);
    },
  });

  app.get<{ Params: { published_page_id: string }; Querystring: { package?: number } }>("/published-pages/:published_page_id/package", {
    schema: {
      tags: ["published pages"],
      summary: "One package of a published page exactly as it was signed, with the publisher's key as this graph holds it, for anyone to check",
      description:
        "`npx tsx scripts/published-page.ts verify <file>` checks a package with no database and no network, and says what it checked and what it could not.",
      params: { type: "object", required: ["published_page_id"], properties: { published_page_id: UUID } },
      querystring: { type: "object", properties: { package: { type: "integer", minimum: 1 } } },
    },
    handler: async (request, reply) => {
      const found = await packageAsSigned(request.params.published_page_id, request.query.package);
      if (!found) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No published page has that id, or it has no such package." } });
      return reply.send(found);
    },
  });
}
