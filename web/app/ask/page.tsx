import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "../../auth";
import {
  accountApiConfigured,
  getAssistantHome,
  type AssistantHome,
} from "../../lib/account-api";
import { PageHead } from "@/components/PageHead";
import { AssistantConversation } from "./AssistantConversation";

export const metadata: Metadata = {
  title: "Ask · Minerval",
  description:
    "The Minerval Assistant: an agent that works for you with your account's tools, reading the graph, and proposing, contributing and commissioning work when you say so.",
};
export const dynamic = "force-dynamic";

const LEDE = (
  <>
    The Assistant works for you. It reads the graph, says what the graph holds and where its own
    view differs, and can propose, contribute and commission work with your account when you say
    so. It has every tool your own agent would have <Link href="/docs">over MCP</Link>, and
    nothing more. Its work is charged in owls at what it costs, as it runs; anything that spends
    owls on the graph or publishes under your name waits for you.
  </>
);

// A new conversation with the Assistant (#646). ?node= opens it from a node's
// page, which the Assistant is told; ?q= carries a question written on
// another page's ask box, not yet sent.
export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ node?: string; q?: string }>;
}) {
  const { node, q } = await searchParams;
  const session = await auth();

  let home: AssistantHome | null = null;
  if (session?.externalId && accountApiConfigured()) {
    home = await getAssistantHome(session.externalId).catch(() => null);
  }
  // Where signing in returns to: the question written on another page.
  const here = `/ask${
    node || q ? `?${new URLSearchParams({ ...(q ? { q } : {}), ...(node ? { node } : {}) })}` : ""
  }`;

  if (!session?.externalId || !home) {
    return (
      <div className="col account">
        <PageHead title="Ask" lede={LEDE} />
        {!session?.externalId ? (
          <p className="order-line">
            <Link href={`/signin?callbackUrl=${encodeURIComponent(here)}`}>Sign in</Link> to talk
            to the Assistant. Searching and reading the graph need no account.
          </p>
        ) : (
          <p className="order-line">The Assistant is not available right now.</p>
        )}
      </div>
    );
  }

  return (
    <AssistantConversation
      // A different question or node is a different new conversation.
      key={here}
      initial={null}
      models={home.models}
      balanceMicroUsd={home.balance_micro_usd}
      allowedAlways={home.allowed_kinds.always}
      kindLabels={home.allowed_kinds.labels}
      {...(node && /^[0-9a-f-]{36}$/i.test(node) ? { nodeId: node } : {})}
      {...(q ? { question: q.slice(0, 2000) } : {})}
    >
      <div className="ask-welcome">
        <h2>What do you want to know or do?</h2>
        <p>{LEDE}</p>
      </div>
    </AssistantConversation>
  );
}
