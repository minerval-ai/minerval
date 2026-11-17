import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// The home page of a members-only deployment (#1092): its map opens on a node
// chosen from its own graph by a stated rule, and the page names nothing of
// public Minerval's.
import { chooseFlagship } from "../../../web/lib/deployment-front";
import type { SearchResultItem } from "../../../web/lib/types";

const node = (id: string, importance: number | undefined, verdict: Partial<SearchResultItem> = {}) =>
  ({
    id, text: id, kind: "claim", claim_type: "empirical", state: "active", importance,
    assessment_status: null, assessment_confidence: null, prize_micro_usd: null, checked: null,
    ...verdict,
  }) as SearchResultItem;

describe("the flagship of a private deployment", () => {
  it("is the most important node with a verdict, the more recently updated on a tie", () => {
    const items = [
      node("recent", 0.5, { assessment_status: "supported" }),
      node("unassessed", 0.99),
      node("weighty", 0.8, { assessment_status: "doubtful" }),
      node("also-weighty", 0.8, { assessment_status: "supported" }),
    ];
    expect(chooseFlagship(items)?.id).toBe("weighty");
  });

  it("counts a question's standing and a quantity's estimate as verdicts", () => {
    expect(chooseFlagship([node("q", 0.3, { kind: "question", standing: "leaning" } as never)])?.id).toBe("q");
    expect(chooseFlagship([node("q", 0.3, { kind: "question", assessment_status: "supported" })])).toBeNull();
    expect(chooseFlagship([node("x", 0.3, { kind: "quantity", estimate: {} } as never)])?.id).toBe("x");
  });

  it("is none until something has been assessed", () => {
    expect(chooseFlagship([])).toBeNull();
    expect(chooseFlagship([node("a", 0.9), node("b", undefined)])).toBeNull();
  });

  it("treats a missing importance as the least", () => {
    const items = [node("none", undefined, { assessment_status: "supported" }), node("some", 0.1, { assessment_status: "supported" })];
    expect(chooseFlagship(items)?.id).toBe("some");
  });
});

describe("the home page's private hero", () => {
  const page = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/app/page.tsx"),
    "utf8",
  );
  const hero = page.slice(page.indexOf("function DeploymentHero"));

  it("names no curated territory, no public claim and no open or public constitution", () => {
    expect(hero.length).toBeGreaterThan(0);
    expect(hero).not.toMatch(/TERRITORIES|territoryHref|FLAGSHIP_ID|LIVE_FLAGSHIP_ID/);
    expect(hero).not.toMatch(/\bopen repository\b|public constitution/i);
    // Its search box passes its own placeholder, so none of the rotating
    // public suggestions is shown.
    expect(hero).toMatch(/<SearchInput placeholder=/);
  });
});
