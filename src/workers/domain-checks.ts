/**
 * The daily check of organizations' domains (docs/organizations.md, "A
 * verified domain"): every domain checked once before is looked up again
 * when its last check is a day old. A domain whose record has gone is shown
 * as unconfirmed for seven days, then not at all; one that comes back is
 * shown again. Each check is a row's own update, so every task may run it.
 */
import { checkDueDomains } from "../services/organization-domains.js";

const TICK_MS = 60 * 60 * 1000;

export function startDomainChecks(options: { logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void } }): {
  stop: () => void;
} {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const checked = await checkDueDomains();
      if (checked > 0) options.logger.info(`Domains: checked ${checked} organization domain${checked === 1 ? "" : "s"} again`);
    } catch (err) {
      options.logger.error("Domains: the daily check failed:", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  return { stop: () => clearInterval(timer) };
}
