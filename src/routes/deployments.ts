/**
 * Connected deployments, the public graph's routes (docs/organizations.md,
 * "Connecting"; #1118, phase 2).
 *
 * A deployment asks to connect with a key it made, signing the request
 * with that key (POST /deployments/connect), and asks whether it has been
 * approved (GET /deployments/connect/:code), signed the same way. An admin
 * of an organization opens the link, signed in as themselves, reads what is
 * asking (GET /connect-requests/:code) and approves or denies it. Once
 * approved, the deployment signs every request with its key, and reads
 * itself and its organization at GET /organizations/me.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config.js";
import {
  CONNECT_INTERVAL_SECONDS,
  CONNECT_TTL_MS,
  DeploymentError,
  approveConnect,
  askToConnect,
  connectRequestKey,
  connectState,
  denyConnect,
  approveByHand,
  listDeployments,
  listHostingTokens,
  makeHostingToken,
  revokeHostingToken,
  organizationForDeployment,
  readConnectRequest,
  recordNonce,
  replaceKey,
  retireDeployment,
  retireSelf,
} from "../services/deployment-service.js";
import { OrganizationError, requireMember } from "../services/organization-service.js";
import { DEPLOYMENT_GRANTS } from "../db/schema.js";
import {
  EMPTY_BODY_HASH,
  SIGNATURE_FAULT_WORDS,
  checkSignature,
  parseSignatureHeader,
  sha256Hex,
} from "../services/request-signature.js";

const TAGS = ["organizations"];
// `act` is phase 2's name for spend, speak, propose and take_up together; a
// deployment built before the split still asks for it (deployment-service.ts, readGrants).
const GRANT = { type: "string", enum: [...DEPLOYMENT_GRANTS, "act"] } as const;

async function answer<T>(reply: FastifyReply, fn: () => Promise<T>, status = 200): Promise<FastifyReply> {
  try {
    return reply.code(status).send(await fn());
  } catch (err) {
    if (err instanceof DeploymentError || err instanceof OrganizationError) {
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    throw err;
  }
}

/**
 * Check a request signed with a key that is not yet a deployment's: the
 * one a connect request names. The body is the parsed JSON, which the
 * deployment sends exactly as it signed it, so its hash is taken again
 * from the bytes the auth plugin saw where there are any.
 */
