/**
 * The live price catalog: what the vendors charge for their models, read
 * from the public price lists every few hours and kept in one row of
 * platform_flags, so a price change or a new model reaches every running
 * process without a release.
 *
 * The rules for taking a listed price are price-sources.ts's: a price in
 * force changes only when both lists state the new one; a model with no
 * price is priced from either; a disagreement or an unbelievable price is
 * held and reported, and the price in force stays. The first refresh
 * starts from the committed snapshot (price-snapshot.ts), so the stored
 * catalog is always a whole one.
 *
 * Usage rows carry the cost worked out when each call was made, so a price
 * that changes here changes only the calls made after it.
 *
 * The row is the deployment's own bookkeeping, under no label: it names
 * models and prices, and nothing of any label's material.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { fetchPriceListings, type FetchedListings } from "../llm/price-fetch.js";
import { PRICE_SNAPSHOT } from "../llm/price-snapshot.js";
import {
  describePrice,
  implausible,
  reconcile,
  type Catalog,
  type HeldPrice,
  type PriceChange,
  type PriceSourceName,
} from "../llm/price-sources.js";
import { usePriceCatalog } from "../llm/pricing.js";

export const MODEL_PRICES_FLAG = "model_prices";

/** How many changes the row keeps, newest first. Enough to see a season's moves; older ones are in the usage rows' costs. */
const CHANGES_KEPT = 200;

export interface StoredModelPrices {
  catalog: Catalog;
  /** When the lists were last read, whether or not anything changed. */
  checked_at: string;
  /** Each list, and whether the last refresh could read it. */
  sources: Array<{ source: PriceSourceName; ok: boolean; error?: string }>;
  /** Prices that changed and models priced for the first time, newest first. */
  changes: Array<PriceChange & { at: string }>;
  /** What the last refresh did not take, and why. */
  held: HeldPrice[];
}

export interface ModelPriceRefresh {
  /** False when neither list could be read: nothing was written. */
  written: boolean;
  changes: PriceChange[];
  held: HeldPrice[];
  /** The held prices the refresh before did not hold, so a standing one is said once. */
  newlyHeld: HeldPrice[];
  failures: FetchedListings["failures"];
  models: number;
}

/**
 * The stored catalog with every price it holds checked again, or null for
 * no row or one that is not a catalog. A price that fails the check is left
 * out, and the snapshot's, if it has one, stands in for it.
 */
function readStored(value: unknown): StoredModelPrices | null {
  const v = value as Partial<StoredModelPrices> | null;
  if (!v || typeof v !== "object" || !v.catalog || typeof v.catalog !== "object") return null;
  const catalog: Catalog = { ...PRICE_SNAPSHOT };
  for (const [id, price] of Object.entries(v.catalog)) {
    if (price && typeof price === "object" && implausible(price) === null) catalog[id] = price;
  }
  return {
    catalog,
    checked_at: typeof v.checked_at === "string" ? v.checked_at : "",
    sources: Array.isArray(v.sources) ? v.sources : [],
    changes: Array.isArray(v.changes) ? v.changes : [],
    held: Array.isArray(v.held) ? v.held : [],
  };
}

/** What is stored, or null where no refresh has written a catalog yet. */
export async function storedModelPrices(): Promise<StoredModelPrices | null> {
  const [row] = await rawQuery<{ value: unknown }>(`SELECT value FROM platform_flags WHERE key = $1`, [
    MODEL_PRICES_FLAG,
  ]);
  return row ? readStored(row.value) : null;
}

/**
 * Meter at the stored catalog from now on, in this process. Where no
 * refresh has written one, the meter stays on the snapshot. Returns what
 * was loaded.
 */
export async function loadModelPrices(): Promise<StoredModelPrices | null> {
  const stored = await storedModelPrices();
  if (stored) usePriceCatalog(stored.catalog);
  return stored;
}

/**
 * Read both lists, take what the rules allow into the stored catalog, and
 * meter at it from now on. Safe from every task at once: the write holds a
 * lock and starts from the row as it stands, so two refreshes that read the
 * same lists record each change once.
 */
export async function refreshModelPrices(
  options: { fetchImpl?: typeof fetch; now?: Date } = {}
): Promise<ModelPriceRefresh> {
  const fetched = await fetchPriceListings(options.fetchImpl);
  if (fetched.listings.length === 0) {
    return { written: false, changes: [], held: [], newlyHeld: [], failures: fetched.failures, models: 0 };
  }
  const at = (options.now ?? new Date()).toISOString();
  const result = await withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`minerval:${MODEL_PRICES_FLAG}`]);
    const [row] = await tx.query<{ value: unknown }>(`SELECT value FROM platform_flags WHERE key = $1`, [
      MODEL_PRICES_FLAG,
    ]);
    const stored = row ? readStored(row.value) : null;
    const { catalog, changes, held } = reconcile(stored?.catalog ?? PRICE_SNAPSHOT, fetched.listings);
    const value: StoredModelPrices = {
      catalog,
      checked_at: at,
      sources: [
        ...fetched.listings.map((l) => ({ source: l.source, ok: true })),
        ...fetched.failures.map((f) => ({ source: f.source, ok: false, error: f.error })),
      ].sort((a, b) => a.source.localeCompare(b.source)),
      changes: [...changes.map((c) => ({ ...c, at })), ...(stored?.changes ?? [])].slice(0, CHANGES_KEPT),
      held,
    };
    await tx.query(
      `INSERT INTO platform_flags (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [MODEL_PRICES_FLAG, JSON.stringify(value)]
    );
    const before = new Set((stored?.held ?? []).map((h) => `${h.model}\n${h.reason}`));
    return { catalog, changes, held, newlyHeld: held.filter((h) => !before.has(`${h.model}\n${h.reason}`)) };
  });
  usePriceCatalog(result.catalog);
  return {
    written: true,
    changes: result.changes,
    held: result.held,
    newlyHeld: result.newlyHeld,
    failures: fetched.failures,
    models: Object.keys(result.catalog).length,
  };
}

/** A refresh in log lines: one for each change, one for each newly held price, one for each list not read. */
export function refreshLogLines(r: ModelPriceRefresh): Array<{ level: "info" | "warn"; text: string }> {
  const lines: Array<{ level: "info" | "warn"; text: string }> = [];
  for (const c of r.changes) {
    lines.push({
      level: "info",
      text: c.from
        ? `Model prices: ${c.model} changed from ${describePrice(c.from)} to ${describePrice(c.to)} (${c.sources.join(", ")})`
        : `Model prices: ${c.model} priced at ${describePrice(c.to)} (${c.sources.join(", ")})`,
    });
  }
  for (const h of r.newlyHeld) lines.push({ level: "warn", text: `Model prices: held ${h.model}: ${h.reason}` });
  for (const f of r.failures) lines.push({ level: "warn", text: `Model prices: could not read ${f.source}: ${f.error}` });
  return lines;
}
