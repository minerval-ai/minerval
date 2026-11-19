/**
 * The Assistant in a conversation started as an organization
 * (docs/organizations.md, "Acting as the organization"), against real
 * Postgres and the real app: its work is charged to the organization's owls,
 * not the person's; it is told whom it works for and what that leaves out;
 * the conversation is found only while the person acts as the organization;
 * its tools are only those the person may use as it, and a permission
 * withdrawn during a turn is refused at the call.
 *
 * The Assistant's model loop is replaced by a script each test sets, as in
 * assistant.test.ts; its tools are the real ones.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

type TurnInput = {
  context: string;
  account: {
    definitions: Array<{ name: string }>;
    actingFor?: { organizationName: string; withheld: Array<{ tool: string; permission: string | null }> };
    call: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  };
  charge: (replyMicroUsd: number) => Promise<{ balanceMicroUsd: number; stop: boolean }>;
};
type TurnResult = { reply: string; stopped: "user" | "balance" | null; toolUses: unknown[]; runId: string | null };

const SERVICE_KEY = "assistant-organization-web-tier-key";
vi.hoisted(() => {
  delete process.env.READS;
  process.env.API_KEYS = "assistant-organization-web-tier-key";
});

const agent = vi.hoisted(() => ({
  script: null as null | ((input: never) => Promise<unknown>),
  inputs: [] as unknown[],
}));

vi.mock("../../src/llm/agents/assistant.js", () => ({
  runAssistantTurn: vi.fn(async (input: never) => {
    agent.inputs.push(input);
    if (agent.script) return agent.script(input);
    return { reply: "A reply.", stopped: null, toolUses: [], runId: null };
  }),
}));

vi.mock("../../src/llm/client.js", async (original) => ({
  ...(await original<typeof import("../../src/llm/client.js")>()),
  complete: vi.fn(async () => ({ content: "A name", model: "test", usage: {}, stopReason: "end_turn" })),
}));

import { rawQuery } from "../../src/db/client.js";
import {
  getAssistantConversation,
  listAssistantConversations,
  settleAssistantTurns,
  startAssistantConversation,
} from "../../src/services/assistant-service.js";
import {
  acceptInvitation,
  createOrganization,
  grantPermission,
  makeInvitation,
} from "../../src/services/organization-service.js";
import { getEntitlement } from "../../src/services/billing-service.js";
import { creditOwls, owlBalance, seedUser, OWL } from "./helpers.js";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.LOG_LEVEL = "fatal";
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await settleAssistantTurns();
  await app?.close();
});

beforeEach(() => {
  agent.script = null;
  agent.inputs = [];
});

function script(fn: (input: TurnInput) => Promise<TurnResult>) {
  agent.script = fn as never;
}

/** An organization with an admin, a member holding `permissions`, and owls of its own. */
async function organization(permissions: Array<"spend" | "speak">, owls = 5) {
  const admin = await seedUser("admin");
  const member = await seedUser("member");
  await getEntitlement(member); // the person's own free grants, so their balance is known
  const org = await createOrganization({ name: "Acme Corp", by: admin });
  const { token } = await makeInvitation({ organizationId: org.id, role: "member", by: admin });
  await acceptInvitation({ token, by: member });
  for (const permission of permissions) {
    await grantPermission({ organizationId: org.id, permission, accountId: member, by: admin });
  }
  await creditOwls(org.id, owls * OWL);
  return {
    admin,
    org: org.id,
    member,
    as: { id: member, externalId: null, actingFor: { id: org.id, externalId: `org:${org.id}` } },
  };
}

describe("a conversation started as an organization", () => {
  it("is charged to the organization's owls, and its Assistant is told whom it works for", async () => {
    const { org, member, as } = await organization(["spend", "speak"]);
    const before = await owlBalance(member);
    script(async (input) => {
      await input.charge(300_000);
      return { reply: "Done.", stopped: null, toolUses: [], runId: null };
    });
    const started = await startAssistantConversation({ app, user: as, message: "What should Acme fund?" });
    expect(started.ok).toBe(true);
    await settleAssistantTurns();

    expect(await owlBalance(org)).toBe(5 * OWL - 300_000);
    expect(await owlBalance(member)).toBe(before);
    const input = agent.inputs[0] as TurnInput;
    expect(input.account.actingFor?.organizationName).toBe("Acme Corp");
    expect(input.context).toContain("balance $5.00");
  });

  it("is found only while the person acts as the organization", async () => {
    const { org, member, as } = await organization(["spend"]);
    const started = await startAssistantConversation({ app, user: as, message: "Hello" });
    if (!started.ok) throw new Error(started.message);
    await settleAssistantTurns();
    const id = started.conversation.id;

    expect(await getAssistantConversation(id, member, org)).not.toBeNull();
    expect(await getAssistantConversation(id, member)).toBeNull();
    expect((await listAssistantConversations(member)).map((c) => c.id)).not.toContain(id);
    expect((await listAssistantConversations(member, 50, 0, org)).map((c) => c.id)).toEqual([id]);
    const [row] = await rawQuery<{ user_id: string; acting_for: string }>(
      `SELECT user_id, acting_for FROM assistant_conversations WHERE id = $1`,
      [id]
    );
    expect(row).toEqual({ user_id: member, acting_for: org });
  });

  it("offers only the tools the person may use as it, and refuses one withdrawn during the turn", async () => {
    const { admin, org, as } = await organization(["spend", "speak"]);
    let offered: string[] = [];
    let afterWithdrawal: { text: string; isError: boolean } | null = null;
    script(async (input) => {
      offered = input.account.definitions.map((d) => d.name);
      await rawQuery(
        `UPDATE organization_grants SET withdrawn_at = now(), withdrawn_by = $2 WHERE organization_id = $1 AND permission = 'speak'`,
        [org, admin]
      );
      afterWithdrawal = await input.account.call("raise_issue", {
        kind: "improvement",
        severity: "annoyance",
        title: "A claim page shows the wrong status",
        body: "Something on the claim page is wrong.",
      });
      return { reply: "Tried.", stopped: null, toolUses: [], runId: null };
    });
    const started = await startAssistantConversation({ app, user: as, message: "Report it" });
    expect(started.ok).toBe(true);
    await settleAssistantTurns();

    expect(offered).toContain("raise_issue");
    expect(offered).toContain("fund_mandate");
    expect(offered).not.toContain("take_up_request");
    expect(afterWithdrawal).toMatchObject({ isError: true });
    expect(afterWithdrawal!.text).toMatch(/needs speak/);
  });

  it("is refused to a member without spend, from the route, before anything runs", async () => {
    const { org, member } = await organization(["speak"]);
    const [person] = await rawQuery<{ external_id: string }>(`SELECT external_id FROM contributors WHERE id = $1`, [member]);
    const res = await app.inject({
      method: "POST",
      url: "/assistant/conversations",
      headers: {
        "x-api-key": SERVICE_KEY,
        "x-acting-user": person!.external_id,
        "x-acting-organization": org,
      },
      payload: { message: "Hello" },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_NOT_HELD", permission: "spend" });
    expect(agent.inputs).toEqual([]);
  });
});
