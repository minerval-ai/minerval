/**
 * Routes for the prizes surfaces (docs/mathematics.md §11.1, §8.11).
 * Registered without a prefix because the paths span /claims, /prizes,
 * /prize-claims, /bounties, /prize-pools, /attachments, and /operator.
 *
 * Credentials: reads are public; the filing and the challenge run through
 * `authenticate` + `gateContributor` (no agentic quota, no owl charge); the
 * withdrawal and the payee steps require the dashboard session plus a
 * one-time code; the deposit, the confirmation, the sign-off, the void, the
 * screening, and the operator page require the operator key
 * (`requireOperator`). Every call to a money route is written to audit_log
 * with the credential kind and the acting person.
 *
 * Multipart (`@fastify/multipart`) is registered in a child scope holding
 * only the two upload routes, so no other route parses multipart bodies.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { gateContributor } from "../server/contributor-gate.js";
import { getContributorById } from "../services/contributor-service.js";
import {
  PRIZE_RULES_TEXT,
  PRIZE_RULES_VERSION,
  bountySummary,
  bountyTerms,
  confirmBounty,
  getBountyById,
  getLatestBountyForClaim,
  listOpenBounties,
  openBountiesAtom,
  prizeRulesContentHash,
} from "../services/bounty-service.js";
import { depositToPool, getPoolPublicView } from "../services/prize-pool-service.js";
import {
  challengePrizeClaim,
  filePrizeClaim,
  getPrizeClaimById,
  issuePrizeClaimCode,
  listPrizeClaimsForClaim,
  operatorPrizeQueue,
  prizeClaimEligibility,
  prizeClaimPublicView,
  prizeClaimSummary,
  signOffPrizeClaim,
  verifyPrizeClaimCode,
  voidPrizeClaim,
  withdrawPrizeClaim,
  VOID_GROUNDS,
  type VoidGround,
} from "../services/prize-claim-service.js";
import {
  payPrize,
  recordPayeeIdentity,
  recordScreening,
  recordTaxForm,
} from "../services/prize-payout-service.js";
import {
  canReadAttachment,
  downloadHeaders,
  getAttachment,
  getAttachmentBody,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_FILES,
  type IncomingFile,
} from "../services/attachment-service.js";
import { retryCheckError } from "../workers/prize-check-pipeline.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Which person acted, for the audit trail of the money routes. */
function operatorActor(request: FastifyRequest): string {
  const who = request.headers["x-operator-actor"];
  const name = Array.isArray(who) ? who[0] : who;
  return (name ?? "").toString().trim().slice(0, 120) || "operator";
}

async function logMoneyRoute(claimId: string | null, action: string, reasoning: string, actor: string): Promise<void> {
  if (!claimId) return;
  await rawQuery(
    `INSERT INTO audit_log (claim_id, action, reasoning, created_by) VALUES ($1, $2, $3, $4)`,
    [claimId, action, reasoning, actor]
  ).catch(() => undefined);
}

interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<string, IncomingFile[]>;
}

