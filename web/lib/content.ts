import { readFileSync } from "fs";
import { resolve } from "path";

// Verbatim project documents and real agent prompts, vendored into web/content/
// by scripts/sync-frontend-content.ts. Read at the server.
const CONTENT = resolve(process.cwd(), "content");

export interface AgentMeta {
  key: string;
  name: string;
  stage: number;
  group: "processing" | "governance";
  tagline: string;
  invokedWhen: string;
  model: string;
  hasConstitution: boolean;
  roleChars: number;
  fullChars: number;
}

export function getDoc(
  name: "constitution" | "architecture" | "policies" | "rewards-policy" | "contributor-terms"
): string {
  return readFileSync(resolve(CONTENT, `${name}.md`), "utf-8");
}

export function getAgentIndex(): AgentMeta[] {
  const raw = readFileSync(resolve(CONTENT, "agents/index.json"), "utf-8");
  return (JSON.parse(raw) as AgentMeta[]).sort((a, b) => a.stage - b.stage);
}

export function getAgent(key: string): AgentMeta | undefined {
  return getAgentIndex().find((a) => a.key === key);
}

export function getAgentPrompt(key: string, which: "role" | "full"): string {
  return readFileSync(resolve(CONTENT, `agents/${key}.${which}.md`), "utf-8");
}
