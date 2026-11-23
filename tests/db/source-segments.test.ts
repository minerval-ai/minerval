/**
 * Segments (#507, phase 4) over real SQL: a source is divided once and its
 * instances anchored to their passages, the tree's parents resolve within
 * one insert, re-segmenting replaces rather than duplicates, and the
 * annotated document carries each claim Steward's reading on its passage.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { getSourceDocument, segmentSource, segmentSourceOnce } from "../../src/services/source-segment-service.js";

const HTML = `<html><head><title>t</title></head><body>
  <h1>Night work and diabetes</h1>
  <p>Shift workers have long been suspected of higher metabolic risk.</p>
  <h2>Results</h2>
  <p>Rotating night work was associated with a 1.4&#8209;fold higher risk.</p>
  <h2>References</h2>
  <p>Smith J. Shift work. Lancet. 2010.</p>
</body></html>`;

async function seedSource(content: string | null): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content) VALUES ($1, 'Paper', $2) RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, content]
  );
  return rows[0]!.id;
}

async function seedInstance(claimId: string, sourceId: string, text: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, $3) RETURNING id`,
    [claimId, sourceId, text]
  );
  return rows[0]!.id;
}

describe("segmentSource", () => {
  it("writes the tree, anchors instances to their passages, and replaces on a second pass", async () => {
    const source = await seedSource(HTML);
    const claim = await seedClaim("night work raises diabetes risk");
    const found = await seedInstance(claim, source, "Rotating night work was associated with a 1.4-fold higher risk");
    const missing = await seedInstance(claim, source, "night work doubles the risk");
    await rawQuery(
      `INSERT INTO claim_instance_readings (instance_id, support, note, source_read) VALUES ($1, 'supports', 'A cohort result.', true)`,
      [found]
    );

    const first = await segmentSource(source);
    expect(first.anchored).toBe(1);
    const segs = await rawQuery<{ kind: string; label: string | null; parent_label: string | null }>(
      `SELECT s.kind, s.label, p.label AS parent_label FROM source_segments s
         LEFT JOIN source_segments p ON p.id = s.parent_id
        WHERE s.source_id = $1 ORDER BY s.ordinal`,
      [source]
    );
    expect(segs.map((s) => s.kind)).toContain("reference");
    expect(segs.find((s) => s.kind === "reference")!.parent_label).toBe("References");
    expect(first.segments).toBe(segs.length);

    const again = await segmentSource(source);
    expect(again.segments).toBe(first.segments);
    const [count] = await rawQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM source_segments WHERE source_id = $1`, [source]);
    expect(Number(count!.n)).toBe(first.segments);

    const doc = (await getSourceDocument(source))!;
    expect(doc.segmented).toBe(true);
    const passage = doc.segments.find((s) => s.instances.length > 0)!;
    expect(passage.text).toMatch(/^Rotating night work/);
    expect(passage.instances[0]).toMatchObject({
      instance_id: found,
      claim: { id: claim },
      reading: { support: "supports", note: "A cohort result.", source_read: true },
    });
    expect(doc.unanchored.map((i) => i.instance_id)).toEqual([missing]);
    expect(doc.segments.filter((s) => s.kind === "section").every((s) => s.text === null)).toBe(true);
  });

  it("segments once, anchors later instances on the next pass, and leaves a source without text alone", async () => {
    const source = await seedSource(HTML);
    await segmentSourceOnce(source);
    const claim = await seedClaim("shift workers metabolic risk");
    const later = await seedInstance(claim, source, "suspected of higher metabolic risk");
    await segmentSourceOnce(source);
    const [row] = await rawQuery<{ segment_id: string | null }>(`SELECT segment_id FROM claim_instances WHERE id = $1`, [later]);
    expect(row!.segment_id).not.toBeNull();

    const empty = await seedSource(null);
    await segmentSourceOnce(empty);
    expect((await getSourceDocument(empty))!).toMatchObject({ segmented: false, segments: [], total_chars: 0 });
    expect(await getSourceDocument(randomUUID())).toBeNull();
  });

  it("divides a page at its own headings, and takes no short line of it for one (#1127)", async () => {
    const source = await seedSource(
      `<html><body><h1>Night work</h1><div>A. N. Author</div><button><div class="label">Share</div></button>` +
        `<p><span>Risk was </span><a href="x">1.4-fold higher</a><span>. It held.</span></p><h2>Results</h2><p>More.</p></body></html>`
    );
    await segmentSource(source);
    const doc = (await getSourceDocument(source))!;
    expect(doc.segments.filter((s) => s.kind === "section").map((s) => s.label)).toEqual(["Night work", "Results"]);
    expect(doc.segments.filter((s) => s.kind !== "section").map((s) => s.text)).toEqual([
      "A. N. Author",
      "Risk was 1.4-fold higher. It held.",
      "More.",
    ]);
  });

  it("segments again when the stored segments no longer match the text, and not otherwise", async () => {
    const source = await seedSource(HTML);
    const claim = await seedClaim("night work and diabetes, read again");
    const instance = await seedInstance(claim, source, "Rotating night work was associated");
    await segmentSource(source);
    const ids = async () =>
      (await rawQuery<{ id: string }>(`SELECT id FROM source_segments WHERE source_id = $1 ORDER BY ordinal`, [source])).map((r) => r.id);
    const before = await ids();

    // Nothing changed: the page and the hook leave the segments as they are.
    await getSourceDocument(source);
    await segmentSourceOnce(source);
    expect(await ids()).toEqual(before);

    // As a source segmented under an earlier reading of its markup is found:
    // offsets and hashes that are not those of the text read now.
    await rawQuery(`UPDATE source_segments SET char_start = char_start + 3, char_end = char_end + 3 WHERE source_id = $1`, [source]);
    const doc = (await getSourceDocument(source))!;
    const after = await ids();
    expect(after).toHaveLength(before.length);
    expect(after.some((id) => before.includes(id))).toBe(false);
    const passage = doc.segments.find((s) => s.instances.some((i) => i.instance_id === instance))!;
    expect(passage.text).toMatch(/^Rotating night work/);

    // A page read does not start a segmentation; the hook does.
    const fresh = await seedSource(HTML);
    expect((await getSourceDocument(fresh))!.segmented).toBe(false);
    await segmentSourceOnce(fresh);
    expect((await getSourceDocument(fresh))!.segmented).toBe(true);
  });

  it("anchors a quotation with cuts at its first piece and shows the reader what each cut left out", async () => {
    const source = await seedSource(HTML);
    const claim = await seedClaim("night work and metabolic risk");
    const cut = await seedInstance(
      claim,
      source,
      "Shift workers have long been suspected of higher metabolic risk. [...] Rotating night work was associated with a 1.4-fold higher risk."
    );
    const swapped = await seedInstance(
      claim,
      source,
      "Rotating night work was associated with a 1.4-fold higher risk. [...] Shift workers have long been suspected"
    );
    await segmentSource(source);
    const doc = (await getSourceDocument(source))!;
    const at = doc.segments.find((s) => s.instances.some((i) => i.instance_id === cut))!;
    expect(at.text).toMatch(/^Shift workers/);
    const parts = at.instances.find((i) => i.instance_id === cut)!.quoted_parts!;
    expect(parts.map((p) => !!p.omitted)).toEqual([false, true, false]);
    expect(parts[0]!.text).toBe("Shift workers have long been suspected of higher metabolic risk.");
    // What the cut left out is the readable text, where a page's heading is a markdown line.
    expect(parts[1]!.text).toBe("## Results");
    expect(parts[2]!.text).toMatch(/^Rotating night work was associated with a 1\.4.fold higher risk\.$/);
    // Out of order is not the source's text.
    expect(doc.unanchored.map((i) => i.instance_id)).toEqual([swapped]);
    expect(doc.unanchored[0]!.quoted_parts).toBeUndefined();
  });
});
