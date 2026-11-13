/**
 * The deployment's own checks of its configuration, as the setup checklist
 * carries them (services/setup-checklist-service.ts).
 *
 * The checks are the preflight's: one check for each thing a deployment
 * needs before it starts, each passing, failing or not applicable, with a
 * sentence for whoever is installing. The preflight and the config file it
 * reads are a separate change that this line of work does not carry, so
 * here there is no report to give and the checklist says so. When the two
 * meet, `deploymentChecks` returns the preflight's report (`runPreflight`
 * in src/preflight.ts) and the types below are the preflight's own, which
 * they were copied from so that the checklist's shape does not change then.
 */

export type PreflightStatus = "pass" | "fail" | "not_applicable";

export interface PreflightCheckResult {
  name: string;
  status: PreflightStatus;
  /** Whether a fail here stops agent work. */
  blocking: boolean;
  /** One sentence for whoever is installing. */
  message: string;
}

export interface PreflightReport {
  /** Whether a label other than `public` is defined; null when the labels could not be read. */
  holds_private_material: boolean | null;
  /** No check failed. */
  ready: boolean;
  /** Whether agent work may start: "refused" when a blocking check failed. */
  agent_work: "allowed" | "refused";
  checks: PreflightCheckResult[];
}

/** The preflight's report, or null where this build has no preflight. */
export async function deploymentChecks(): Promise<PreflightReport | null> {
  return null;
}
