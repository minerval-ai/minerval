import type { ResolvedFrom } from "@/lib/types";
import { mergedFromRelation } from "@/lib/merged";

// The "merged from" line (#884): shown on a claim's page when the reader
// arrived by the address of a claim that was merged into it, so they know
// why the page is not the one they asked for and how the two relate.
export function MergedFromNote({ from }: { from: ResolvedFrom }) {
  const date = from.merged_at ? from.merged_at.slice(0, 10) : null;
  return (
    <div className="col" role="note" style={{ marginBottom: "1rem" }}>
      <p
        style={{
          fontFamily: "var(--sans)",
          fontSize: ".85rem",
          color: "var(--muted)",
          borderLeft: "2px solid var(--rule, currentColor)",
          paddingLeft: ".75rem",
          margin: 0,
        }}
      >
        Merged from “{from.canonical_form}”{date ? ` on ${date}` : ""}. The claim at the
        address you followed was merged into this one, and its address now leads here.{" "}
        {mergedFromRelation(from)}
      </p>
    </div>
  );
}
