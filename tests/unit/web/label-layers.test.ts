import { describe, expect, it } from "vitest";
import {
  ONE_LAYER,
  anAssessmentAt,
  assessmentName,
  byLayerThenName,
  clearedByChoice,
  isMemberLabel,
  isOpenLabel,
  isOwnLabel,
  isWorkableLabel,
  layerOf,
  layerWord,
  layersOf,
} from "../../../web/lib/label-layers";

// The bottom layers as the web app names them (#1203). The API says which
// label is which; nothing here compares a label with a word.
const SPLIT = { public_graph: "public", published: "published", base: "members", split: true };
// A deployment that had already used both names, and was told to choose others.
const RENAMED = { public_graph: "public", published: "sent-out", base: "staff", split: true };

describe("the bottom layers of a deployment's labels", () => {
  it("are one label where the deployment has not been split, and an API that says nothing is read that way", () => {
    expect(layersOf(null)).toBe(ONE_LAYER);
    expect(layersOf({})).toBe(ONE_LAYER);
    expect(layerOf("public")).toBe("base");
    expect(isOpenLabel("public")).toBe(true);
    expect(isMemberLabel("public")).toBe(true);
    expect(isWorkableLabel("public")).toBe(true);
    expect(isOwnLabel("finance")).toBe(true);
    expect(layerWord("public")).toBe("public");
    expect(assessmentName("public")).toBe("Public assessment");
    expect(anAssessmentAt("public")).toBe("the public assessment");
    expect(anAssessmentAt("finance")).toBe("the assessment at finance");
  });

  it("are told apart by what the API says each is called, whatever that is", () => {
    for (const layers of [SPLIT, RENAMED]) {
      expect(layerOf(layers.public_graph, layers)).toBe("public_graph");
      expect(layerOf(layers.published, layers)).toBe("published");
      expect(layerOf(layers.base, layers)).toBe("base");
      expect(layerOf("finance", layers)).toBeNull();
      expect([layers.public_graph, layers.published, layers.base].map((l) => layerWord(l, layers))).toEqual(["Public graph", "Published", "Members"]);
      expect(layerWord("finance", layers)).toBe("finance");
    }
  });

  it("say who reads each, where work is done, and which a provider is cleared for by choice", () => {
    expect(["public", "published", "members", "finance"].map((l) => isOpenLabel(l, SPLIT))).toEqual([true, true, false, false]);
    expect(["public", "published", "members", "finance"].map((l) => isMemberLabel(l, SPLIT))).toEqual([true, true, true, false]);
    expect(["public", "published", "members", "finance"].map((l) => isWorkableLabel(l, SPLIT))).toEqual([false, false, true, true]);
    expect(["public", "published", "members", "finance"].map((l) => clearedByChoice(l, SPLIT))).toEqual([false, true, true, true]);
    expect(["public", "published", "members", "finance"].map((l) => isOwnLabel(l, SPLIT))).toEqual([false, false, false, true]);
  });

  it("order a page's labels from the bottom, then by name, and name each assessment by its layer", () => {
    expect(["legal", "members", "public", "finance", "published"].sort(byLayerThenName(SPLIT))).toEqual(["public", "published", "members", "finance", "legal"]);
    expect(assessmentName("public", SPLIT)).toBe("The public graph's assessment");
    expect(assessmentName("members", SPLIT)).toBe("Members' assessment");
    expect(assessmentName("staff", RENAMED)).toBe("Members' assessment");
    expect(assessmentName("finance", SPLIT)).toBe("Assessment at finance");
    expect(anAssessmentAt("public", SPLIT)).toBe("the public graph's assessment");
    expect(anAssessmentAt("members", SPLIT)).toBe("the members' assessment");
  });
});
