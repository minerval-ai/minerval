/**
 * The deployment's own checks of its configuration, as the setup checklist
 * carries them (services/setup-checklist-service.ts).
 *
 * The checks are the preflight's (src/preflight.ts): one check for each
 * thing a deployment needs before it starts, each passing, failing or not
 * applicable, with a sentence for whoever is installing. This is the one
 * place the checklist asks for them, so the checklist and the operator's
 * GET /setup/preflight cannot disagree.
 */
import { runPreflight, type PreflightReport } from "../preflight.js";

export type { PreflightCheckResult, PreflightReport, PreflightStatus } from "../preflight.js";

/** The preflight's report on the running deployment. */
export async function deploymentChecks(): Promise<PreflightReport> {
  return runPreflight();
}
