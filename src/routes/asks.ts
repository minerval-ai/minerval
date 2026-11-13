/**
 * Asking for work at a label above (services/ask-above-service.ts): the
 * person's side. What can be asked, and the ask itself. The ask is a
 * request at the label its address is shown at, so everything else about it
 * is read through the request routes.
 */
import type { FastifyInstance } from "fastify";
import { requirePermission } from "../server/require-permission.js";
import { currentClearance, runAtLabel } from "../llm/usage-context.js";
import { rawQuery } from "../db/client.js";
import { askAbove } from "../services/ask-above-service.js";
import { owlsToMicroUsd } from "../services/owl.js";

const UUID = { type: "string", format: "uuid" } as const;

export const ASK_TOLD =
  "The ask is recorded as a request at the label the address is shown at, in your words, with the budget you paid: that request is " +
  "your record of it, and other readers of that label see it as they see any request. The work is done at the label asked, by agents " +
  "that read what it reads. One piece of work is taken up once by the agent that does it; a mandate is given its own Grantmaker, " +
  "which plans it and may close it as it would any scope it should not accept. Whether it was taken up, what was found and what it " +
  "cost reach you only through that label's gate, where each may be redacted or held. What is not spent returns to your balance.";

export async function askRoutes(app: FastifyInstance): Promise<void> {
  const signedIn = [app.authenticate, app.requireUser];
  const funds = [app.authenticate, app.requireSession, app.requireUser, requirePermission("fund")];

  app.get("/asks/askable", {
    schema: {
      tags: ["requests"],
      summary: "What can be asked for work at labels you do not read",
      description:
        "Each entry is the public face of a label above one you read: a name and a line, written by its administrators, saying what can " +
        "be asked of it. `shown_at` is the label of yours it is shown at, which is where an ask addressed to it is recorded. A label " +
        "with no face here cannot be asked.",
    },
    preHandler: signedIn,
    handler: async (_request, reply) => {
      // Read as the person: a face shown at a label they do not read is not returned. One of a label they read needs no asking.
      const faces = await rawQuery<{ id: string; name: string; can_be_asked: string; shown_at: string }>(
        `SELECT id, name, can_be_asked, sensitivity_label AS shown_at FROM label_faces
          WHERE withdrawn_at IS NULL AND NOT (for_label = ANY($1::text[])) ORDER BY name, id`,
        [[...currentClearance()]]
      );
      return reply.send({ askable: faces });
    },
  });

  app.post<{
    Body: {
      face_id: string;
      as: "work" | "mandate";
      title?: string;
      ask: string;
      why: string;
      satisfied_by: string;
      claim_ids?: string[];
      bears_on_text?: string;
      budget_owls: number;
    };
  }>("/asks", {
    schema: {
      tags: ["requests"],
      summary: "Ask for work at a label you do not read, and pay for it (people who may fund, from a signed-in session)",
      description: ASK_TOLD,
      body: {
        type: "object",
        required: ["face_id", "as", "ask", "why", "satisfied_by", "budget_owls"],
        properties: {
          face_id: UUID,
          as: { type: "string", enum: ["work", "mandate"] },
          title: { type: "string", maxLength: 200 },
          ask: { type: "string", minLength: 1, maxLength: 8000 },
          why: { type: "string", minLength: 1, maxLength: 8000 },
          satisfied_by: { type: "string", minLength: 1, maxLength: 8000 },
          claim_ids: { type: "array", items: UUID, maxItems: 50 },
          bears_on_text: { type: "string", maxLength: 2000 },
          budget_owls: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
    preHandler: funds,
    handler: async (request, reply) => {
      const body = request.body;
      // The label the ask is recorded at is the one its address is shown at, read as the person.
      const [face] = await rawQuery<{ shown_at: string }>(
        `SELECT sensitivity_label AS shown_at FROM label_faces WHERE id = $1 AND withdrawn_at IS NULL AND NOT (for_label = ANY($2::text[]))`,
        [body.face_id, [...currentClearance()]]
      );
      if (!face) {
        return reply.code(404).send({ error: "Nothing that can be asked from a label you read has that id. GET /asks/askable lists what can.", code: "NO_SUCH_FACE" });
      }
      const userId = request.auth!.userId!;
      const res = await runAtLabel(face.shown_at, "a person's ask for work at a label above", () =>
        askAbove({
          faceId: body.face_id,
          as: body.as,
          title: body.title ?? null,
          ask: body.ask,
          why: body.why,
          satisfiedBy: body.satisfied_by,
          claimIds: body.claim_ids ?? [],
          bearsOnText: body.bears_on_text ?? ((body.claim_ids ?? []).length === 0 ? "What the request describes." : null),
          budgetMicroUsd: owlsToMicroUsd(body.budget_owls),
          payer: { kind: "user", userId },
          filer: { kind: "contributor", contributorId: userId },
        })
      );
      if (!res.ok) {
        return reply.code(res.code === "NO_SUCH_FACE" ? 404 : res.code === "PAYER" ? 402 : res.code === "NOT_PLACED" ? 409 : 422).send({ error: res.message, code: res.code });
      }
      return reply.code(201).send({
        request_id: res.request_id,
        asked_of: res.face.name,
        as: res.as,
        budget_owls: body.budget_owls,
        recorded_at: face.shown_at,
      });
    },
  });
}
