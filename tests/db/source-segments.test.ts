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
});