async function signedWith(request: FastifyRequest, reply: FastifyReply, publicKey: string): Promise<boolean> {
  const presented = parseSignatureHeader(String(request.headers.authorization ?? ""));
  if (!presented) {
    await reply.code(401).send({ error: SIGNATURE_FAULT_WORDS.MALFORMED, code: "SIGNATURE_MALFORMED" });
    return false;
  }
  const raw = (request as FastifyRequest & { rawSignedBody?: string }).rawSignedBody;
  const fault = checkSignature(presented, publicKey, {
    host: String(request.headers.host ?? ""),
    method: request.method,
    path: request.url,
    bodyHash: raw !== undefined ? sha256Hex(raw) : request.body === undefined ? EMPTY_BODY_HASH : sha256Hex(JSON.stringify(request.body)),
  });
  if (fault) {
    await reply.code(401).send({ error: SIGNATURE_FAULT_WORDS[fault], code: `SIGNATURE_${fault}` });
    return false;
  }
  if (request.method !== "GET" && !(await recordNonce(presented.keyId, presented.nonce))) {
    await reply.code(401).send({ error: "This signed request has been made already.", code: "SIGNATURE_REPLAYED" });
    return false;
  }
  return true;
}

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  const reader = [app.authenticate, app.requireUser];
  const session = [app.authenticate, app.requireSession, app.requireUser];
  const me = (request: FastifyRequest) => request.auth!.userId!;
  const web = () => loadConfig().publicWebBaseUrl.replace(/\/+$/, "");

  // The connect routes read the body's exact bytes, to check the signature
  // over them; JSON is parsed from those bytes after.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      (request as FastifyRequest & { rawSignedBody?: string }).rawSignedBody = body as string;
      try {
        done(null, body === "" ? undefined : JSON.parse(body as string));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    });

    scope.post<{
      Body: {
        public_key: string;
        name: string;
        hosting: string;
        grants?: string[];
        needs?: Array<{ grant: string; why?: string }>;
        address?: string;
        report_identifier?: string;
        hosting_token?: string;
      };
    }>("/deployments/connect", {
      schema: {
        tags: TAGS,
        summary:
          "A private deployment asks to be connected to an organization, signing the request with the key it made " +
          "(Authorization: Minerval-Deployment). Answers a short code and a link for an admin of the organization, " +
          "who approves it with the grants they choose",
        description:
          "`needs` says which grants the deployment's own settings need, each with why; the admin approving sees them ticked and " +
          "chooses from every grant. `grants` is the same list without why, as a deployment built before `needs` sends it. " +
          "`address` is the deployment's own web address: shown to the admin, linked to from the organization's Deployments tab, " +
          "and where the admin is sent back to after approving. It is never fetched. `hosting_token` is the token Minerval's provisioning " +
          "gave a deployment Minerval runs: `minerval` as the hosting is accepted only with a live one, and any other word is refused with one.",
        body: {
          type: "object",
          required: ["public_key", "name", "hosting"],
          properties: {
            public_key: { type: "string" },
            name: { type: "string" },
            hosting: { type: "string" },
            grants: { type: "array", items: GRANT },
            needs: {
              type: "array",
              items: { type: "object", required: ["grant"], properties: { grant: GRANT, why: { type: "string", maxLength: 300 } } },
            },
            address: { type: "string", maxLength: 500 },
            report_identifier: { type: "string" },
            hosting_token: { type: "string", maxLength: 200 },
          },
        },
      },
      handler: async (request, reply) => {
        if (!(await signedWith(request, reply, request.body.public_key))) return reply;
        return answer(
          reply,
          async () => {
            const asked = await askToConnect({
              publicKey: request.body.public_key,
              name: request.body.name,
              hosting: request.body.hosting,
              grants: request.body.grants,
              needs: request.body.needs,
              address: request.body.address,
              hostingToken: request.body.hosting_token,
              reportIdentifier: request.body.report_identifier,
            });
            return {
              code: asked.code,
              key_id: asked.key_id,
              verification_uri: `${web()}/connect`,
              verification_uri_complete: `${web()}/connect?code=${asked.code}`,
              expires_at: asked.expires_at,
              expires_in: CONNECT_TTL_MS / 1000,
              interval: CONNECT_INTERVAL_SECONDS,
            };
          },
          201
        );
      },
    });
  });

  app.get<{ Params: { code: string } }>("/deployments/connect/:code", {
    schema: {
      tags: TAGS,
      summary:
        "Whether a connect request has been approved, signed with the key it was made with: waiting, expired, denied, " +
        "or approved with the deployment, its organization and its grants",
      params: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
    },
    handler: async (request, reply) => {
      const key = await connectRequestKey(request.params.code);
      if (!key) return reply.code(404).send({ error: "No connection request has that code.", code: "CODE_NOT_FOUND" });
      if (!(await signedWith(request, reply, key))) return reply;
      return answer(reply, () => connectState(request.params.code));
    },
  });

  app.get<{ Params: { code: string } }>("/connect-requests/:code", {
    schema: {
      tags: TAGS,
      summary:
        "What a deployment asking to connect says of itself (its suggested name, the hosting it states, its key id, " +
        "its address, the grants its settings need and why), the organizations you are an admin of, to approve it for, and " +
        "those you are only a member of, with their admins, who can",
      params: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ request: await readConnectRequest(request.params.code, me(request)) })),
  });

  app.post<{ Params: { code: string }; Body: { organization_id: string; name?: string; grants: string[]; allowance_owls?: number } }>(
    "/connect-requests/:code/approve",
    {
      schema: {
        tags: TAGS,
        summary:
          "Approve a deployment for an organization you are an admin of, with the grants you choose, and an allowance on spend " +
          "if you set one. The code is used once. Approve only if a deployment of yours shows this code and key id now. " +
          "Answers return_to, the deployment's own Overview at the address it stated, where it has one",
        params: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
        body: {
          type: "object",
          required: ["organization_id", "grants"],
          properties: {
            organization_id: { type: "string" },
            name: { type: "string" },
            grants: { type: "array", items: GRANT },
            allowance_owls: { type: "number", minimum: 0 },
          },
        },
      },
      preHandler: session,
      handler: (request, reply) =>
        answer(reply, () =>
          approveConnect({
            code: request.params.code,
            organizationId: request.body.organization_id,
            name: request.body.name,
            grants: request.body.grants,
            allowanceOwls: request.body.allowance_owls,
            by: me(request),
          })
        ),
    }
  );

  app.post<{ Params: { code: string } }>("/connect-requests/:code/deny", {
    schema: {
      tags: TAGS,
      summary: "Deny a deployment's request to connect. The deployment is told it was denied",
      params: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        await denyConnect({ code: request.params.code, by: me(request) });
        return { denied: true };
      }),
  });

  app.get("/organizations/me", {
    schema: {
      tags: TAGS,
      summary:
        "For a connected deployment, signed with its key: its organization, itself, the grants it holds, and the live " +
        "publisher registrations of its organization",
    },
    preHandler: reader,
    handler: (request, reply) => {
      const deployment = request.auth?.deployment;
      if (!deployment) {
        return reply.code(403).send({
          error: "This is read by a connected deployment, with its signed key.",
          code: "DEPLOYMENT_REQUIRED",
        });
      }
      return answer(reply, () => organizationForDeployment(deployment.id));
    },
  });

  app.post("/deployments/me/retire", {
    schema: {
      tags: TAGS,
      summary:
        "A connected deployment, signed with its key, retires itself: its key stops working at once and its grants are withdrawn. " +
        "Its administrators disconnect it this way; it can connect again with a new key",
    },
    preHandler: reader,
    handler: (request, reply) => {
      const deployment = request.auth?.deployment;
      if (!deployment) {
        return reply.code(403).send({ error: "This is sent by a connected deployment, with its signed key.", code: "DEPLOYMENT_REQUIRED" });
      }
      return answer(reply, async () => {
        await retireSelf(deployment.id);
        return { retired: true };
      });
    },
  });

  app.post<{ Body: { public_key: string; proof: string } }>("/deployments/me/key", {
    schema: {
      tags: TAGS,
      summary:
        "A connected deployment, signed with its current key, replaces it with a new one: the old key stops at once, and its grants, " +
        "its record and its organization stay. `proof` is the new key's signature over the replacement statement, so the old key " +
        "alone cannot hand the deployment to a key nobody holds",
      body: {
        type: "object",
        required: ["public_key", "proof"],
        properties: { public_key: { type: "string", maxLength: 200 }, proof: { type: "string", maxLength: 200 } },
      },
    },
    preHandler: reader,
    handler: (request, reply) => {
      const deployment = request.auth?.deployment;
      if (!deployment) {
        return reply.code(403).send({ error: "This is sent by a connected deployment, with its signed key.", code: "DEPLOYMENT_REQUIRED" });
      }
      return answer(reply, () => replaceKey({ deploymentId: deployment.id, publicKey: request.body.public_key, proof: request.body.proof }));
    },
  });

  app.delete<{ Params: { id: string; deployment_id: string } }>("/organizations/:id/deployments/:deployment_id", {
    schema: {
      tags: TAGS,
      summary:
        "Retire one of an organization's deployments (its admins, from a signed-in session): its key stops at once and its grants are " +
        "withdrawn. The deployment learns it the next time it asks. It can connect again with a new key and a new approval",
      params: {
        type: "object",
        required: ["id", "deployment_id"],
        properties: { id: { type: "string" }, deployment_id: { type: "string" } },
      },
    },
    preHandler: session,
    handler: (request, reply) =>
      answer(reply, async () => {
        await retireDeployment({ organizationId: request.params.id, deploymentId: request.params.deployment_id, by: me(request) });
        return { retired: true };
      }),
  });

  app.post<{ Params: { id: string }; Body: { request: string; name?: string; grants: string[]; allowance_owls?: number } }>(
    "/organizations/:id/deployments/by-hand",
    {
      schema: {
        tags: TAGS,
        summary:
          "Approve a deployment the network does not join to minerval.ai (an admin, from a signed-in session), from the connection " +
          "request it showed, carried by hand and pasted in whole. Checked as a request over the network is: signed by the key it names, " +
          "made within seven days. The deployment needs nothing back; what it sends travels as files",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          required: ["request", "grants"],
          properties: {
            request: { type: "string", minLength: 1, maxLength: 20_000 },
            name: { type: "string" },
            grants: { type: "array", items: GRANT },
            allowance_owls: { type: "number", minimum: 0 },
          },
        },
      },
      preHandler: session,
      handler: (request, reply) =>
        answer(
          reply,
          () =>
            approveByHand({
              organizationId: request.params.id,
              request: request.body.request,
              name: request.body.name,
              grants: request.body.grants,
              allowanceOwls: request.body.allowance_owls,
              by: me(request),
            }),
          201
        ),
    }
  );

  // ---- hosted by Minerval: the operator's tokens (docs/organizations.md, "Hosted by Minerval") ----

  app.post<{ Body: { note: string } }>("/operator/hosted-deployment-tokens", {
    schema: {
      tags: TAGS,
      summary:
        "Make a hosting token for a deployment Minerval provisions (the operator key). The token is answered once and goes in that " +
        "deployment's MINERVAL_HOSTING_TOKEN; with it, and only with it, a deployment may say it runs on Minerval's machines",
      body: { type: "object", required: ["note"], properties: { note: { type: "string", minLength: 1, maxLength: 300 } } },
    },
    preHandler: [app.requireOperator],
    handler: (request, reply) => answer(reply, () => makeHostingToken(request.body.note), 201),
  });

  app.get("/operator/hosted-deployment-tokens", {
    schema: {
      tags: TAGS,
      summary: "The hosting tokens made, each with the deployment it was last used by (the operator key). The tokens themselves are never answered",
    },
    preHandler: [app.requireOperator],
    handler: (_request, reply) => answer(reply, async () => ({ tokens: await listHostingTokens() })),
  });

  app.delete<{ Params: { id: string } }>("/operator/hosted-deployment-tokens/:id", {
    schema: {
      tags: TAGS,
      summary: "Revoke a hosting token (the operator key): no deployment connects with it again. One connected with it stays connected",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: [app.requireOperator],
    handler: (request, reply) =>
      answer(reply, async () => {
        await revokeHostingToken(request.params.id);
        return { revoked: true };
      }),
  });

  app.get<{ Params: { id: string } }>("/organizations/:id/deployments", {
    schema: {
      tags: TAGS,
      summary:
        "An organization's connected deployments, live and retired: the hosting each states, its key id, its grants, " +
        "who approved it, and the writes it signed lately (its members only). Reads are not recorded",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) =>
      answer(reply, async () => {
        await requireMember(request.params.id, me(request));
        return { deployments: await listDeployments(request.params.id) };
      }),
  });
}
