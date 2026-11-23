import { fetchApiVersion } from "../lib/api";
import { versionLine } from "../lib/version";

// The version this deployment runs (docs/releases.md, "Versions"), at the
// foot of every page: the API's, as it answers at GET /setup/version, and
// the web app's own where the two were not built from the same release. A
// person reporting a fault reports it against this.

export async function VersionLine() {
  const api = await fetchApiVersion();
  return <span title={api?.commit ? `Built from commit ${api.commit}` : undefined}>{versionLine(api?.version ?? null)}</span>;
}
