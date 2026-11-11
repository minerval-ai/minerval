"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The Ask section's sidebar: start a conversation, and get back to the
// conversations, pages and mandates the account already has.

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
}: {
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
    </section>
  );
}

export function AskSidebar({
  conversations,
  pages,
  mandates,
}: {
  conversations: SidebarItem[];
  pages: SidebarItem[];
  mandates: SidebarItem[];
}) {
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
        items={mandates}
        href={(id) => `/account/grants/${id}`}
        active={path}
        empty="You have funded no mandates."
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
