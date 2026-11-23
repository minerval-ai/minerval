import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * `public` used to mean three things at once: the public graph's own rows,
 * what a deployment has published, and the bottom layer of a deployment's
 * own work. On a members-only deployment those are three labels (#1203,
 * src/labels.ts, "The layers at the bottom"), so code says which it means:
 *
 *  - baseLabel(): the bottom layer of this deployment's own work. What work
 *    with no label named is done at, what every member reads with no grant
 *    (memberLabels, isMemberLabel), the label whose ledger keys are bare.
 *  - publishedLabel(): what the deployment released outside. Where the gate
 *    to outside writes and where the outbound and inbound work runs.
 *  - openLabels() / isOpenLabel(): what anyone may read, which every
 *    clearance holds.
 *  - PUBLIC_LABEL: the public graph's own label and nothing else: the
 *    mirror's rows, the publisher's side of the feed, the one label every
 *    provider is cleared for, and "is there any label besides this one".
 *
 * So every file under src/ that names `public` as a label, by the constant
 * or by the word in quotes, is listed here with why it means the public
 * graph's label (or means something that is not a label at all). A failure
 * means a file started naming it without that decision: use the name of the
 * layer it means, or, if it does mean the public graph's label, add the file
 * with its reason.
 *
 * The list is by file, so it does not see a new use added to a file already
 * on it. Reviewing a change to one of these files includes checking that.
 */
const MAY_NAME_PUBLIC: Record<string, string> = {
  "src/labels.ts": "Defines PUBLIC_LABEL and the names of the layers, which answer it until a deployment is split.",
  "src/db/schema.ts":
    "Declares the checks that name the public graph's label: it reads nothing, no stored choice narrows its provider clearance, and the layer public_graph is `public`. Also a column named public on setup_parts.",
  "src/db/clearance.ts":
    "The session of work with nothing in context starts from the public graph's label; normalizeClearance adds the rest of what anyone may read.",
  "src/db/client.ts":
    "The connection that checks what a cleared login sees is held to the public graph's label, the least a connection can read.",
  "src/db/enforcement.ts":
    "Asks whether a label besides the public graph's exists and whether a connection held to it alone sees a row beyond it; the quoted word is the schema named public.",
  "src/index.ts": "Asks whether any label besides the public graph's exists, to decide whether a failed enforcement step may be passed over.",
  "src/preflight.ts": "The provider setting's lines for the public graph's label, which every provider is cleared for, are not counted as a label to check.",
  "src/provider-labels.ts":
    "Every provider is cleared for the public graph's label, and the stored choice cannot narrow it: only the public graph's own text is there. The quoted word is in examples of the setting.",
  "src/llm/provider-clearance.ts": "A run at the public graph's label needs no stored choice read: every provider is cleared for it.",
  "src/services/provider-clearance-service.ts":
    "The stored choice has no rows for the public graph's label and refuses one: every provider is cleared for it.",
  "src/services/setup-checklist-service.ts":
    "Lists, for provider clearance and for grants, the labels besides the public graph's, which needs neither.",
  "src/services/permission-service.ts": "The first administrator is granted every label besides the public graph's, which needs no grant.",
  "src/services/label-admin-service.ts": "Defining any label but the public graph's arms enforcement first.",
  "src/services/label-service.ts":
    "publicIsTheOnlyLabel and labelsBesidesPublic ask about the public graph's label by definition; everyLabel leaves it out once nothing of this deployment's works there; the members-only description stands in for its stored one until a split.",
  "src/services/mirror-apply-service.ts": "The mirror's applier writes the public graph's own rows, at the public graph's label.",
  "src/services/mirror-feed-service.ts": "The publisher's side of the feed: the public graph serves its own rows, which are at its one label.",
  "src/services/outward-acts-service.ts": "Refuses adopting a public request at the public graph's label, where the work would be the public graph's own.",
  "src/services/request-adoption-service.ts": "Work at the public graph's label does not take up a mirrored request: that work is the public graph's own.",
  "src/llm/label-note.ts": "Tells a run which of what it reads is the public graph's own, by its label.",
  "src/config-file.ts": "The quoted word is in an example of the provider setting. No label is read.",
  "src/llm/run-visibility.ts": "Not a label: whether a run's transcript is public or private.",
  "src/routes/prizes.ts": "Not a label: an attachment's visibility.",
  "src/services/attachment-service.ts": "Not a label: an attachment's visibility.",
  "src/services/formalization-service.ts": "Not a label: an attachment's visibility, in a query.",
  "src/services/prize-claim-service.ts": "Not a label: an attachment's visibility.",
  "src/services/oidc-provider.ts": "Not a label: OpenID Connect's public subject type.",
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles(join(repo, "src"));
const naming = files
  .filter((path) => /PUBLIC_LABEL|["']public["']/.test(readFileSync(path, "utf-8")))
  .map((path) => relative(repo, path).split("\\").join("/"))
  .sort();

describe("naming the layer `public` used to stand for", () => {
  it("sees the source tree", () => {
    // An empty scan would make the checks below pass vacuously.
    expect(files.length).toBeGreaterThan(300);
    expect(naming).toContain("src/labels.ts");
  });

  it("no file names `public` as a label without a written reason", () => {
    const undecided = naming.filter((file) => !(file in MAY_NAME_PUBLIC));
    expect(
      undecided,
      "These files name PUBLIC_LABEL or the quoted word. Say which layer is meant (baseLabel, publishedLabel, " +
        "openLabels, memberLabels in src/labels.ts), or add the file to MAY_NAME_PUBLIC in this test with its reason."
    ).toEqual([]);
  });

  it("keeps the list to files that still name it, each with its reason", () => {
    const stale = Object.keys(MAY_NAME_PUBLIC).filter((file) => !naming.includes(file));
    expect(stale, "These files no longer name `public`; take them off the list.").toEqual([]);
    for (const [file, reason] of Object.entries(MAY_NAME_PUBLIC)) {
      expect(reason.trim().length, file).toBeGreaterThan(20);
    }
  });
});
