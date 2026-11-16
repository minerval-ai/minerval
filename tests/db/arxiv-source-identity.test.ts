/**
 * One arXiv paper at its abs, pdf and html addresses is one document
 * (#1047): a source asked for at one address takes the row recorded at
 * another, and where an older pair is still two rows, a quotation is
 * checked against the paper's full text rather than the abstract page's.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { recordInstanceReading, recordedQuoteProblem } from "../../src/services/source-map-service.js";
import { seedClaim } from "./helpers.js";

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const arxivId = () => `${digits(4)}.${digits(5)}`;

const ABSTRACT = "Abstract: we study the reserve and find it adequate.";
const PAPER =
  "Introduction. We study the reserve. Section 2. The reserve stood at 4 million in the second quarter, " +
  "well above what the rules require. Section 3. Conclusions follow.";

async function instance(claimId: string, sourceId: string, verbatim: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, $3) RETURNING id`,
    [claimId, sourceId, verbatim]
  );
  return row!.id;
}

describe("an arXiv paper's source", () => {
  it("is the row recorded at another address of the same paper and version", async () => {
    const id = arxivId();
    const pdf = await getOrCreateSource({ url: `https://arxiv.org/pdf/${id}v1`, content: PAPER });
    expect((await getOrCreateSource({ url: `https://arxiv.org/abs/${id}v1` })).id).toBe(pdf.id);
    expect((await getOrCreateSource({ url: `https://arxiv.org/html/${id}v1/` })).id).toBe(pdf.id);
    expect((await getOrCreateSource({ url: `http://www.arxiv.org/pdf/${id}v1.pdf` })).id).toBe(pdf.id);
    // Another version, or the unversioned address, is another text.
    expect((await getOrCreateSource({ url: `https://arxiv.org/abs/${id}v2` })).id).not.toBe(pdf.id);
    expect((await getOrCreateSource({ url: `https://arxiv.org/abs/${id}` })).id).not.toBe(pdf.id);
  });

  it("is never the abstract page's row for a full-text address, and the abs address takes the fuller row", async () => {
    const id = arxivId();
    const abs = await getOrCreateSource({ url: `https://arxiv.org/abs/${id}`, content: ABSTRACT });
    const pdf = await getOrCreateSource({ url: `https://arxiv.org/pdf/${id}`, content: PAPER });
    expect(pdf.id).not.toBe(abs.id);
    expect(pdf.rawContent).toBe(PAPER);
    // The abs row the address names is there, but the pdf row holds more of the paper.
    expect((await getOrCreateSource({ url: `https://arxiv.org/abs/${id}` })).id).toBe(pdf.id);
  });

  it("is not a row at another address that holds no text", async () => {
    const id = arxivId();
    const pdf = await getOrCreateSource({ url: `https://arxiv.org/pdf/${id}` });
    const abs = await getOrCreateSource({ url: `https://arxiv.org/abs/${id}`, content: ABSTRACT });
    expect(abs.id).not.toBe(pdf.id);
    expect(abs.rawContent).toBe(ABSTRACT);
  });
});

describe("a quotation on an arXiv paper's abstract-page row", () => {
  async function legacyPair() {
    const id = arxivId();
    const abs = await getOrCreateSource({ url: `https://arxiv.org/abs/${id}`, content: ABSTRACT });
    const pdf = await getOrCreateSource({ url: `https://arxiv.org/pdf/${id}`, content: PAPER });
    return { abs, pdf };
  }

  it("is checked against the same paper's full text, and the reading says where", async () => {
    const { abs, pdf } = await legacyPair();
    const claimId = await seedClaim("arxiv-sibling");
    const found = await instance(claimId, abs.id, "The reserve stood at 4 million in the second quarter");
    const result = await recordInstanceReading({ claimId, instanceId: found, support: "supports", createdBy: "claim_steward" });
    expect(result.quote_check).toBe("verbatim");
    expect(result.quote_checked_in).toEqual({ source_id: pdf.id, url: pdf.url });

    const missing = await instance(claimId, abs.id, "The reserve was exhausted by March");
    const notFound = await recordInstanceReading({ claimId, instanceId: missing, support: "supports", createdBy: "claim_steward" });
    expect(notFound.quote_check).toBe("not_found");
    expect(notFound.quote_checked_in).toBeUndefined();

    // A passage the abstract holds is checked there.
    const own = await instance(claimId, abs.id, "we study the reserve and find it adequate");
    const ownResult = await recordInstanceReading({ claimId, instanceId: own, support: "supports", createdBy: "claim_steward" });
    expect(ownResult.quote_check).toBe("verbatim");
    expect(ownResult.quote_checked_in).toBeUndefined();
  });

  it("with cuts is recorded when the full text holds its pieces, and refused when it does not", async () => {
    const { abs } = await legacyPair();
    expect(await recordedQuoteProblem(abs.id, "We study the reserve. [...] The reserve stood at 4 million")).toBeNull();
    expect(await recordedQuoteProblem(abs.id, "We study the reserve. [...] The reserve was exhausted")).toMatch(
      /is not in the source's stored text/
    );
  });
});
