/**
 * The change stream's kinds beyond verdicts: read only when asked for,
 * scoped like verdicts, merged in stream order, and resumable by cursor.
 */
import { describe, it, expect } from "vitest";
import { listGraphChanges } from "../../src/services/graph-change-service.js";
import { postMessage } from "../../src/services/inbox-service.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

describe("change stream events", () => {
  it("returns messages and commissions under a node only when asked, and resumes after them", async () => {
    const funder = await seedUser("stream funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 20 * OWL });
    const node = await seedClaim("stream node");
    const since = new Date(Date.now() - 1000).toISOString();
    await postMessage({ nodeId: node, trigger: "steward_note", body: "first" });
    await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: node, budgetMicroUsd: 2 * OWL, brief: "look", commissionedBy: "program_officer" });

    const verdictsOnly = await listGraphChanges({ since, scope: { under: [node] } });
    expect(verdictsOnly.changes).toEqual([]);

    const page = await listGraphChanges({ since, scope: { under: [node] }, kinds: ["message_arrived", "work_commissioned"] });
    expect(page.changes.map((c) => c.kind)).toEqual(["message_arrived", "work_commissioned", "message_arrived"]);
    expect(page.changes[1]!.summary).toContain("2 owls, by program_officer");

    const first = await listGraphChanges({ since, scope: { under: [node] }, kinds: ["message_arrived", "work_commissioned"], limit: 1 });
    expect(first.has_more).toBe(true);
    const rest = await listGraphChanges({ after: first.next_cursor, scope: { under: [node] }, kinds: ["message_arrived", "work_commissioned"] });
    expect(rest.changes.map((c) => c.kind)).toEqual(["work_commissioned", "message_arrived"]);
    const after = await listGraphChanges({ after: rest.next_cursor, scope: { under: [node] }, kinds: ["message_arrived", "work_commissioned"] });
    expect(after.changes).toEqual([]);
  });
});
