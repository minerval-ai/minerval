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
  listDeployments,
  organizationForDeployment,
  readConnectRequest,
  recordNonce,
} from "../services/deployment-service.js";
import { OrganizationError, requireMember } from "../services/organization-service.js";
import {
  EMPTY_BODY_HASH,
  SIGNATURE_FAULT_WORDS,
  checkSignature,
  parseSignatureHeader,
  sha256Hex,
} from "../services/request-signature.js";

const TAGS = ["organizations"];
const GRANT = { type: "string", enum: ["read_feed", "report_usage", "publish", "act"] } as const;

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
      Body: { public_key: string; name: string; hosting: string; grants: string[]; report_identifier?: string };
    }>("/deployments/connect", {
      schema: {
        tags: TAGS,
        summary:
          "A private deployment asks to be connected to an organization, signing the request with the key it made " +
          "(Authorization: Minerval-Deployment). Answers a short code and a link for an admin of the organization, " +
          "who approves it with the grants they choose",
        body: {
          type: "object",
          required: ["public_key", "name", "hosting", "grants"],
          properties: {
            public_key: { type: "string" },
            name: { type: "string" },
            hosting: { type: "string" },
            grants: { type: "array", items: GRANT, minItems: 1 },
            report_identifier: { type: "string" },
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
        "the grants it asks for), and the organizations you are an admin of, to approve it for",
      params: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
    },
    preHandler: reader,
    handler: (request, reply) => answer(reply, async () => ({ request: await readConnectRequest(request.params.code, me(request)) })),
  });

  app.post<{ Params: { code: string }; Body: { organization_id: string; name?: string; grants: string[] } }>(
    "/connect-requests/:code/approve",
    {
      schema: {
        tags: TAGS,
        summary:
          "Approve a deployment for an organization you are an admin of, with the grants you choose from those it asked for. " +
          "The code is used once. Approve only if a deployment of yours shows this code and key id now",
        params: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
        body: {
          type: "object",
          required: ["organization_id", "grants"],
          properties: { organization_id: { type: "string" }, name: { type: "string" }, grants: { type: "array", items: GRANT } },
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
