/**
 * Human-friendly display names for the raw model ids recorded on assessments
 * (#294). Mirrors the id inventory in src/llm/models.ts — the web app cannot
 * import server code, so keep the two lists in sync when a default changes.
 *
 * Unknown ids fall back to a best-effort prettified form of the id itself
 * (never nothing): a verdict should always name its assessor, even one this
 * mapping hasn't caught up with yet.
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
};

/**
 * Map a raw model id to its display name. Ids not in the table are prettified
 * generically ("claude-sonnet-4-6" → "Claude Sonnet 4.6") when they follow the
 * Anthropic claude-<family>-<version> shape, else returned verbatim.
 */
export function modelDisplayName(id: string): string {
  const known = MODEL_DISPLAY_NAMES[id];
  if (known) return known;

  // Generic prettifier for claude-<family>-<major>[-<minor>][-<yyyymmdd>] ids.
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
    return `Claude ${family} ${version}`;
  }

  // Anything else: show the raw id rather than nothing.
  return id;
}
