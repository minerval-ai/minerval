import { formatOwls } from "@/lib/format";
import { DEFINED_IN, RULES_SOURCE } from "@/lib/ontology";
import { Term } from "../Term";

// The small amount chip on list cards (docs/mathematics.md §8.3): the live
// bounty on a claim, in owls, double-ruled like the map's prize ring. It
// sits after the type tag, never beside the importance figure: a prize next to
// an importance label invites the reading that a large prize means a large
// importance, and the gloss says so.
export function PrizeChip({ micro, linkTo }: { micro: number; linkTo?: string }) {
  const amount = formatOwls(micro);
  return (
    <Term
      gloss={`A prize of ${amount} is offered for a machine-checked proof or disproof of this claim's formal statement. Owls are Minerval's unit of metered work on the graph. Offering a prize does not change how the claim is assessed or how important the graph judges it to be; it says only that someone would like the question settled.`}
      href={DEFINED_IN.prize}
      source={RULES_SOURCE}
      linkTo={linkTo}
      className="tag prize"
      ariaLabel={`prize: ${amount}`}
    >
      {amount}
    </Term>
  );
}
