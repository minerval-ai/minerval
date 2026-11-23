// The version of Minerval this web app is (docs/releases.md, "Versions"):
// the one its package.json states, which `npm run version:set` writes in
// every part at once, and the commit the image was built from where the
// build said. A build of main carries `-dev` and takes the commit.

import pkg from "../package.json";

const commit = (process.env.MINERVAL_COMMIT ?? "").trim() || null;

/** `0.5.0` for a release, `0.6.0-dev.1a2b3c4` for a build of main. */
export const WEB_VERSION: string =
  pkg.version.endsWith("-dev") && commit ? `${pkg.version}.${commit.slice(0, 7)}` : pkg.version;

export const WEB_COMMIT: string | null = commit;

/** The header the web app names its version in on its requests to the API. */
export const WEB_VERSION_HEADER = "x-minerval-web-version";

/**
 * What the footer says: the version, and both where the API and the web app
 * were not built from the same one.
 */
export function versionLine(api: string | null, web: string = WEB_VERSION): string {
  if (!api || api === web) return `Minerval ${web}`;
  return `Minerval ${api} (API) · ${web} (web app)`;
}
