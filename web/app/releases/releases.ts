import "server-only";
import { fetchGates, fetchRelease, type AskedPage, type AskedReleaseRow, type Gate, type ReleaseScope, type ReceivedRelease, type ReceivedVersion } from "@/lib/inside-api";
import { capital } from "@/lib/inside-words";
import { pipelineOf, type Pipeline } from "@/lib/pipeline";

// What the pages for releases share: the words for a release's kind, the two
// ends of its boundary, the one status of a version from whichever sides the
// viewer reads, and a bounded fetch of releases' details.

/** "Standing" or "Once", and what it covers, as the Kind column says them. */
const COVERS: Record<ReleaseScope, string> = {
  node: "This node",
  under: "Subtree",
  mandate: "A mandate's work",
  boundary: "Whole boundary",
  item: "One item",
};

export function kindOf(form: string, scope: ReleaseScope): { form: string; covers: string } {
  return { form: form === "standing" ? "Standing" : "Once", covers: COVERS[scope] };
}

/** What the kind undertakes, in one line, for a Tip. */
const SCOPE_TIPS: Record<ReleaseScope, string> = {
  node: "",
  under: " Subtree: nodes under this one are covered too, including ones that come later.",
  boundary: " Whole boundary: every node assessed at the label goes through.",
  mandate: " A mandate's work: every node whose assessment that mandate's budget paid for.",
  item: " One item: a thing offered to the gate that is not a node's page, such as an answer to a request.",
};

export function kindTip(form: string, scope: ReleaseScope): string {
  const f =
    form === "standing"
      ? "Standing: each later assessment follows, and one not released shows on the other side as held."
      : "Once: the page as it stood, with nothing undertaken about later assessments.";
  return f + SCOPE_TIPS[scope];
}

/** The label (or "outside") a release goes to, from either side's way of saying it. */
export function destinationOf(releasedTo: string): string {
  if (releasedTo === "outside this deployment") return "outside";
  const m = releasedTo.match(/^readers at "(.*)"$/);
  return m ? m[1]! : releasedTo;
}

/** The gate between two labels, where the viewer may read the gates. */
export function gateFor(gates: Gate[] | null, from: string | null, to: string): Gate | undefined {
  if (!gates || !from) return undefined;
  return gates.find((g) => g.from === from && (to === "outside" ? g.to_outside : g.to === to && !g.to_outside));
}

export async function loadGates(externalId: string): Promise<Gate[] | null> {
  return fetchGates(externalId)
    .then((g) => g.gates)
    .catch(() => null);
}

/** The newest version that is not overtaken, else the newest. Pages come newest first. */
export function latestPage(pages: AskedPage[]): AskedPage | undefined {
  return pages.find((p) => p.stage !== "overtaken") ?? pages[0];
}

/** One version's status, from the page's side, the other side, or both. */
export function statusOf(page: AskedPage | undefined, version: ReceivedVersion | undefined): Pipeline {
  return pipelineOf({
    stage: page?.stage ?? null,
    stageInWords: page?.stage_in_words ?? null,
    waitingOn: page?.waiting_on ?? null,
    returnedByAudit: !!page?.audit_reasons && page.stage === "to_redact",
    state: version?.state ?? null,
    heldBecause: version?.held_because ?? null,
    partsHeld: version?.parts_held ?? null,
    ofParts: version?.of_parts ?? null,
  });
}

/** Every version of a release, by page id, from the side it is shown to. */
export function versionsById(release: ReceivedRelease | null | undefined): Map<string, ReceivedVersion> {
  const out = new Map<string, ReceivedVersion>();
  for (const n of release?.nodes ?? []) for (const v of n.versions) out.set(v.page_id, v);
  return out;
}

/**
 * The details of several releases, a few at a time. GET /releases lists the
 * side shown to without the node's words or where its pages stand, so a list
 * of those asks for each; the bound keeps a long list from opening as many
 * requests at once.
 */
export async function fetchDetails(externalId: string, ids: string[], concurrency = 4): Promise<Map<string, ReceivedRelease>> {
  const out = new Map<string, ReceivedRelease>();
  const queue = [...new Set(ids)];
  async function worker() {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const d = await fetchRelease(externalId, id).catch(() => null);
      if (d) out.set(id, d);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/**
 * What a release with no single node is about, in place of a node's words:
 * the API's own words for what it covers where the viewer reads the side it
 * is released to (GET /releases/:id, `scope`, which names the mandate and the
 * label where they may be told them), else words from its scope. Null for a
 * release of a node.
 */
export function wholeOf(scope: ReleaseScope, from: string | null, words?: string | null): string | null {
  if (scope === "node" || scope === "under") return null;
  if (words) return capital(words);
  if (scope === "boundary") return from ? `Everything written at ${from}` : "Everything written at a label you do not read";
  if (scope === "mandate") return "The work a mandate paid for";
  return "One item";
}

export type { AskedReleaseRow };
