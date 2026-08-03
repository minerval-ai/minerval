/**
 * "Cite this claim" endpoint (#290): GET /claims/:id/citation serves the
 * citation + evidence record envelope as JSON, and the bibtex/csl renderings
 * under their conventional content types.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const CLAIM_ID = "11111111-1111-1111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  assembleClaimCitation: vi.fn(),
  assembleClaimNanopub: vi.fn(),
}));

// The claims route module pulls in the whole read stack; stub every service
// import so registering the routes needs no database.
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(),
  listClaims: vi.fn(),
  proposeClaim: vi.fn(),
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  getContributionRecordForClaim: vi.fn(),
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getAssessmentHistory: vi.fn(),
  getAssessmentTrajectory: vi.fn(),
}));
vi.mock("../../../src/services/search-service.js", () => ({
  hybridSearch: vi.fn(),
}));
vi.mock("../../../src/services/tree-service.js", () => ({
  getClaimTree: vi.fn(),
  getSubclaimCount: vi.fn(),
  getClaimDependents: vi.fn(),
  listClaimDependents: vi.fn(),
}));
vi.mock("../../../src/services/argument-service.js", () => ({
  addArgument: vi.fn(),
  getArgumentsForClaim: vi.fn(),
}));
vi.mock("../../../src/services/intake-service.js", () => ({
  createClaimProposal: vi.fn(),
}));
vi.mock("../../../src/services/citation-service.js", () => ({
  assembleClaimCitation: mocks.assembleClaimCitation,
}));
vi.mock("../../../src/services/nanopub-service.js", () => ({
  assembleClaimNanopub: mocks.assembleClaimNanopub,
}));
vi.mock("../../../src/server/contributor-gate.js", () => ({
  gateContributor: vi.fn(),
}));
vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn() }));

import { claimRoutes } from "../../../src/routes/claims.js";

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async () => {});
  app.decorate("requireAgenticQuota", async () => {});
  await app.register(claimRoutes, { prefix: "/claims" });
  return app;
}

function assembled() {
  return {
    citation: {
      author: "Minerval",
      title: "Water boils at 100°C at sea level.",
      claim_id: CLAIM_ID,
      assessment_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      assessment_version: 2,
      status: "supported",
      assessed_at: "2026-07-30T00:00:00.000Z",
      retrieved_at: "2026-08-03T00:00:00.000Z",
      url: `https://minerval.ai/claims/${CLAIM_ID}`,
      text: "Minerval. “Water boils…” …",
      bibtex: "@misc{minerval_claim_11111111,\n}",
      csl: { id: "minerval-claim-11111111", type: "webpage" },
    },
    evidence_record: {
      claim: { id: CLAIM_ID, text: "Water boils at 100°C at sea level." },
      assessment: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", version: 2 },
      arguments: [],
      instances: [],
      disagreement: {
        contested: false,
        affirming_instances: 1,
        denying_instances: 0,
        contested_arguments: [],
      },
    },
  };
}

beforeEach(() => {
  mocks.assembleClaimCitation.mockReset().mockResolvedValue(assembled());
  mocks.assembleClaimNanopub.mockReset().mockResolvedValue({
    contentType: "application/trig; charset=utf-8",
    body: "@prefix np: <http://www.nanopub.org/nschema#> .",
  });
});

describe("GET /claims/:claim_id/citation (#290)", () => {
  it("404s for an unknown claim", async () => {
    mocks.assembleClaimCitation.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/citation` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("serves the citation + evidence record envelope as JSON by default", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/citation` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.citation.author).toBe("Minerval");
    expect(body.citation.assessment_version).toBe(2);
    expect(body.evidence_record.disagreement.affirming_instances).toBe(1);
  });

  it("serves BibTeX as text under its conventional content type", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/${CLAIM_ID}/citation?format=bibtex`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-bibtex");
    expect(res.body).toContain("@misc{minerval_claim_11111111,");
  });

  it("serves CSL JSON under the citationstyles content type", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/${CLAIM_ID}/citation?format=csl`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.citationstyles.csl+json"
    );
    expect(JSON.parse(res.body)).toEqual({
      id: "minerval-claim-11111111",
      type: "webpage",
    });
  });

  it("rejects an unknown format", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/${CLAIM_ID}/citation?format=ris`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /claims/:claim_id/nanopub (#292)", () => {
  it("404s for an unknown claim", async () => {
    mocks.assembleClaimNanopub.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/nanopub` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("serves TriG by default under its content type", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/nanopub` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/trig");
    expect(res.body).toContain("@prefix np:");
    expect(mocks.assembleClaimNanopub).toHaveBeenCalledWith(CLAIM_ID, "trig");
  });

  it("serves JSON-LD when asked", async () => {
    mocks.assembleClaimNanopub.mockResolvedValue({
      contentType: "application/ld+json; charset=utf-8",
      body: '{"@context":{}}',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/${CLAIM_ID}/nanopub?format=jsonld`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/ld+json");
    expect(mocks.assembleClaimNanopub).toHaveBeenCalledWith(CLAIM_ID, "jsonld");
  });

  it("rejects an unknown format", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/${CLAIM_ID}/nanopub?format=rdfxml`,
    });
    expect(res.statusCode).toBe(400);
  });
});
