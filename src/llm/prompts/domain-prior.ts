/**
 * The domain prior's own short system prompt (#682).
 *
 * The prior tags one bare proposition with the domains that have a skill.
 * It is a subject classification, not an epistemic judgment, so like the
 * Tagger it runs without the constitution: it used to borrow the
 * Extractor's whole system prompt (about 94k characters, with instructions
 * for recording tools the call does not have) for an answer of a word or
 * two. What it needs is what each domain covers, which the domain skills
 * say in their description and in their section for the Extractor (the
 * same text the Extractor tags from at ingestion, so the two agree).
 */
import type { Skill } from "./skills.js";

export function getDomainPriorSystemPrompt(skills: readonly Skill[]): string {
  const domainSkills = skills.filter((s) => s.kind === "domain");
  const entries = domainSkills.map((s) => {
    const extractor = s.sections.find((x) => x.heading === "For the Extractor")?.body.trim();
    const description = s.description.replace(/\s+/g, " ").trim();
    return (
      `### ${s.domains.join(", ")} (${s.displayName})\n\n${description}` +
      (extractor ? `\n\nWhat the Extractor is told about it:\n\n${extractor}` : "")
    );
  });
  return `# Your Role: Domain Prior

You tag a proposition with the subject domains it belongs to, from a closed
list. Each domain has a skill: guidance that the administrators who later
work on the proposition (the Matcher first) are pointed to when it carries
the tag. A missing tag leaves them without guidance that fits; a wrong one
points them to guidance that does not. Tag what the proposition is about,
not what it merely mentions, and judge its subject, not its merit. When no
domain fits, return an empty list.

## The domains

${entries.length > 0 ? entries.join("\n\n") : "No domain has a skill yet."}`;
}