/** Collect a multipart body into bounded buffers; the service validates. */
async function readMultipart(request: FastifyRequest): Promise<ParsedMultipart> {
  const fields: Record<string, string> = {};
  const files: Record<string, IncomingFile[]> = {};
  const parts = (request as FastifyRequest & { parts: () => AsyncIterable<any> }).parts();
  for await (const part of parts) {
    if (part.type === "file") {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file as AsyncIterable<Buffer>) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (part.file.truncated) {
        throw Object.assign(new Error(`${part.filename} exceeds the size limit`), { statusCode: 422, code: "INVALID_SUBMISSION" });
      }
      (files[part.fieldname] ??= []).push({ filename: String(part.filename ?? part.fieldname), body });
    } else {
      fields[part.fieldname] = typeof part.value === "string" ? part.value : String(part.value ?? "");
    }
  }
  return { fields, files };
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function prizesRoutes(app: FastifyInstance): Promise<void> {
  // Authenticate only when the caller presented credentials; reads stay open.
  const optionalAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers["x-api-key"] || request.headers.authorization) {
      await app.authenticate(request, reply);
    }
  };
  const viewerOf = (request: FastifyRequest) => ({
    userId: request.auth?.userId ?? null,
    isService: request.auth?.isService === true && !request.auth.isSession,
    isOperator: false,
  });
  const sessionOk = (request: FastifyRequest) =>
    request.auth?.isSession === true || (request.auth?.method === "dev_bypass" && !!request.auth.userId);

  // ---------------------------------------------------------------- reads

  app.get("/prizes/rules", { schema: { tags: ["prizes"], summary: "The official rules in force (plain text)" } }, async (_req, reply) => {
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("x-rules-version", PRIZE_RULES_VERSION)
      .header("x-content-hash", prizeRulesContentHash())
      .send(PRIZE_RULES_TEXT);
  });

  app.get<{ Params: { version: string } }>("/prizes/rules/:version", { schema: { tags: ["prizes"], summary: "One version of the official rules" } }, async (request, reply) => {
    if (request.params.version !== PRIZE_RULES_VERSION) {
      return reply.code(404).send(errorBody("NOT_FOUND", `rules version ${request.params.version} is not retained here`));
    }
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("x-rules-version", PRIZE_RULES_VERSION)
      .header("x-content-hash", prizeRulesContentHash())
      .send(PRIZE_RULES_TEXT);
  });

  app.get<{ Querystring: { limit?: number; offset?: number } }>("/prizes", {
    schema: {
      tags: ["prizes"],
      summary: "Open bounties across the graph, largest first, paged",
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
    handler: async (request, reply) => {
      const { items, total } = await listOpenBounties({ limit: request.query.limit, offset: request.query.offset });
      return reply.send({ prizes: items, total, rules_version: PRIZE_RULES_VERSION });
    },
  });

  app.get("/prizes.atom", { schema: { tags: ["prizes"], summary: "Open bounties as an Atom feed" } }, async (request, reply) => {
    const { items } = await listOpenBounties({ limit: 50 });
    const base = `${request.protocol}://${request.hostname}`;
    return reply.header("content-type", "application/atom+xml; charset=utf-8").send(openBountiesAtom(items, base));
  });

  app.get<{ Params: { domain: string } }>("/prize-pools/:domain", { schema: { tags: ["prizes"], summary: "The fund's balance and entries by reason" } }, async (request, reply) => {
    const view = await getPoolPublicView(request.params.domain);
    if (!view) return reply.code(404).send(errorBody("NOT_FOUND", "no prize fund for that domain"));
    return reply.send({ pool: view });
  });

  app.get<{ Params: { id: string } }>("/claims/:id/bounty", { schema: { tags: ["prizes"], summary: "The claim's bounty and the terms an outside solver needs" } }, async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(404).send(errorBody("NOT_FOUND", "claim not found"));
    const bounty = await getLatestBountyForClaim(request.params.id);
    if (!bounty) return reply.code(404).send(errorBody("NOT_FOUND", "no bounty on this claim"));
    const summary = await bountySummary(bounty);
    return reply.send({ bounty: summary, terms: bountyTerms(bounty, summary) });
  });

  app.get<{ Params: { id: string } }>("/claims/:id/prize-claims", { schema: { tags: ["prizes"], summary: "Every prize claim on the claim, rejected and superseded ones included" } }, async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return reply.code(404).send(errorBody("NOT_FOUND", "claim not found"));
    const rows = await listPrizeClaimsForClaim(request.params.id);
    return reply.send({ prize_claims: rows.map(prizeClaimSummary) });
  });

  app.get<{ Params: { id: string } }>("/claims/:id/prize-claims/eligibility", {
    schema: { tags: ["prizes"], summary: "Whether the signed-in account may file a prize claim here" },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const contributor = await getContributorById(request.auth!.userId!);
      if (!contributor) return reply.code(403).send(errorBody("USER_IDENTITY_REQUIRED", "unknown account"));
      return reply.send({ eligibility: await prizeClaimEligibility(request.params.id, contributor) });
    },
  });

  app.get<{ Params: { id: string } }>("/prize-claims/:id", {
    schema: { tags: ["prizes"], summary: "One prize claim's public projection; the owner and service callers see more" },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      if (!UUID_RE.test(request.params.id)) return reply.code(404).send(errorBody("NOT_FOUND", "prize claim not found"));
      const row = await getPrizeClaimById(request.params.id);
      if (!row) return reply.code(404).send(errorBody("NOT_FOUND", "prize claim not found"));
      return reply.send({ prize_claim: await prizeClaimPublicView(row, viewerOf(request)) });
    },
  });

  app.get<{ Params: { id: string } }>("/attachments/:id", {
    schema: { tags: ["prizes"], summary: "An attachment body (public once visibility is public; owner or service before)" },
    preHandler: [optionalAuth],
    handler: async (request, reply) => {
      if (!UUID_RE.test(request.params.id)) return reply.code(404).send(errorBody("NOT_FOUND", "attachment not found"));
      const row = await getAttachment(request.params.id);
      if (!row) return reply.code(404).send(errorBody("NOT_FOUND", "attachment not found"));
      const operatorKey = request.headers["x-operator-key"];
      const presented = Array.isArray(operatorKey) ? operatorKey[0] : operatorKey;
      const { operatorKeyMatches } = await import("../server/plugins/auth.js");
      const viewer = { ...viewerOf(request), isOperator: operatorKeyMatches(loadConfig().minervalOperatorKey, presented) };
      if (!canReadAttachment(row, viewer)) {
        return reply.code(row.visibility === "public" ? 404 : 403).send(errorBody("FORBIDDEN", "this attachment is restricted"));
      }
      const body = await getAttachmentBody(row.id);
      if (!body) return reply.code(404).send(errorBody("NOT_FOUND", "attachment body not stored here"));
      return reply.headers(downloadHeaders(row)).send(body);
    },
  });

  // ------------------------------------------------------------- uploads

  await app.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        fileSize: DOCUMENT_MAX_BYTES,
        files: DOCUMENT_MAX_FILES + 1,
        fields: 40,
        fieldSize: 64 * 1024,
      },
    });

    // POST /claims/:claim_id/prize-claims — the filing (§8.4).
    scope.post<{ Params: { claim_id: string } }>("/claims/:claim_id/prize-claims", {
      schema: { tags: ["prizes"], summary: "File a prize claim (multipart): the account, the Lean source, documents, disclosures, declarations" },
      preHandler: [scope.authenticate],
      handler: async (request, reply) => {
        if (!UUID_RE.test(request.params.claim_id)) return reply.code(404).send(errorBody("NOT_FOUND", "claim not found"));
        const contributor = await gateContributor(request, reply);
        if (!contributor) return;
        let parsed: ParsedMultipart;
        try {
          parsed = await readMultipart(request);
        } catch (err) {
          const e = err as { statusCode?: number; message?: string };
          return reply.code(e.statusCode ?? 422).send(errorBody("INVALID_SUBMISSION", e.message ?? "unreadable multipart body"));
        }
        const f = parsed.fields;
        const leanFile = parsed.files.lean_source?.[0] ?? null;
        const leanText = f.lean_source_text;
        const leanSource: IncomingFile | null = leanFile ?? (leanText ? { filename: "proof.lean", body: Buffer.from(leanText, "utf8") } : null);
        const links = parseJson<string[]>(f.links, f.links ? f.links.split(/\s+/).filter(Boolean) : []);
        const result = await filePrizeClaim({
          claimId: request.params.claim_id,
          claimant: contributor,
          formalizationId: f.formalization_id ?? "",
          direction: f.direction ?? "",
          content: f.content ?? "",
          links: Array.isArray(links) ? links : [],
          leanSource,
          documents: parsed.files.documents ?? [],
          toolsDisclosure: f.tools_disclosure ?? "",
          residency: {
            country: (f.residency_country ?? "").toUpperCase(),
            us_person: f.us_person === "true" ? true : f.us_person === "false" ? false : null,
          },
          creditName: f.credit_name ?? "",
          declarations: parseJson<Record<string, unknown>>(f.declarations, {}),
          rulesVersion: f.rules_version ?? "",
        });
        if (!result.ok) {
          return reply.code(result.status).send({ error: { code: result.code, message: result.message, ...(result.retry_at ? { retry_at: result.retry_at } : {}) } });
        }
        return reply.code(201).send({ prize_claim: result });
      },
    });

    // POST /prize-claims/:id/attachments — the tax form (session plus code).
    scope.post<{ Params: { id: string } }>("/prize-claims/:id/attachments", {
      schema: { tags: ["prizes"], summary: "Upload the winner's tax form (W-9 or W-8BEN) as a restricted attachment" },
      preHandler: [scope.authenticate, scope.requireUser],
      handler: async (request, reply) => {
        if (!sessionOk(request)) return reply.code(403).send(errorBody("SESSION_REQUIRED", "the payee steps require the dashboard session"));
        let parsed: ParsedMultipart;
        try {
          parsed = await readMultipart(request);
        } catch (err) {
          const e = err as { message?: string };
          return reply.code(422).send(errorBody("INVALID_SUBMISSION", e.message ?? "unreadable multipart body"));
        }
        const userId = request.auth!.userId!;
        if (!verifyPrizeClaimCode(parsed.fields.code ?? "", { prizeClaimId: request.params.id, userId, purpose: "payee" })) {
          return reply.code(403).send(errorBody("CODE_REQUIRED", "a valid one-time code for this prize claim is required"));
        }
        const file = parsed.files.tax_form?.[0];
        if (!file) return reply.code(422).send(errorBody("INVALID_SUBMISSION", "a tax_form file is required"));
        const res = await recordTaxForm({ prizeClaimId: request.params.id, userId, kind: parsed.fields.kind as "w9" | "w8ben", file });
        if (!res.ok) return reply.code(res.status).send(errorBody("TAX_FORM_REFUSED", res.message));
        const pc = await getPrizeClaimById(request.params.id);
        await logMoneyRoute(pc?.claim_id ?? null, "prize_route:tax_form", `prize claim ${request.params.id}: tax form uploaded (session + code)`, `contributor:${userId}`);
        return reply.code(201).send({ attachment_id: res.attachment_id });
      },
    });
  });

  // ------------------------------------------------- the claimant's routes

  app.post<{ Params: { id: string } }>("/prize-claims/:id/code", {
    schema: { tags: ["prizes"], summary: "Issue a one-time code for the withdrawal or the payee step (returned to the owner's session only; nothing is sent in v1)" },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      if (!sessionOk(request)) return reply.code(403).send(errorBody("SESSION_REQUIRED", "codes are issued to the dashboard session only"));
      const pc = await getPrizeClaimById(request.params.id);
      if (!pc) return reply.code(404).send(errorBody("NOT_FOUND", "prize claim not found"));
      if (pc.claimant_id !== request.auth!.userId) return reply.code(403).send(errorBody("FORBIDDEN", "only the claimant receives a code"));
      const body = (request.body ?? {}) as { purpose?: string };
      const purpose = body.purpose === "withdraw" ? "withdraw" : body.purpose === "payee" ? "payee" : null;
      if (!purpose) return reply.code(422).send(errorBody("BAD_PURPOSE", "purpose must be withdraw or payee"));
      const issued = issuePrizeClaimCode({ prizeClaimId: pc.id, userId: pc.claimant_id, purpose });
      return reply.send({ ...issued, purpose, delivery: "returned to your session; no message is sent in this version" });
    },
  });

  app.post<{ Params: { id: string }; Body: { code?: string } }>("/prize-claims/:id/withdraw", {
    schema: { tags: ["prizes"], summary: "Withdraw your prize claim (dashboard session plus a one-time code)" },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      if (!sessionOk(request)) return reply.code(403).send(errorBody("SESSION_REQUIRED", "withdrawal requires the dashboard session"));
      const userId = request.auth!.userId!;
      if (!verifyPrizeClaimCode(request.body?.code ?? "", { prizeClaimId: request.params.id, userId, purpose: "withdraw" })) {
        return reply.code(403).send(errorBody("CODE_REQUIRED", "a valid one-time code for this prize claim is required"));
      }
      const res = await withdrawPrizeClaim({ prizeClaimId: request.params.id, userId });
      if (!res.ok) return reply.code(res.status).send(errorBody("WITHDRAW_REFUSED", res.message));
      const pc = await getPrizeClaimById(request.params.id);
      await logMoneyRoute(pc?.claim_id ?? null, "prize_route:withdraw", `prize claim ${request.params.id}: withdrawn (session + code)`, `contributor:${userId}`);
      return reply.send({ prize_claim_id: request.params.id, status: res.status });
    },
  });

  app.post<{ Params: { id: string }; Body: { code?: string; legal_name?: string; country?: string; us_person?: boolean; has_tin?: boolean; treaty_position?: boolean } }>("/prize-claims/:id/payee", {
    schema: { tags: ["prizes"], summary: "Record identity and residency for payment (dashboard session plus a one-time code)" },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      if (!sessionOk(request)) return reply.code(403).send(errorBody("SESSION_REQUIRED", "the payee steps require the dashboard session"));
      const userId = request.auth!.userId!;
      const body = request.body ?? {};
      if (!verifyPrizeClaimCode(body.code ?? "", { prizeClaimId: request.params.id, userId, purpose: "payee" })) {
        return reply.code(403).send(errorBody("CODE_REQUIRED", "a valid one-time code for this prize claim is required"));
      }
      const res = await recordPayeeIdentity({
        prizeClaimId: request.params.id,
        userId,
        legalName: String(body.legal_name ?? ""),
        country: String(body.country ?? ""),
        usPerson: body.us_person === true,
        hasTin: body.has_tin === true,
        treatyPosition: body.treaty_position === true,
      });
      if (!res.ok) return reply.code(res.status).send(errorBody("PAYEE_REFUSED", res.message));
      const pc = await getPrizeClaimById(request.params.id);
      await logMoneyRoute(pc?.claim_id ?? null, "prize_route:payee", `prize claim ${request.params.id}: identity and residency recorded (session + code)`, `contributor:${userId}`);
      return reply.send({ prize_claim_id: request.params.id, payee: { country: res.payee.country, us_person: res.payee.us_person, identity_recorded_at: res.payee.identity_recorded_at } });
    },
  });

  app.post<{ Params: { id: string }; Body: { ground?: string; content?: string; evidence_urls?: string[] } }>("/prize-claims/:id/challenge", {
    schema: { tags: ["prizes"], summary: "Challenge an accepted prize claim on an enumerated ground, with evidence" },
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const contributor = await gateContributor(request, reply);
      if (!contributor) return;
      const body = request.body ?? {};
      const res = await challengePrizeClaim({
        prizeClaimId: request.params.id,
        contributorId: contributor.id,
        ground: String(body.ground ?? ""),
        content: String(body.content ?? ""),
        evidenceUrls: Array.isArray(body.evidence_urls) ? body.evidence_urls.map(String) : [],
      });
      if (!res.ok) return reply.code(res.status).send(errorBody("CHALLENGE_REFUSED", res.message));
      const { enqueueContribution } = await import("../services/queue-service.js");
      await enqueueContribution({ contributionId: res.contribution_id }).catch(() => undefined);
      return reply.code(201).send({ contribution_id: res.contribution_id });
    },
  });

  // ------------------------------------------------------- operator routes

  app.post<{ Params: { domain: string }; Body: { amount_cents?: number; bank_reference?: string; batch_key?: string } }>("/prize-pools/:domain/deposit", {
    schema: { tags: ["prizes"], summary: "Record a platform deposit into the fund (operator key; idempotent under batch_key)" },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const body = request.body ?? {};
      const res = await depositToPool({
        domain: request.params.domain,
        amount_cents: Number(body.amount_cents),
        bank_reference: String(body.bank_reference ?? ""),
        batch_key: String(body.batch_key ?? ""),
      });
      if (!res.ok) return reply.code(422).send(errorBody(res.code, res.message));
      return reply.code(res.duplicate ? 200 : 201).send({ entry_id: res.entry_id, duplicate: res.duplicate, pool: res.numbers, recorded_by: operatorActor(request) });
    },
  });

  app.post<{ Params: { id: string } }>("/bounties/:id/confirm", {
    schema: { tags: ["prizes"], summary: "Confirm a bounty at or above the autonomy threshold (operator key)" },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const actor = operatorActor(request);
      const res = await confirmBounty({ bountyId: request.params.id, confirmedBy: actor });
      if (!res.ok) return reply.code(res.code === "BOUNTY_NOT_FOUND" ? 404 : 409).send(errorBody(res.code, res.message));
      const bounty = await getBountyById(request.params.id);
      await logMoneyRoute(bounty?.claim_id ?? null, "prize_route:confirm", `bounty ${request.params.id}: confirmed with the operator key`, `operator:${actor}`);
      return reply.send({ bounty_id: res.bounty_id, status: res.status });
    },
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>("/prize-claims/:id/sign-off", {
    schema: { tags: ["prizes"], summary: "Human sign-off on a prize claim (operator key)" },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const actor = operatorActor(request);
      const res = await signOffPrizeClaim({ prizeClaimId: request.params.id, by: actor, note: String(request.body?.note ?? "") });
      if (!res.ok) return reply.code(409).send(errorBody("SIGNOFF_REFUSED", res.message));
      const pc = await getPrizeClaimById(request.params.id);
      await logMoneyRoute(pc?.claim_id ?? null, "prize_route:sign_off", `prize claim ${request.params.id}: signed off with the operator key`, `operator:${actor}`);
      return reply.send({ prize_claim_id: request.params.id, signed_off_by: actor });
    },
  });

  app.post<{ Params: { id: string }; Body: { ground?: string; note?: string } }>("/prize-claims/:id/void", {
    schema: { tags: ["prizes"], summary: "Void a prize claim with a ground and a public note (operator key)" },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const actor = operatorActor(request);
      const ground = String(request.body?.ground ?? "operator");
      if (!(VOID_GROUNDS as readonly string[]).includes(ground)) {
        return reply.code(422).send(errorBody("BAD_GROUND", `ground must be one of ${VOID_GROUNDS.join(", ")}`));
      }
      const res = await voidPrizeClaim({ prizeClaimId: request.params.id, ground: ground as VoidGround, note: String(request.body?.note ?? ""), actor: `operator:${actor}` });
      if (!res.ok) return reply.code(409).send(errorBody("VOID_REFUSED", res.message));
      const pc = await getPrizeClaimById(request.params.id);
      await logMoneyRoute(pc?.claim_id ?? null, "prize_route:void", `prize claim ${request.params.id}: voided with the operator key (${ground})`, `operator:${actor}`);
      return reply.send({ prize_claim_id: request.params.id, status: res.status, bounty_status: res.bounty_status });
    },
  });

  app.post<{ Params: { id: string }; Body: { result?: string; note?: string } }>("/prize-claims/:id/screening", {
    schema: { tags: ["prizes"], summary: "Record the sanctions screening result (operator key)" },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const actor = operatorActor(request);
      const res = await recordScreening({ prizeClaimId: request.params.id, result: String(request.body?.result ?? ""), recordedBy: actor, note: request.body?.note });
      if (!res.ok) return reply.code(res.status).send(errorBody("SCREENING_REFUSED", res.message));
      return reply.send({ prize_claim_id: request.params.id, recorded_by: actor });
    },
  });

  app.post<{ Params: { id: string } }>("/prize-claims/:id/pay", {
    schema: { tags: ["prizes"], summary: "Grant the prize in owls once every precondition holds (operator key)" },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const actor = operatorActor(request);
      const res = await payPrize(request.params.id, { actor: `operator:${actor}` });
      if (!res.ok) return reply.code(res.code === "NOT_FOUND" ? 404 : 409).send(errorBody(res.code, res.message));
      const pc = await getPrizeClaimById(request.params.id);
      await logMoneyRoute(pc?.claim_id ?? null, "prize_route:pay", `prize claim ${request.params.id}: paid with the operator key`, `operator:${actor}`);
      return reply.send({ payout: res });
    },
  });

  app.post<{ Params: { id: string } }>("/prize-claims/:id/retry-check", {
    schema: { tags: ["prizes"], summary: "Release a check_error hold (operator key)" },
    preHandler: [app.requireOperator],
    handler: async (request, reply) => {
      const ok = await retryCheckError(request.params.id, `operator:${operatorActor(request)}`);
      if (!ok) return reply.code(409).send(errorBody("NOT_CHECK_ERROR", "the prize claim is not in check_error"));
      return reply.send({ prize_claim_id: request.params.id, status: "queued" });
    },
  });

  app.get("/operator/prizes", {
    schema: { tags: ["prizes"], summary: "What waits for the operator: sign-offs, check errors, stale house results, confirmations, payee steps" },
    preHandler: [app.requireOperator],
    handler: async (_request, reply) => reply.send({ operator: await operatorPrizeQueue() }),
  });
}
