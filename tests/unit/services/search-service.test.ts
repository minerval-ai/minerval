import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(),
}));

vi.mock("../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    openaiApiKey: "test-key",
    databaseUrl: "postgresql://test",
  }),
}));

import { hybridSearch, findSimilarClaims } from "../../../src/services/search-service.js";
import { rawQuery } from "../../../src/db/client.js";
import { generateEmbedding } from "../../../src/services/embedding-service.js";

const mockRawQuery = vi.mocked(rawQuery);
const mockGenerateEmbedding = vi.mocked(generateEmbedding);

describe("search-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hybridSearch", () => {
    it("uses hybrid search when embedding succeeds", async () => {
      const fakeEmbedding = new Array(1536).fill(0.1);
      mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
      mockRawQuery.mockResolvedValueOnce([
        {
          id: "claim-1",
          text: "Test claim",
          claim_type: "empirical_derived",
          state: "active",
          text_rank: 0.5,
          semantic_score: 0.8,
          assessment_status: "verified",
          assessment_confidence: 0.9,
        },
      ]);

      const result = await hybridSearch("test query");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.id).toBe("claim-1");
      // similarity_score is the cosine similarity, not a keyword/semantic blend (#43)
      expect(result.results[0]!.similarity_score).toBeCloseTo(0.8, 2);
    });

    it("orders by semantic proximity with keyword rank as tiebreak", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(new Array(1536).fill(0.1));
      mockRawQuery.mockResolvedValueOnce([]);

      await hybridSearch("test query");
      const [sql] = mockRawQuery.mock.calls[0]!;
      expect(sql).toMatch(
        /ORDER BY COALESCE\(1 - \(c\.embedding <=> \$2::vector\), 0\) DESC,\s*ts_rank/
      );
      // No blended keyword+semantic ordering expression
      expect(sql).not.toContain("0.4 *");
      expect(sql).not.toContain("0.6 *");
    });

    it("scores claims with NULL embeddings as 0", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(new Array(1536).fill(0.1));
      mockRawQuery.mockResolvedValueOnce([
        {
          id: "claim-no-embedding",
          text: "Keyword-only match",
          claim_type: "empirical_derived",
          state: "active",
          text_rank: 0.9,
          semantic_score: null,
          assessment_status: null,
          assessment_confidence: null,
        },
      ]);

      const result = await hybridSearch("test query");
      expect(result.results[0]!.similarity_score).toBe(0);
    });

    it("falls back to keyword search when embedding fails", async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error("API error"));
      mockRawQuery.mockResolvedValueOnce([
        {
          id: "claim-1",
          text: "Test claim",
          claim_type: "empirical_derived",
          state: "active",
          text_rank: 0.7,
          assessment_status: null,
          assessment_confidence: null,
        },
      ]);

      const result = await hybridSearch("test query");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.similarity_score).toBeCloseTo(0.7, 2);
    });
  });

  describe("filters", () => {
    const embedding = () => new Array(1536).fill(0.1);

    it("adds an unassessed predicate without shifting the LIMIT placeholder", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(embedding());
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q", { assessed: "unassessed" });
      const [sql, params] = mockRawQuery.mock.calls[0]!;
      expect(sql).toContain("AND NOT (CASE c.kind");
      // query, embedding, minSimilarity, limit — the predicate binds no param.
      expect(params).toHaveLength(4);
      expect(sql).toContain("LIMIT $4");
    });

    it("adds an assessed predicate", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(embedding());
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q", { assessed: "assessed" });
      expect(mockRawQuery.mock.calls[0]![0]).toContain("a.status IS NOT NULL");
    });

    // A question's verdict is its standing and a quantity's its estimate;
    // neither ever gets an `assessments` row, so keying "assessed" off
    // a.status alone hid every question and quantity from the default view.
    it("judges each kind by its own verdict table", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(embedding());
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q", { assessed: "assessed" });
      const sql = mockRawQuery.mock.calls[0]![0] as string;
      expect(sql).toContain("WHEN 'question' THEN qa.id IS NOT NULL");
      expect(sql).toContain("WHEN 'quantity' THEN qe.id IS NOT NULL");
      expect(sql).toContain("LEFT JOIN question_assessments qa ON qa.claim_id = c.id AND qa.is_current = true");
      expect(sql).toContain("LEFT JOIN quantity_estimates qe ON qe.claim_id = c.id AND qe.is_current = true");
    });

    it("binds a kind filter", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(embedding());
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q", { kind: "question" });
      const [sql, params] = mockRawQuery.mock.calls[0]!;
      expect(sql).toContain("AND c.kind = $4");
      expect(sql).toContain("LIMIT $5");
      expect(params![3]).toBe("question");
    });

    it("binds min_importance and shifts the LIMIT placeholder", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(embedding());
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q", { minImportance: 0.65 });
      const [sql, params] = mockRawQuery.mock.calls[0]!;
      expect(sql).toContain("c.importance >= $4");
      expect(sql).toContain("LIMIT $5");
      // query, embedding, minSimilarity, minImportance, limit
      expect(params).toHaveLength(5);
      expect(params![3]).toBe(0.65);
    });

    it("adds no filter clauses by default", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(embedding());
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q");
      const [sql, params] = mockRawQuery.mock.calls[0]!;
      expect(sql).not.toContain("a.status IS");
      expect(sql).not.toContain("c.importance >=");
      expect(params).toHaveLength(4);
    });

    it("applies filters on the keyword fallback with the right param indices", async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error("no embedding"));
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q", { assessed: "unassessed", minImportance: 0.45 });
      const [sql, params] = mockRawQuery.mock.calls[0]!;
      expect(sql).toContain("AND NOT (CASE c.kind");
      expect(sql).toContain("c.importance >= $2");
      expect(sql).toContain("LIMIT $3");
      // query, minImportance, limit
      expect(params).toHaveLength(3);
    });
  });

  describe("kinds", () => {
    it("serves each result's kind and only that kind's verdict fields", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(new Array(1536).fill(0.1));
      const base = {
        claim_type: "empirical_derived",
        state: "active",
        text_rank: 0.1,
        semantic_score: 0.8,
        assessment_status: null,
        assessment_confidence: null,
        standing: null,
        estimate: null,
        unit: null,
      };
      mockRawQuery.mockResolvedValueOnce([
        { ...base, id: "c", kind: "claim", text: "A claim", assessment_status: "verified" },
        { ...base, id: "q", kind: "question", text: "Why?", standing: "leaning" },
        {
          ...base,
          id: "n",
          kind: "quantity",
          text: "How many?",
          estimate: { form: "point", value: 3 },
          unit: { kind: "count" },
        },
      ]);

      const { results } = await hybridSearch("q");
      const [claim, question, quantity] = results;
      expect(claim).toMatchObject({ kind: "claim" });
      expect(claim).not.toHaveProperty("standing");
      expect(claim).not.toHaveProperty("estimate");
      expect(question).toMatchObject({ kind: "question", standing: "leaning" });
      expect(question).not.toHaveProperty("estimate");
      expect(quantity).toMatchObject({
        kind: "quantity",
        estimate: { form: "point", value: 3 },
        unit: { kind: "count" },
      });
      expect(quantity).not.toHaveProperty("standing");
    });
  });

  // The archive contract: every search path serves ONLY state='active' claims,
  // as an allowlist. This keeps archived epoch cohorts out of the matcher's
  // candidate pool — a blocklist (state != 'deprecated') would let new
  // ingestion link into retired structure and resurrect it.
  describe("active-only filtering", () => {
    it("hybrid (embedding) search filters to state = 'active'", async () => {
      mockGenerateEmbedding.mockResolvedValueOnce(new Array(1536).fill(0.1));
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q");
      const sql = mockRawQuery.mock.calls[0]![0] as string;
      expect(sql).toContain("c.state = 'active'");
      expect(sql).not.toContain("!= 'deprecated'");
    });

    it("keyword-fallback search filters to state = 'active'", async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error("embeddings down"));
      mockRawQuery.mockResolvedValueOnce([]);
      await hybridSearch("q");
      const sql = mockRawQuery.mock.calls[0]![0] as string;
      expect(sql).toContain("c.state = 'active'");
      expect(sql).not.toContain("!= 'deprecated'");
    });

    it("findSimilarClaims (matcher candidates) filters to state = 'active'", async () => {
      mockRawQuery.mockResolvedValueOnce([]);
      await findSimilarClaims(new Array(1536).fill(0.1));
      const sql = mockRawQuery.mock.calls[0]![0] as string;
      expect(sql).toContain("c.state = 'active'");
      expect(sql).not.toContain("!= 'deprecated'");
    });
  });

  describe("findSimilarClaims", () => {
    it("finds similar claims by embedding", async () => {
      const embedding = new Array(1536).fill(0.1);
      mockRawQuery.mockResolvedValueOnce([
        {
          id: "claim-1",
          text: "Similar claim",
          claim_type: "empirical_derived",
          state: "active",
          semantic_score: 0.92,
          assessment_status: null,
          assessment_confidence: null,
        },
      ]);

      const results = await findSimilarClaims(embedding, {
        limit: 5,
        minSimilarity: 0.85,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.similarity_score).toBe(0.92);
    });

    it("excludes specific claim ID", async () => {
      const embedding = new Array(1536).fill(0.1);
      mockRawQuery.mockResolvedValueOnce([]);

      await findSimilarClaims(embedding, {
        excludeId: "exclude-me",
      });

      // Verify the query was called with 4 params (includes exclude ID)
      const call = mockRawQuery.mock.calls[0]!;
      expect(call[1]).toHaveLength(4);
      expect(call[1]![3]).toBe("exclude-me");
    });
  });
});
