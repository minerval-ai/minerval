import type { ReactNode } from "react";
import { auth } from "../../auth";
import {
  accountApiConfigured,
  getAssistantHome,
  listGrantConversations,
  listGrants,
  listPages,
} from "../../lib/account-api";
import { AskSidebar, type SidebarItem } from "./AskSidebar";

export const dynamic = "force-dynamic";

// The Ask section is laid out as a chat, not as an article: a sidebar of what
// the account already has, the conversation or page in the middle, and (in a
// conversation) a panel on the right for a cited node or a saved page. The
// shell fills the window under the masthead, so the composer is always in
// view. Signed out, there is nothing to list and the page stands alone.
export default async function AskLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.externalId || !accountApiConfigured()) return <>{children}</>;

  const externalId = session.externalId;
  const [home, pages, grants, grantConversations] = await Promise.all([
    getAssistantHome(externalId).catch(() => null),
    listPages(externalId).catch(() => []),
    listGrants(externalId).catch(() => []),
    listGrantConversations(externalId).catch(() => []),
  ]);
  // A conversation with a Grantmaker that has not been funded is a mandate
  // in draft; once funded it is listed as the mandate.
  const drafts: SidebarItem[] = grantConversations
    .filter((c) => !c.grant_id && (c.status === "active" || c.status === "proposed"))
    .map((c) => ({
      id: c.id,
      title: c.title ?? "A mandate, in draft",
      note: c.turn.state === "replying" ? "working" : c.status === "proposed" ? "proposed" : "draft",
    }));
  const conversations: SidebarItem[] = (home?.conversations ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    ...(c.turn_state === "replying" ? { note: "working" } : {}),
  }));

  return (
    <div className="ask-shell">
      <AskSidebar
        conversations={conversations}
        pages={pages.map((p) => ({ id: p.id, title: p.title }))}
        mandates={grants.map((g) => ({
          id: g.id,
          title: g.name,
          note:
            g.status === "pending_approval"
              ? "to approve"
              : g.status === "active" && g.budget_status === "paused_budget"
                ? "budget spent"
                : g.status.replace(/_/g, " "),
        }))}
        drafts={drafts}
      />
      <div className="ask-main">{children}</div>
    </div>
  );
}
