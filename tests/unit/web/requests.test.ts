import { describe, it, expect } from "vitest";

// The requests pages' logic (web/lib/requests.ts): how a long ask is read
// as a headline and its parts, what the index's URL says and how a filter
// changes it, and how a request's funding is put in words.
import {
  askHeadline,
  firstSentenceEnd,
  headlineShortened,
  fundingWords,
  importanceOutOfTen,
  parseRequestsView,
  requestsApiQuery,
  requestsHref,
  requestsOrderInForce,
  splitAsk,
} from "../../../web/lib/requests";
import type { RequestItem } from "../../../web/lib/types";

describe("reading an ask", () => {
  it("heads it with its first sentence, past abbreviations, initials, decimals and brackets", () => {
    const ask =
      "Run the protocol of Tice et al. (arXiv 2412.01784, Fig. 3) on the J. Smith models. Report the false-positive rate.";
    expect(splitAsk(ask)).toEqual({
      headline: "Run the protocol of Tice et al. (arXiv 2412.01784, Fig. 3) on the J. Smith models.",
      rest: "Report the false-positive rate.",
      parts: [],
      marker: null,
      tail: null,
    });
    expect(firstSentenceEnd("One sentence only")).toBe(-1);
  });

  it("lists numbered parts, keeping the opening and the closing sentence apart", () => {
    const ask =
      "Complete the tracing of figures. Still needed: (1) the body of the METR assessment; (2) Whitfill and Wu's paper, for how the estimates (about 2.6 and about zero) were obtained; and (3) any later revision. Note for each what was redacted.";
    expect(splitAsk(ask)).toEqual({
      headline: "Complete the tracing of figures.",
      rest: "Still needed:",
      parts: [
        "the body of the METR assessment",
        "Whitfill and Wu's paper, for how the estimates (about 2.6 and about zero) were obtained",
        "any later revision.",
      ],
      marker: "1",
      tail: "Note for each what was redacted.",
    });
  });

  it("lists lettered parts, and does not take a year or a lone marker for a list", () => {
    const lettered = splitAsk("Read in full (a) the paper and (b) the system cards, and report rates.");
    expect(lettered.marker).toBe("a");
    expect(lettered.headline).toBe("Read in full");
    expect(lettered.parts).toEqual(["the paper", "the system cards, and report rates."]);
    const notAList = splitAsk("Read the 2026 report (2025) and its appendix (1) only.");
    expect(notAList.parts).toEqual([]);
    expect(notAList.headline).toBe("Read the 2026 report (2025) and its appendix (1) only.");
  });

  it("reads an ask that opens with its list as prose", () => {
    const parts = splitAsk("(1) Find the data. (2) Fit the model.");
    expect(parts.parts).toEqual([]);
    expect(parts.headline).toBe("(1) Find the data.");
  });

  it("joins back to the ask, word for word", () => {
    const ask = "Survey the cards. Report: (1) how often models recognize tests; (2) whether rates rose. Say where you looked.";
    const p = splitAsk(ask);
    const words = (s: string) => s.replace(/[^A-Za-z0-9]+/g, " ").trim();
    expect(words([p.headline, p.rest, ...p.parts, p.tail].filter(Boolean).join(" "))).toBe(
      words(ask.replace(/\(\d\)/g, "")).replace(/\s+/g, " ")
    );
  });
});

describe("a headline from a long first sentence", () => {
  it("drops a colon that only introduces the list", () => {
    const ask =
      "For the question of when dictionary methods outperform alternatives at discovering unspecified model properties: (1) full-text reads of four studies; (2) the win rates.";
    expect(askHeadline(ask)).toBe(
      "For the question of when dictionary methods outperform alternatives at discovering unspecified model properties"
    );
    expect(headlineShortened(ask)).toBe(false);
  });

  it("drops bracketed asides, then everything past the first colon or semicolon", () => {
    expect(
      askHeadline(
        "Run the noise-injection protocol of Tice et al. (direct Gaussian weight noise, sigma sweep 0 to 0.01, five seeds, maximum improvement ratio) and the cross-context consistency check of Lin et al. on the public UK AISI auditing-game models: the prompt-distilled sandbagger Tarun, the imitation-trained Beren, Cedar and Oak, and the unmodified Llama-3.3-70B. Report per-model ratios."
      )
    ).toBe(
      "Run the noise-injection protocol of Tice et al. and the cross-context consistency check of Lin et al. on the public UK AISI auditing-game models"
    );
    const sars =
      "A targeted search for any report, from mid-2025 onward, that a natural progenitor virus or a confirmed infected intermediate host of SARS-CoV-2 has been identified; and recording of the key source instances (WHO SAGO 2025 report, Crits-Christoph et al. 2024, the BANAL and RaTG13 genome papers) on this claim.";
    expect(askHeadline(sars)).toBe(
      "A targeted search for any report, from mid-2025 onward, that a natural progenitor virus or a confirmed infected intermediate host of SARS-CoV-2 has been identified"
    );
    // The page then gives the sentence whole.
    expect(headlineShortened(sars)).toBe(true);
  });

  it("leaves a sentence short enough alone", () => {
    const ask = "Independently replicate the CC-Delta vs CAA comparison from arXiv 2602.12418 on at least two of its four models. Report seeds.";
    expect(askHeadline(ask)).toBe("Independently replicate the CC-Delta vs CAA comparison from arXiv 2602.12418 on at least two of its four models.");
    expect(headlineShortened(ask)).toBe(false);
  });
});

