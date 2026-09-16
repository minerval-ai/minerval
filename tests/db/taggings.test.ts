/**
 * Source-scoped tagging replacement (#272) against real Postgres. The mocked
 * unit suite swallows the delete's WHERE clause, so it could not see that the
 * "keep these tag ids" condition rendered as a tuple cast Postgres rejects,
 * which parked every tagger run in production. Here the SQL actually runs.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { getTagsForSubject, setSubjectTags } from "../../src/services/tag-service.js";

async function seedTag(label: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO tags (slug, name, description, created_by)
     VALUES ($1, $2, $3, 'dbtest') RETURNING id`,
    [`dbtest-${label}-${suffix}`, `DB test ${label} ${suffix}`, `Scratch tag for ${label}.`]
  );
  return rows[0]!.id;
}

async function tagIds(claimId: string, source?: string): Promise<string[]> {
  const rows = await getTagsForSubject("claim", claimId);
  return rows
    .filter((t) => !source || t.source === source)
    .map((t) => t.id)
    .sort();
}

describe("setSubjectTags (#272)", () => {
  it("keeps the tags it is given, whether one or several, and drops its own stale rows", async () => {
    const claim = await seedClaim("tagging");
    const [a, b, c] = await Promise.all([seedTag("a"), seedTag("b"), seedTag("c")]);

    // First pass: two tags.
    const first = await setSubjectTags({
      kind: "claim",
      subjectId: claim,
      source: "tagger",
      assignments: [
        { tagId: a, confidence: 0.9, reasoning: "first" },
        { tagId: b, confidence: 0.6, reasoning: "first" },
      ],
    });
    expect(first.attached.map((t) => t.id).sort()).toEqual([a, b].sort());
    expect(first.removed).toBe(0);
    expect(await tagIds(claim, "tagger")).toEqual([a, b].sort());

    // Second pass keeps b, swaps a for c: a's row goes, b's stays, c arrives.
    const second = await setSubjectTags({
      kind: "claim",
      subjectId: claim,
      source: "tagger",
      assignments: [
        { tagId: b, confidence: 0.7 },
        { tagId: c, confidence: 0.8 },
      ],
    });
    expect(second.removed).toBe(1);
    expect(await tagIds(claim, "tagger")).toEqual([b, c].sort());

    // A single-tag pass (the one-element case renders differently) keeps only c.
    const third = await setSubjectTags({
      kind: "claim",
      subjectId: claim,
      source: "tagger",
      assignments: [{ tagId: c, confidence: 0.8 }],
    });
    expect(third.removed).toBe(1);
    expect(await tagIds(claim, "tagger")).toEqual([c]);
  });

  it("leaves another source's rows alone", async () => {
    const claim = await seedClaim("tagging-sources");
    const [byOperator, byTagger] = await Promise.all([seedTag("op"), seedTag("tg")]);
    await setSubjectTags({
      kind: "claim",
      subjectId: claim,
      source: "operator",
      assignments: [{ tagId: byOperator, confidence: 1 }],
    });
    await setSubjectTags({
      kind: "claim",
      subjectId: claim,
      source: "tagger",
      assignments: [{ tagId: byTagger, confidence: 0.5 }],
    });
    // The tagger clearing itself does not touch the operator's row.
    const cleared = await setSubjectTags({
      kind: "claim",
      subjectId: claim,
      source: "tagger",
      assignments: [],
    });
    expect(cleared.removed).toBe(1);
    expect(await tagIds(claim)).toEqual([byOperator]);
  });
});
