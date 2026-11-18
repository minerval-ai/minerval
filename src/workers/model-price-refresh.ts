/**
 * The price refresh: every MODEL_PRICE_REFRESH_HOURS, read the public price
 * lists into the stored catalog and meter at it (services/model-price-service.ts).
 *
 * It ticks once at start, so a process meters at the stored catalog from
 * its first minutes rather than the snapshot it shipped with. Where the
 * refresh is off (0 hours), that first tick still loads what a refresh
 * stored before, and nothing more happens. A refresh that cannot read
 * either list writes nothing, and the process loads what is stored, so a
 * process whose own network cannot reach the lists still meters at what
 * another process read.
 *
 * Every task may run it: the write holds a lock and starts from the row as
 * it stands.
 */
import { loadConfig } from "../config.js";
import { loadModelPrices, refreshLogLines, refreshModelPrices } from "../services/model-price-service.js";

export interface ModelPriceTickResult {
  /** True when the lists were read and the catalog written. */
  refreshed: boolean;
  lines: ReturnType<typeof refreshLogLines>;
}

export async function modelPriceTick(refresh: boolean): Promise<ModelPriceTickResult> {
  if (refresh) {
    const result = await refreshModelPrices();
    if (result.written) return { refreshed: true, lines: refreshLogLines(result) };
    await loadModelPrices();
    return { refreshed: false, lines: refreshLogLines(result) };
  }
  await loadModelPrices();
  return { refreshed: false, lines: [] };
}

export function startModelPriceRefresh(options: {
  logger: {
    info: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}): { stop: () => void } {
  const hours = loadConfig().modelPriceRefreshHours;
  let busy = false;

  const tick = async (refresh: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const { lines } = await modelPriceTick(refresh);
      for (const line of lines) {
        if (line.level === "warn") (options.logger.warn ?? options.logger.info)(line.text);
        else options.logger.info(line.text);
      }
    } catch (err) {
      options.logger.error("Model price refresh failed:", err);
    } finally {
      busy = false;
    }
  };

  void tick(hours > 0);
  if (!(hours > 0)) return { stop: () => {} };
  const timer = setInterval(() => void tick(true), hours * 3_600_000);
  return { stop: () => clearInterval(timer) };
}