describe("the index's view", () => {
  it("reads the filters from the URL and drops what it cannot use", () => {
    expect(parseRequestsView({ q: " sandbagging ", tag: "ai-safety", stands: "met", asked: "named", waiting: "1", order: "recent", page: "3" })).toEqual({
      q: "sandbagging",
      tag: "ai-safety",
      stands: "met",
      asked: "named",
      waiting: true,
      order: "recent",
      page: 3,
    });
    expect(parseRequestsView({ stands: "bogus", asked: "everyone", order: "loudest", page: "-2" })).toEqual({
      q: null,
      tag: null,
      stands: "live",
      asked: null,
      waiting: false,
      order: null,
      page: 1,
    });
  });

  it("puts the most important first, or the closest under a search", () => {
    expect(requestsOrderInForce(parseRequestsView({}))).toBe("importance");
    expect(requestsOrderInForce(parseRequestsView({ q: "debate" }))).toBe("relevance");
    expect(requestsOrderInForce(parseRequestsView({ order: "relevance" }))).toBe("importance");
    expect(requestsOrderInForce(parseRequestsView({ q: "debate", order: "recent" }))).toBe("recent");
  });

  it("changes one thing at a time, back to the first page, leaving defaults out", () => {
    const view = parseRequestsView({ tag: "ai-safety", page: "4" });
    expect(requestsHref(view, { waiting: true })).toBe("/requests?tag=ai-safety&waiting=1");
    expect(requestsHref(view, { page: 5 })).toBe("/requests?tag=ai-safety&page=5");
    expect(requestsHref(view, { tag: null })).toBe("/requests");
    expect(requestsHref(view, { stands: "any" })).toBe("/requests?tag=ai-safety&stands=any");
  });

  it("asks the API for one page of the view, with its facets", () => {
    const q = requestsApiQuery(parseRequestsView({ q: "debate", asked: "anyone", waiting: "1", page: "2" }));
    expect(Object.fromEntries(q)).toEqual({
      limit: "30",
      offset: "30",
      order: "relevance",
      facets: "true",
      state: "live",
      q: "debate",
      asked: "anyone",
      waiting: "true",
    });
    expect(requestsApiQuery(parseRequestsView({ stands: "any" })).has("state")).toBe(false);
  });
});

describe("a request's figures", () => {
  const base = { state: "open", ledger: null } as unknown as RequestItem;
  it("says where the money stands, and only while the request is live", () => {
    expect(fundingWords({ ...base, ledger: { action_id: "a", variant: "full", status: "open", cost_usd: 4, backing_usd: 0 } })).toEqual({
      words: "$4.00 to do, waiting for a funder",
      waiting: true,
    });
    expect(fundingWords({ ...base, ledger: { action_id: "a", variant: "scope", status: "open", cost_usd: 0.4, backing_usd: 0 } })?.waiting).toBe(true);
    expect(fundingWords({ ...base, ledger: { action_id: "a", variant: "full", status: "open", cost_usd: 4, backing_usd: 4 } })?.words).toBe(
      "commissioned, starting shortly"
    );
    expect(fundingWords({ ...base, ledger: { action_id: "a", variant: "full", status: "running", cost_usd: 4, backing_usd: 4 } })?.waiting).toBe(false);
    expect(fundingWords({ ...base, state: "in_progress" })?.words).toBe("under way");
    // In progress with its row open again: the next stage is what waits, not the request.
    expect(
      fundingWords({ ...base, state: "in_progress", ledger: { action_id: "a", variant: "full", status: "open", cost_usd: 4, backing_usd: 0 } })
    ).toEqual({ words: "next stage $4.00, waiting for a funder", waiting: true });
    expect(fundingWords({ ...base, state: "met" })).toBeNull();
  });

  it("reads importance on the ten-point scale the other pages use", () => {
    expect(importanceOutOfTen(0.47)).toBe(5);
    expect(importanceOutOfTen(0.01)).toBe(1);
    expect(importanceOutOfTen(null)).toBeNull();
  });
});
