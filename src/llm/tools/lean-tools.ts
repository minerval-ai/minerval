/**
 * Executors for the lean tools the Mathematics skill declares in
 * skills/mathematics/tools.json. Registered into the skill-tool registry at
 * startup; the placeholders below answer until the slice that owns this
 * module lands its executors.
 */
import type { SkillToolExecutor } from "./skill-tools.js";

export const LEAN_TOOL_NAMES: readonly string[] = [];

export function registerLeanTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  for (const name of LEAN_TOOL_NAMES) {
    register(name, async () =>
      JSON.stringify({ success: false, message: `${name} is not available in this deployment yet.` })
    );
  }
}
