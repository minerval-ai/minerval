/**
 * The settings as the pages say them (web/lib/settings.ts): groups in
 * order, a value as a person reads it and as a form gives it, and the steps
 * of a deployment's first day.
 */
import { describe, expect, it } from "vitest";
import type { SettingView } from "../../../web/lib/admin-api";
import {
  LOAD_BEARING_MODELS,
  SETTING_GROUPS,
  fieldText,
  firstDaySteps,
  groupSettings,
  parseField,
  settingName,
  sourceWords,
  valueWords,
} from "../../../web/lib/settings";
import { SETTINGS, settingGroup } from "../../../src/settings-registry";

function view(over: Partial<SettingView> & { key: string }): SettingView {
  const group = over.key.includes(".") ? over.key.slice(0, over.key.lastIndexOf(".")) : "";
  return {
    env: over.key.toUpperCase(),
    group,
    kind: "text",
    about: "About.",
    where: "app",
    applies: "live",
    tuning: false,
    secret: false,
    source: "default",
    changeable: true,
    fixed_by: null,
    value: null,
    default: null,
    is_set: null,
    last_four: null,
    set_by: null,
    set_at: null,
    waiting: null,
    unopened: false,
    ...over,
  };
}

describe("the groups", () => {
  it("name every group the registry has, once", () => {
    const groups = new Set(SETTINGS.filter((s) => !s.retired).map((s) => settingGroup(s.key)));
    const named = SETTING_GROUPS.map((g) => g.group);
    expect(new Set(named).size).toBe(named.length);
    expect([...groups].filter((g) => !named.includes(g))).toEqual([]);
  });

  it("put the settings in the groups' order, an unknown group last", () => {
    const grouped = groupSettings([view({ key: "zzz.new" }), view({ key: "pricing.owls" }), view({ key: "models.steward" })]);
    expect(grouped.map((g) => g.group)).toEqual(["models", "pricing", "zzz"]);
    expect(settingName(view({ key: "models.steward" }))).toBe("steward");
    expect(settingName(view({ key: "provider_labels" }))).toBe("provider_labels");
  });

  it("list as load-bearing only roles the registry has", () => {
    for (const key of LOAD_BEARING_MODELS) expect(SETTINGS.find((s) => s.key === key), key).toBeDefined();
  });
});

describe("a value as a person reads it", () => {
  it("says each kind in words, and never a key", () => {
    expect(valueWords(view({ key: "a.b" }), null)).toBe("Not set");
    expect(valueWords(view({ key: "a.b" }), "")).toBe("Empty");
    expect(valueWords(view({ key: "a.b", kind: "boolean" }), true)).toBe("Yes");
    expect(valueWords(view({ key: "a.b", kind: "number" }), 0.25)).toBe("0.25");
    expect(valueWords(view({ key: "a.b", kind: "list" }), [])).toBe("None");
    expect(valueWords(view({ key: "a.b", kind: "list" }), ["x", "y"])).toBe("x, y");
    expect(valueWords(view({ key: "a.b", kind: "groups" }), [{ name: "local" }])).toBe("1 entry");
    expect(valueWords(view({ key: "a.b", secret: true, is_set: false }), null)).toBe("Not set");
    expect(valueWords(view({ key: "a.b", secret: true, is_set: true, last_four: "9xYz" }), null)).toBe("Set · ends 9xYz");
  });

  it("says where it comes from", () => {
    expect(sourceWords(view({ key: "a.b", source: "app" })).word).toBe("Set here");
    expect(sourceWords(view({ key: "a.b", source: "environment" })).word).toBe("Fixed · environment");
    expect(sourceWords(view({ key: "a.b", where: "machine", source: "default" })).word).toBe("On the machine");
  });
});

describe("a value as a form gives it", () => {
  it("turns the field's text into the setting's kind", () => {
    expect(parseField("number", " 0.5 ")).toEqual({ ok: true, value: 0.5 });
    expect(parseField("number", "lots")).toMatchObject({ ok: false });
    expect(parseField("number", "")).toMatchObject({ ok: false });
    expect(parseField("boolean", "false")).toEqual({ ok: true, value: false });
    expect(parseField("list", "a\n b ,c\n\n")).toEqual({ ok: true, value: ["a", "b", "c"] });
    expect(parseField("list", "")).toEqual({ ok: true, value: [] });
    expect(parseField("groups", '[{"model":"m"}]')).toEqual({ ok: true, value: [{ model: "m" }] });
    expect(parseField("groups", '{"a":1}')).toMatchObject({ ok: false });
    expect(parseField("groups", "nope")).toMatchObject({ ok: false, error: "That is not valid JSON." });
    expect(parseField("text", "  claude-opus-5-5 ")).toEqual({ ok: true, value: "claude-opus-5-5" });
  });

  it("shows a value in the field the way it is typed back", () => {
    expect(fieldText(view({ key: "a.b", kind: "list" }), ["x", "y"])).toBe("x\ny");
    expect(parseField("groups", fieldText(view({ key: "a.b", kind: "groups" }), [{ name: "local" }]))).toEqual({
      ok: true,
      value: [{ name: "local" }],
    });
  });
});

describe("the first day", () => {
  const models = (source: SettingView["source"]) =>
    LOAD_BEARING_MODELS.map((key) => view({ key, source, value: "claude-sonnet-5-5" }));
  const rest = [view({ key: "features.off", kind: "list", value: [] }), view({ key: "pricing.owls", value: "sold" })];

  it("asks for the name, the models, the features and the owls, in order", () => {
    const steps = firstDaySteps({ settings: [...models("default"), ...rest], ownParty: { name: "This organization" }, mathematicsOn: true })!;
    expect(steps.map((s) => s.key)).toEqual(["organisation", "models", "features", "owls"]);
    expect(steps.map((s) => s.done)).toEqual([false, false, false, false]);
    expect(steps[1]!.fact).toMatch(/7 of 7 load-bearing roles/);
    expect(steps[1]!.settings).toEqual([...LOAD_BEARING_MODELS]);
  });

  it("does not ask for the solver's model where mathematics is off", () => {
    const steps = firstDaySteps({ settings: [...models("default"), ...rest], ownParty: { name: "Acme" }, mathematicsOn: false })!;
    expect(steps[0]!.done).toBe(true);
    expect(steps[1]!.settings).not.toContain("models.solver");
    expect(steps[1]!.fact).toMatch(/6 of 6/);
  });

  it("is over once the organisation is named and every load-bearing role has a chosen model", () => {
    expect(firstDaySteps({ settings: [...models("app"), ...rest], ownParty: { name: "Acme" }, mathematicsOn: true })).toBeNull();
    // Whoever runs the machine may have chosen them instead.
    expect(firstDaySteps({ settings: [...models("environment"), ...rest], ownParty: { name: "Acme" }, mathematicsOn: true })).toBeNull();
    // Still shown while the name is the placeholder.
    expect(firstDaySteps({ settings: [...models("app"), ...rest], ownParty: { name: "This organization" }, mathematicsOn: true })).not.toBeNull();
  });
});
