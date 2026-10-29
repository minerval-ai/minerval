import { describe, it, expect } from "vitest";
import {
  quantityEstimateSchema,
  quantityUnitSchema,
  valueShownSchema,
} from "../../../src/schemas/kinds.js";
import { RELATION_TYPES, INSTANCE_STANCES } from "../../../src/schemas/common.js";

// The shapes the kinds tables hold (constitution §3, §7, §10). Each estimate
// form requires its own figures, and a value range puts each figure where
// the frontend reads it: a figure or lower bound in `low`, an upper bound in
// `high`.

const ok = (r: { success: boolean }) => r.success;

describe("quantityEstimateSchema", () => {
  it("accepts each form with its figures", () => {
    for (const e of [
      { form: "distribution", quantiles: [{ p: 0.05, v: 1 }, { p: 0.5, v: 3 }, { p: 0.95, v: 9 }] },
      { form: "interval", low: 17e6, high: 1e8, level: 0.9, central: 4e7 },
      { form: "bound", bound: { side: "above", value: 2e7 } },
      { form: "magnitude", magnitude: 7 },
      { form: "point", central: 0.31 },
      { form: "none", reason: "The quantity is not defined for pre-industrial economies" },
      { form: "point", central: 2.5, outside: { share: 0.2, meaning: "the event does not happen" } },
    ]) {
      expect(ok(quantityEstimateSchema.safeParse(e)), JSON.stringify(e)).toBe(true);
    }
  });

  it("refuses a form without its figures, or figures out of order", () => {
    for (const e of [
      { form: "distribution", quantiles: [{ p: 0.5, v: 1 }] },
      { form: "distribution", quantiles: [{ p: 0.1, v: 5 }, { p: 0.9, v: 1 }] },
      { form: "distribution", quantiles: [{ p: 0, v: 1 }, { p: 0.5, v: 2 }] },
      { form: "interval", low: 3 },
      { form: "interval", low: 3, high: 1 },
      { form: "interval", low: 1, high: 3, central: 5 },
      { form: "bound" },
      { form: "magnitude" },
      { form: "point" },
      { form: "none" },
      { form: "point", central: 1, outside: { share: 1, meaning: "all of it" } },
      { form: "point", central: 1, stray: true },
      { form: "point", central: Number.NaN },
    ]) {
      expect(ok(quantityEstimateSchema.safeParse(e)), JSON.stringify(e)).toBe(false);
    }
  });
});

describe("quantityUnitSchema", () => {
  it("asks a currency for its currency and a rate for what it is per", () => {
    expect(ok(quantityUnitSchema.safeParse({ kind: "currency", currency: "USD" }))).toBe(true);
    expect(ok(quantityUnitSchema.safeParse({ kind: "currency" }))).toBe(false);
    expect(ok(quantityUnitSchema.safeParse({ kind: "rate", noun: "impacts", per: "per year" }))).toBe(true);
    expect(ok(quantityUnitSchema.safeParse({ kind: "rate", noun: "impacts" }))).toBe(false);
    expect(ok(quantityUnitSchema.safeParse({ kind: "proportion", min: 1, max: 0 }))).toBe(false);
  });
});

describe("valueShownSchema", () => {
  it("places each side's figure where it is read", () => {
    for (const range of [
      { side: "at", low: 3 },
      { side: "about", low: 3 },
      { side: "between", low: 1, high: 3 },
      { side: "above", low: 3, inclusive: true },
      { side: "below", high: 3 },
    ]) {
      expect(ok(valueShownSchema.safeParse({ text: "t", range })), JSON.stringify(range)).toBe(true);
    }
    for (const range of [
      { side: "at", high: 3 },
      { side: "between", low: 3, high: 1 },
      { side: "above", high: 3 },
      { side: "below", low: 3 },
    ]) {
      expect(ok(valueShownSchema.safeParse({ text: "t", range })), JSON.stringify(range)).toBe(false);
    }
  });

  it("allows words alone, for an argument with no place on the axis", () => {
    expect(ok(valueShownSchema.safeParse({ text: "The quantity is ill defined" }))).toBe(true);
    expect(ok(valueShownSchema.safeParse({ text: "  " }))).toBe(false);
  });
});

describe("the agents' vocabularies", () => {
  it("do not offer the kinds' relations or stances before their tools exist", () => {
    expect(RELATION_TYPES).not.toContain("answers");
    expect(RELATION_TYPES).not.toContain("part_of");
    expect(INSTANCE_STANCES).not.toContain("states");
  });
});
