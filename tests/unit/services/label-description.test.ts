/**
 * The description `public` is shown with (#1093). The row's stored words,
 * "Readable by anyone.", are the public graph's; on a members-only
 * deployment `public` is the members' common label and is described so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const members = vi.hoisted(() => ({ only: false }));
vi.mock("../../../src/permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/permissions.js")>()),
  membersOnly: () => members.only,
}));

const { MEMBERS_PUBLIC_DESCRIPTION, shownLabelDescription } = await import(
  "../../../src/services/label-service.js"
);

describe("shownLabelDescription", () => {
  beforeEach(() => {
    members.only = false;
  });

  it("keeps the stored words on the public graph", () => {
    expect(shownLabelDescription("public", "Readable by anyone.")).toBe("Readable by anyone.");
  });

  it("describes public as the members' label on a members-only deployment", () => {
    members.only = true;
    const shown = shownLabelDescription("public", "Readable by anyone.");
    expect(shown).toBe(MEMBERS_PUBLIC_DESCRIPTION);
    expect(shown).not.toMatch(/anyone/i);
    expect(shown).toMatch(/every member of this deployment/i);
    // It does not claim that nothing leaves: providers are cleared for public by default.
    expect(shown).toMatch(/model providers/);
  });

  it("leaves every other label's description as the administrator wrote it", () => {
    members.only = true;
    expect(shownLabelDescription("internal", "Staff only.")).toBe("Staff only.");
  });
});
