import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every edge write checks its relation in the service (#658), so a caller
 * whose handler does not (the Curator's did not) cannot store an off-enum
 * relation that nothing reads.
 */

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => [{ id: "edge-1" }]),
}));

import { rawQuery } from "../../../src/db/client.js";
import {
  insertRelationshipEdge,
  UnknownRelationError,
} from "../../../src/services/relationship-service.js";

const edge = (relationType: string) => ({
  parentId: "p",
  childId: "c",
  relationType,
  reasoning: "r",
  createdBy: "curator",
});

describe("insertRelationshipEdge's relation check", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses an off-enum relation before writing anything", async () => {
    await expect(insertRelationshipEdge(edge("causes"))).rejects.toBeInstanceOf(UnknownRelationError);
    await expect(insertRelationshipEdge(edge("causes"))).rejects.toThrow(/Use one of: requires, supports/);
    expect(rawQuery).not.toHaveBeenCalled();
  });

  it("takes the decomposition relations in any case, and the kinds' own", async () => {
    await expect(insertRelationshipEdge(edge("Requires"))).resolves.toEqual({ id: "edge-1", created: true });
    await expect(insertRelationshipEdge(edge("answers"))).resolves.toMatchObject({ created: true });
    await expect(insertRelationshipEdge(edge("part_of"))).resolves.toMatchObject({ created: true });
    expect(vi.mocked(rawQuery).mock.calls[0]![1]![2]).toBe("requires");
  });
});
