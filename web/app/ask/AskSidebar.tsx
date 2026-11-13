"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The Ask section's sidebar: start a conversation, and get back to the
// conversations, pages and mandates the account already has. A mandate
// opens the conversation with its Grantmaker, a different agent from the
// Assistant, which is why it is under its own heading.

export interface SidebarItem {
  id: string;
  title: string;
  /** Shown after the title, small: "working", a mandate's status. */
  note?: string;
}

function Section({
  title,
  items,
  href,
  active,
  empty,
  more,
}: {
  /** A link under the list: the way to start one, or to see them all. */
  more?: { href: string; label: string };
  title: string;
  items: SidebarItem[];
  href: (id: string) => string;
  active: string;
  empty: string;
}) {
  return (
    <section>
      <h2 className="sc">{title}</h2>
      {items.length === 0 ? (
        <p className="ask-side-empty">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={href(item.id)}
                className={active === href(item.id) ? "active" : undefined}
                title={item.title}
              >
                <span>{item.title}</span>
                {item.note && <em>{item.note}</em>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more && (
        <p className="ask-side-more">
          <Link href={more.href}>{more.label}</Link>
        </p>
      )}
    </section>
  );
}

export function AskSidebar({
  conversations,
  pages,
  mandates,
  drafts,
}: {
  conversations: SidebarItem[];
  pages: SidebarItem[];
  /** The mandates the user funds: each opens the conversation with its Grantmaker. */
  mandates: SidebarItem[];
  /** Conversations with a Grantmaker not yet funded. */
  drafts: SidebarItem[];
}) {
  // A mandate and a draft are both a conversation with a Grantmaker; the
  // list holds both, drafts first, each at its own address.
  const withGrantmakers = [...drafts.map((d) => ({ ...d, id: `c/${d.id}` })), ...mandates];
  const path = usePathname();
  const body = (
    <>
      <Link href="/ask" className="ask-side-new">
        New conversation
      </Link>
      <Section
        title="Conversations"
        items={conversations}
        href={(id) => `/ask/c/${id}`}
        active={path}
        empty="None yet."
      />
      <Section
        title="Pages"
        items={pages}
        href={(id) => `/ask/pages/${id}`}
        active={path}
        empty="Pages the Assistant saves for you appear here."
      />
      <Section
        title="Mandates"
        items={withGrantmakers}
        href={(id) => `/ask/mandates/${id}`}
        active={path}
        empty="You have started no mandates."
        more={{ href: "/ask/mandates/new", label: "Start a mandate" }}
      />
    </>
  );
  return (
    <>
      <nav className="ask-side" aria-label="Conversations, pages and mandates">
        {body}
      </nav>
      {/* on a narrow screen the same list folds away above the chat */}
      <details className="ask-side-fold">
        <summary>Conversations, pages and mandates</summary>
        <nav aria-label="Conversations, pages and mandates">{body}</nav>
      </details>
    </>
  );
}
