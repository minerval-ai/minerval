/**
 * Setup parts (#552 groundwork): stored once under their hash, numbered in
 * order of first sighting per (kind, name), and served with their text only
 * when public.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getSetupPart,
  hashText,
  listSetupParts,
  resetSetupRegistry,
  storeSetupParts,
  type SetupPart,
} from "../../src/services/setup-service.js";

function part(name: string, content: string, isPublic = true): SetupPart {
  return { kind: "role", name, hash: hashText(content), content, public: isPublic, sourcePath: "src/x.ts" };
}

describe("setup parts", () => {
  it("numbers new texts in order and stores a repeated text once", async () => {
    resetSetupRegistry();
    const name = `test-role-${randomUUID()}`;
    await storeSetupParts([part(name, "first")]);
    await storeSetupParts([part(name, "second")]);
    resetSetupRegistry(); // forget what this process stored
    await storeSetupParts([part(name, "first")]);
    const versions = await listSetupParts({ kind: "role", name });
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]!.hash).toBe(hashText("first"));
    const byHash = await listSetupParts({ hash: hashText("second") });
    expect(byHash.map((v) => [v.name, v.version])).toEqual([[name, 2]]);
  });

  it("gives concurrent new texts distinct numbers", async () => {
    resetSetupRegistry();
    const name = `test-race-${randomUUID()}`;
    await Promise.all(["a", "b", "c", "d"].map((t) => storeSetupParts([part(name, t)])));
    const versions = await listSetupParts({ kind: "role", name });
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3, 4]);
  });

  it("serves the text of public parts only", async () => {
    resetSetupRegistry();
    const name = `test-private-${randomUUID()}`;
    await storeSetupParts([part(name, "public text")]);
    await storeSetupParts([part(name, "run-specific text", false)]);
    const v1 = await getSetupPart("role", name, 1);
    const v2 = await getSetupPart("role", name, 2);
    expect(v1!.content).toBe("public text");
    expect(v2!.content).toBeNull();
    expect(v2!.previous_version).toBe(1);
    expect(await getSetupPart("role", name, 3)).toBeNull();
  });
});
