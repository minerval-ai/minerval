/**
 * Executors for the prize tools the Mathematics skill declares in
 * skills/mathematics/tools.json. Registered into the skill-tool registry at
 * startup; the placeholders below answer until the slice that owns this
 * module lands its executors.
 */
import type { SkillToolExecutor } from "./skill-tools.js";

export const PRIZE_TOOL_NAMES: readonly string[] = [];

export function registerPrizeTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  for (const name of PRIZE_TOOL_NAMES) {
    register(name, async () =>
      JSON.stringify({ success: false, message: `${name} is not available in this deployment yet.` })
    );
  }
}
