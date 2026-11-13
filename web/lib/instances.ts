import type { Instance } from "./types";

/**
 * A claim's instances as the page shows them: the voices, the sources that
 * assert, deny or pose the claim, and apart from them the sources that only
 * mention it. A mention is provenance (who cites the claim, how it is used),
 * never a vote, so it is never listed among the voices or counted with them.
 * Order within each group is the order the API served.
 */
export function splitInstances<T extends Pick<Instance, "stance">>(instances: readonly T[]): {
  voices: T[];
  mentions: T[];
} {
  const voices: T[] = [];
  const mentions: T[] = [];
  for (const i of instances) (i.stance === "mentions" ? mentions : voices).push(i);
  return { voices, mentions };
}

/** The tag an instance carries for its stance; null for one that simply affirms. */
export function stanceTag(stance: Instance["stance"]): { word: string; title: string } | null {
  switch (stance) {
    case "denies":
      return { word: "denies", title: "This source denies the claim as stated." };
    case "poses":
      return { word: "poses it as a question", title: "This source states the claim as an open question, taking no side." };
    case "mentions":
      return {
        word: "mentions",
        title: "This source refers to the claim without taking a side: it cites it or reports the debate. It is not counted as affirming or denying.",
      };
    // A view stated to the graph directly may stand in terms that take no
    // side on the claim as worded (§4).
    case "qualifies":
      return { word: "qualifies it", title: "This source holds the claim only with a condition or limit it states." };
    case "gives_probability":
      return { word: "gives it a probability", title: "This source gives the claim a probability and takes no side." };
    default:
      return null;
  }
}
