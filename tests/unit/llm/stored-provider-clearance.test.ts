/**
 * The check before text leaves the process (src/llm/provider-clearance.ts)
 * where PROVIDER_LABELS is not set, so the administrators' stored choice
 * applies (services/provider-clearance-service.ts). The table itself, and a
 * change taking effect without a restart, are in
 * tests/db/provider-clearance-choice.test.ts. Here the table is answered
 * from the test, so what is checked is which clearance the gate reads, and
 * when it asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stored: {} as Record<string, string[]>,
  freshStoredClearance: vi.fn(),
  undefinedLabels: vi.fn(async () => [] as string[]),
}));

vi.mock("../../../src/services/provider-clearance-service.js", () => ({
  freshStoredClearance: mocks.freshStoredClearance,
}));
vi.mock("../../../src/services/label-service.js", () => ({ undefinedLabels: mocks.undefinedLabels }));

import {
  assertProviderCleared,
  freshenProviderClearance,
  providerClearedHere,
  resetProviderClearanceForTests,
} from "../../../src/llm/provider-clearance.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";
import {
  clearanceFixedBySettings,
  forgetStoredClearance,
  noteStoredClearance,
  ProviderNotClearedError,
} from "../../../src/provider-labels.js";

const STORED_MODE = { providerLabels: undefined };

beforeEach(() => {
  mocks.stored = {};
  mocks.freshStoredClearance.mockReset();
  mocks.freshStoredClearance.mockImplementation(async () => {
    noteStoredClearance(mocks.stored);
    return mocks.stored;
  });
  mocks.undefinedLabels.mockClear();
  forgetStoredClearance();
  resetProviderClearanceForTests();
});
afterEach(() => forgetStoredClearance());

const at = <T>(label: string, fn: () => Promise<T> | T) => runWithUsageContext({ label }, async () => fn());

describe("where PROVIDER_LABELS is not set", () => {
  it("is not fixed by the settings, and fixed once anything is set, an empty object included", () => {
    expect(clearanceFixedBySettings(STORED_MODE)).toBe(false);
    expect(clearanceFixedBySettings({ providerLabels: null })).toBe(false);
    expect(clearanceFixedBySettings({ providerLabels: {} })).toBe(true);
  });

  it("refuses a provider nobody cleared for a private label, naming the page where it is cleared", async () => {
    const refusal = await at("internal", () => assertProviderCleared("anthropic", STORED_MODE)).catch((e) => e);
    expect(refusal).toBeInstanceOf(ProviderNotClearedError);
    expect((refusal as Error).message).toBe(
      'anthropic is not cleared for the label "internal", so nothing was sent to it. Every model provider and ' +
        'outside service is cleared for "public" and for no other label until it is cleared on purpose: a holder ' +
        "of the permission to clear providers does that for each label on the labels page (/admin/labels)."
    );
    expect(mocks.freshStoredClearance).toHaveBeenCalledTimes(1);
  });

  it("lets through a provider the administrators cleared for the label, and only for that label", async () => {
    mocks.stored = { anthropic: ["internal"] };
    await expect(at("internal", () => assertProviderCleared("anthropic", STORED_MODE))).resolves.toBeUndefined();
    await expect(at("restricted", () => assertProviderCleared("anthropic", STORED_MODE))).rejects.toBeInstanceOf(
      ProviderNotClearedError
    );
    await expect(at("internal", () => assertProviderCleared("embeddings", STORED_MODE))).rejects.toBeInstanceOf(
      ProviderNotClearedError
    );
  });

  it("follows a change to the stored choice: what is taken back is refused on the next call", async () => {
    mocks.stored = { anthropic: ["internal"] };
    await at("internal", () => assertProviderCleared("anthropic", STORED_MODE));
    mocks.stored = {};
    await expect(at("internal", () => assertProviderCleared("anthropic", STORED_MODE))).rejects.toBeInstanceOf(
      ProviderNotClearedError
    );
  });

  it("clears every provider for public without asking the table", async () => {
    await at("public", () => assertProviderCleared("anthropic", STORED_MODE));
    await at("public", () => freshenProviderClearance(STORED_MODE));
    expect(await at("public", () => providerClearedHere("pangram", STORED_MODE))).toBe(true);
    expect(mocks.freshStoredClearance).not.toHaveBeenCalled();
    expect(mocks.undefinedLabels).not.toHaveBeenCalled();
  });

  it("gives the synchronous readers the copy brought up to date first", async () => {
    mocks.stored = { pangram: ["internal"] };
    // Before anything was read, a process clears nothing beyond public.
    expect(await at("internal", () => providerClearedHere("pangram", STORED_MODE))).toBe(false);
    await at("internal", () => freshenProviderClearance(STORED_MODE));
    expect(await at("internal", () => providerClearedHere("pangram", STORED_MODE))).toBe(true);
    expect(await at("internal", () => providerClearedHere("elicit", STORED_MODE))).toBe(false);
  });
});

describe("where PROVIDER_LABELS is set", () => {
  it("reads the setting and never the stored choice", async () => {
    mocks.stored = { anthropic: ["internal"] };
    noteStoredClearance(mocks.stored);
    const fixed = { providerLabels: { openrouter: ["public", "internal"] } };
    const refusal = await at("internal", () => assertProviderCleared("anthropic", fixed)).catch((e) => e);
    expect(refusal).toBeInstanceOf(ProviderNotClearedError);
    expect((refusal as Error).message).toContain("PROVIDER_LABELS lists the labels");
    await expect(at("internal", () => assertProviderCleared("openrouter", fixed))).resolves.toBeUndefined();
    await at("internal", () => freshenProviderClearance(fixed));
    expect(await at("internal", () => providerClearedHere("anthropic", fixed))).toBe(false);
    expect(mocks.freshStoredClearance).not.toHaveBeenCalled();
  });
});
