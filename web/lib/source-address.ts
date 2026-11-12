// Where a source's address leads when it is shown as a link.
//
// Most sources are documents at a web address, and the link is the address.
// A reading kept through a connection (a members-only deployment only) has
// an address of its own kind, reading:<connection>/<reading>, which is how
// agents cite it and which no browser can open. Its link leads to the
// source's page instead, where the reading can be read, or is left out where
// the page does not know which source it is.
//
// A web address is returned exactly as given, so nothing changes for a
// source that has one.

const READING_SCHEME = "reading:";

export function isReadingAddress(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith(READING_SCHEME);
}

/** The address to link a source by, or null when there is nothing to link to. */
export function sourceHref(url: string | null | undefined, sourceId?: string | null): string | null {
  if (!url) return null;
  if (!isReadingAddress(url)) return url;
  return sourceId ? `/sources/${encodeURIComponent(sourceId)}` : null;
}
