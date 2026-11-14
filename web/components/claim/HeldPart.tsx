import type { HeldBlock } from "@/lib/published-page/shape";

// A part of a published page that is held (docs/published-pages.md): it
// stands where the part stood and says what kind of part it was, who holds
// it and since when. Drawn in ink, with no status colour, so that a hold is
// not read as a verdict on the claim.
export function HeldPart({ held }: { held: HeldBlock }) {
  const since = held.since ? new Date(held.since).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : null;
  return (
    <div className="held-part" role="note">
      <span className="held-mark" aria-hidden />
      <span>
        {held.what}, held{held.by.length > 0 ? ` by ${held.by.join(" and ")}` : ""}
        {since ? ` since ${since}` : ""}.
        {held.reasons.length > 0 && (
          <span className="held-reason"> Reason given: {held.reasons.join("; ")}. The holder chose it from a fixed list, and nobody checks it.</span>
        )}
      </span>
    </div>
  );
}
