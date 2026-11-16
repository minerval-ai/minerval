import Link from "next/link";

// Where more than one judgment of a node is in force for the reader (a
// private deployment's reader who holds two labels that do not read each
// other), a row that shows one of them says how many there are and links to
// the node, whose page sets each out in full. The API sends the count only
// then (`judgments_in_force`), so on the public graph this draws nothing.
export function SeveralAssessments({ id, n }: { id: string; n: number | null | undefined }) {
  if (!n || n < 2) return null;
  return (
    <Link
      className="tag several-assessments"
      href={`/claims/${id}`}
      title={`${n} assessments of this stand for you, made at labels that do not read each other. The one shown in this row is the most recently made, and none replaces another. The node's page has each in full.`}
    >
      {n} assessments
    </Link>
  );
}

// A summary drawn over several nodes (a rail's dots, the compass, the map's
// band) counts each node once, by the one assessment its row carries. Where
// some of those nodes have more than one that stands for the reader, the
// summary says how many, so a count never reads as the whole of it.
export function SeveralCounted({ n, of }: { n: number; of: string }) {
  if (n < 1) return null;
  return (
    <p className="several-counted">
      {n} of these {of} {n === 1 ? "has" : "have"} more than one assessment that stands for you, made at labels that
      do not read each other. Each is counted here by the most recently made.
    </p>
  );
}

/** How many of the rows have more than one judgment in force for the reader. */
export function severalAmong(rows: ReadonlyArray<{ judgments_in_force?: number }>): number {
  return rows.filter((r) => (r.judgments_in_force ?? 0) > 1).length;
}
