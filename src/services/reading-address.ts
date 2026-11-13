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
 * Kept apart from reading-service.ts so that the recording tools, which
 * every Steward test loads, import nothing of the MCP client.
 */
import { rawQuery } from "../db/client.js";
import { isReadingAddress } from "../connections.js";

/** Whether a source row holds this address as a reading that was kept. */
export async function keptReadingExists(address: string): Promise<boolean> {
  const rows = await rawQuery(
    `SELECT 1 FROM sources s
      WHERE s.url = $1 AND EXISTS (SELECT 1 FROM connection_calls k WHERE k.source_id = s.id)`,
    [address]
  );
  return rows.length > 0;
}

/**
 * Why `url` cannot be cited as a source's address, or null when it can: an
 * http(s) URL, or the address of a reading that was kept. `notHttp` is what
 * the calling tool has always said of an address that is neither, so on a
 * deployment with no connections nothing a tool says changes.
 */
export async function sourceAddressProblem(url: string, notHttp: string): Promise<string | null> {
  if (/^https?:\/\//i.test(url)) return null;
  if (!isReadingAddress(url)) return notHttp;
  if (await keptReadingExists(url)) return null;
  return noKeptReading(url);
}

/** What a tool says of a reading address that no kept reading has. */
export function noKeptReading(address: string): string {
  return (
    `No kept reading has the address ${address}. A reading is cited by the address keep_reading ` +
    `returned for it, written exactly.`
  );
}
