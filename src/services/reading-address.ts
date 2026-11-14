/**
 * Citing a kept reading (src/connections.ts, services/reading-service.ts).
 *
 * The tools that record where a claim, a figure, a question or an argument
 * appears take the source's address and find or create the source by it.
 * For a document that address is its http(s) URL. A reading kept from a
 * connection has an address of its own (`reading:<prefix>/<id>`), which
 * keep_reading returns, and it is cited through the same tools by that
 * address.
 *
 * The difference is that a URL not yet in the graph becomes a new source,
 * and a reading address never does: a reading exists only as the deployment
 * stored it, so an address no kept reading has is refused and not created.
 *
 * A source kept from a file set is cited the same way (src/file-sets.ts):
 * an analysis by the address keep_analysis returned (`analysis:<id>`), and
 * a file or a passage of one by the address keep_file returned
 * (`fileset:<set>/<path>`). Those are only ever found, too.
 *
 * Kept apart from reading-service.ts so that the recording tools, which
 * every Steward test loads, import nothing of the MCP client.
 */
import { rawQuery } from "../db/client.js";
import { isReadingAddress } from "../connections.js";
import { isAnalysisAddress, isKeptFileAddress } from "../file-sets.js";

/** Whether a source row holds this address as a reading that was kept. */
export async function keptReadingExists(address: string): Promise<boolean> {
  const rows = await rawQuery(
    `SELECT 1 FROM sources s
      WHERE s.url = $1 AND EXISTS (SELECT 1 FROM connection_calls k WHERE k.source_id = s.id)`,
    [address]
  );
  return rows.length > 0;
}

/** Whether a source row holds this address as an analysis or a file kept from a file set. */
async function keptFromFileSetExists(address: string): Promise<boolean> {
  const rows = await rawQuery(
    isAnalysisAddress(address)
      ? `SELECT 1 FROM sources s
          WHERE s.url = $1 AND EXISTS (SELECT 1 FROM sandbox_calls k WHERE k.source_id = s.id)`
      : `SELECT 1 FROM sources s
          WHERE s.url = $1 AND EXISTS (SELECT 1 FROM file_set_keeps k WHERE k.source_id = s.id)`,
    [address]
  );
  return rows.length > 0;
}

/**
 * Why `url` cannot be cited as a source's address, or null when it can: an
 * http(s) URL, or the address of something that was kept (a reading, an
 * analysis, a file of a set). `notHttp` is what the calling tool has always
 * said of an address that is none of these, so on a deployment with no
 * connections and no file sets nothing a tool says changes.
 */
export async function sourceAddressProblem(url: string, notHttp: string): Promise<string | null> {
  if (/^https?:\/\//i.test(url)) return null;
  if (isReadingAddress(url)) return (await keptReadingExists(url)) ? null : noKeptReading(url);
  if (isAnalysisAddress(url) || isKeptFileAddress(url)) {
    return (await keptFromFileSetExists(url)) ? null : noKeptSource(url);
  }
  return notHttp;
}

/** What a tool says of a reading address that no kept reading has. */
export function noKeptReading(address: string): string {
  return (
    `No kept reading has the address ${address}. A reading is cited by the address keep_reading ` +
    `returned for it, written exactly.`
  );
}

/**
 * What a tool says of an address of a kind that is only ever kept, when no
 * source has it; null for any other address, which may be a document's.
 */
export function noKeptSource(address: string): string | null {
  if (isReadingAddress(address)) return noKeptReading(address);
  if (isAnalysisAddress(address)) {
    return (
      `No kept analysis has the address ${address}. An analysis is cited by the address keep_analysis ` +
      `returned for it, written exactly.`
    );
  }
  if (isKeptFileAddress(address)) {
    return (
      `No kept file has the address ${address}. A file of a set is cited by the address keep_file ` +
      `returned for it, written exactly.`
    );
  }
  return null;
}
