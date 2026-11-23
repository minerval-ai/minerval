// The bottom layers of a deployment's labels (the API's src/labels.ts, "The
// layers at the bottom"). On a members-only deployment three labels sit
// under the ones it defines:
//
//   the public graph's   `public`: the public graph's own material, as the
//                        mirror brings it in. Anyone reads it and nothing
//                        here writes it.
//   the published one    what the organization released outside. Anyone may
//                        read it; it is the organization's own.
//   the base one         the organization's own material that every member
//                        reads, where work that names no other label is done.
//
// The API says which label is which (GET /permissions/mine, label_layers),
// since a deployment that had already used a name calls the label something
// else. No page compares a label with the word "public" to decide what it
// is: it asks here.

/** The public graph's label, which is this word in every deployment (the API's PUBLIC_LABEL). */
export const PUBLIC_GRAPH_LABEL = "public";

export interface LabelLayers {
  public_graph: string;
  published: string;
  base: string;
  /** Whether the three are labels of their own. Where they are not, `public` is all three. */
  split: boolean;
}

export type LayerName = "public_graph" | "published" | "base";

/** A deployment whose `public` is all three: what an API that says nothing is read as. */
export const ONE_LAYER: LabelLayers = { public_graph: "public", published: "public", base: "public", split: false };

export const layersOf = (mine: { label_layers?: LabelLayers } | null | undefined): LabelLayers => mine?.label_layers ?? ONE_LAYER;

/**
 * Which bottom layer a label is, or null for a label the deployment defines.
 * Where the three are one label it is the base: the members' own layer is
 * what every page has shown it as.
 */
export function layerOf(label: string, layers: LabelLayers = ONE_LAYER): LayerName | null {
  if (label === layers.base) return "base";
  if (label === layers.public_graph) return "public_graph";
  if (label === layers.published) return "published";
  return null;
}

/** Whether anyone may read a label: the public graph's, or the published one. */
export const isOpenLabel = (label: string, layers: LabelLayers = ONE_LAYER): boolean =>
  label === layers.public_graph || label === layers.published;

/** Whether every member reads a label with no grant: what anyone may read, and the base label. */
export const isMemberLabel = (label: string, layers: LabelLayers = ONE_LAYER): boolean =>
  isOpenLabel(label, layers) || label === layers.base;

/**
 * Whether a label is one the deployment defines above the bottom layers:
 * the ones a person is granted, and a provider is cleared for by choice
 * alone. The base and published labels are not, though a provider is
 * cleared for each by choice too (clearedByChoice).
 */
export const isOwnLabel = (label: string, layers: LabelLayers = ONE_LAYER): boolean => !isMemberLabel(label, layers);

/** Whether which providers a label's text is sent to is the administrators' choice: every label but the public graph's. */
export const clearedByChoice = (label: string, layers: LabelLayers = ONE_LAYER): boolean => label !== layers.public_graph;

/** Whether work can be done at a label: not at the two anyone reads, once they are labels of their own. */
export const isWorkableLabel = (label: string, layers: LabelLayers = ONE_LAYER): boolean =>
  !layers.split || !isOpenLabel(label, layers);

const RANK: Record<LayerName, number> = { public_graph: 0, published: 1, base: 2 };

/** Where a label stands from the bottom: the public graph's, the published one, the base, then every other. */
export function layerRank(label: string, layers: LabelLayers = ONE_LAYER): number {
  if (label === layers.public_graph) return 0;
  if (layers.split && label === layers.published) return RANK.published;
  if (layers.split && label === layers.base) return RANK.base;
  return 3;
}

/** Labels in the order a page lists them: the bottom layers first, from the bottom, then by name. */
export const byLayerThenName =
  (layers: LabelLayers = ONE_LAYER) =>
  (a: string, b: string): number =>
    layerRank(a, layers) - layerRank(b, layers) || (a < b ? -1 : a > b ? 1 : 0);

/** What a bottom layer is called beside its label's name. */
export const LAYER_WORDS: Record<LayerName, string> = {
  public_graph: "Public graph",
  published: "Published",
  base: "Members",
};

/**
 * What a label is called where a page names the layer and not the label:
 * "Public graph", "Published", "Members", or the label's own name for one
 * the deployment defines. Where the three are one label, it is what it
 * always was: `public`, which there is the members' own.
 */
export function layerWord(label: string, layers: LabelLayers = ONE_LAYER): string {
  if (!layers.split) return label;
  const layer = layerOf(label, layers);
  return layer ? LAYER_WORDS[layer] : label;
}

/**
 * What a node's assessment at a label is called on its tab. Where the
 * bottom layers are one label it is the "Public assessment" it always was.
 */
export function assessmentName(label: string, layers: LabelLayers = ONE_LAYER): string {
  switch (layers.split ? layerOf(label, layers) : label === layers.public_graph ? "one" : null) {
    case "one":
      return "Public assessment";
    case "public_graph":
      return "The public graph's assessment";
    case "published":
      return "Published assessment";
    case "base":
      return "Members' assessment";
    default:
      return `Assessment at ${label}`;
  }
}

/** The same inside a sentence: "the public graph's assessment", "the assessment at finance". */
export function anAssessmentAt(label: string, layers: LabelLayers = ONE_LAYER): string {
  const name = assessmentName(label, layers);
  if (name.startsWith("The ")) return `the ${name.slice(4)}`;
  if (name.startsWith("Assessment at ")) return `the assessment at ${label}`;
  return `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

/** One line on what a bottom layer holds and who reads it, for a chip's title. */
export function layerLine(label: string, layers: LabelLayers = ONE_LAYER): string | undefined {
  if (!layers.split) return undefined;
  switch (layerOf(label, layers)) {
    case "public_graph":
      return "The public graph's own material, as the mirror brings it in. Anyone may read it; nothing here writes it.";
    case "published":
      return "What this organization released outside. Anyone may read it; it is the organization's own, not the public graph's.";
    case "base":
      return "This organization's own material that every member reads.";
    default:
      return undefined;
  }
}
