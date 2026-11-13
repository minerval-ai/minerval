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
