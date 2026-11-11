import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "../../auth";
import {
  accountApiConfigured,
  getAssistantHome,
  type AssistantHome,
} from "../../lib/account-api";
import { PageHead } from "@/components/PageHead";
import { OwlMark } from "../../components/OwlMark";
import { AssistantConversation } from "./AssistantConversation";

export const metadata: Metadata = {
  title: "Ask · Minerval",
  description:
    "The Minerval Assistant: an agent that works for you with your account's tools, reading the graph, and proposing, contributing and commissioning work when you say so.",
};
export const dynamic = "force-dynamic";

function owls(microUsd: number): string {
  return Number((microUsd / 1_000_000).toFixed(2)).toString();
}

// The Assistant (#646): an agent that works for the signed-in user. ?node=
// opens the conversation from a node's page, which the Assistant is told.
export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ node?: string }>;
}) {
  const { node } = await searchParams;
  const session = await auth();

  let home: AssistantHome | null = null;
  if (session?.externalId && accountApiConfigured()) {
    try {
      home = await getAssistantHome(session.externalId);
    } catch {
      // rendered below as the Assistant being unavailable
    }
  }

  return (
    <div className="col account">
      <PageHead
        title="Ask"
        lede={
          <>
            The Assistant works for you. It reads the graph, says what the graph holds and
            where its own view differs, and can propose, contribute and commission work with
            your account when you say so. It has every tool your own agent would have{" "}
            <Link href="/docs">over MCP</Link>, and nothing more. Its work is charged in owls
            at what it costs, as it runs; anything that spends owls on the graph or publishes
            under your name waits for you.
          </>
        }
      />
      {!session?.externalId ? (
        <p className="order-line">
          <Link href="/signin?callbackUrl=/ask">Sign in</Link> to talk to the Assistant.
          Searching and reading the graph need no account.
        </p>
      ) : !home ? (
        <p className="order-line">The Assistant is not available right now.</p>
      ) : (
        <>
          <AssistantConversation
            initial={null}
            models={home.models}
            balanceMicroUsd={home.balance_micro_usd}
            allowedAlways={home.allowed_kinds.always}
            kindLabels={home.allowed_kinds.labels}
            {...(node && /^[0-9a-f-]{36}$/i.test(node) ? { nodeId: node } : {})}
          />
          {home.conversations.length > 0 && (
            <>
              <h2>Your conversations</h2>
              <table className="account-table">
                <thead>
                  <tr>
                    <th>Conversation</th>
                    <th>Cost</th>
                    <th>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {home.conversations.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/ask/c/${c.id}`}>{c.title}</Link>
                        {c.turn_state === "replying" && <span className="tag"> working</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <OwlMark size={13} className="owl-mark" />
                        {owls(c.spent_micro_usd)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{c.updated_at.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
