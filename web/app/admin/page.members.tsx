import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { AdminNav, NeedsPermission, can, viewer } from "@/components/admin/access";
import { AccountApiError } from "@/lib/account-api";
import { fetchSetupChecklist, type PreflightCheck, type SetupChecklist } from "@/lib/admin-api";
import {
  ITEM_STATE_WORDS,
  checklistItems,
  itemsNeedingSomeone,
  preflightTitle,
  preflightTodo,
  type ChecklistItem,
} from "@/lib/admin-words";

export const metadata: Metadata = { title: "Administration · Minerval" };
export const dynamic = "force-dynamic";

// The administrators' landing page: the setup checklist on a deployment's
// first day and its home on every day after. It is one page because it
// asks one question either way: what does the deployment need from a person
// now? Every line is read from the deployment (GET /setup/checklist), and
// nothing is ticked by hand.

const TITLE = "Setting up and running this deployment";

export default async function AdministrationPage() {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Administration" permission="administer" />;

  let checklist: SetupChecklist;
  try {
    checklist = await fetchSetupChecklist(who.externalId);
  } catch (err) {
    return (
      <div className="col">
        <PageHead kicker="Administration" title={TITLE} />
        <AdminNav current="/admin" />
        <p>
          The deployment could not be read just now
          {err instanceof AccountApiError ? <>: <em>{err.message}</em></> : "."} Nothing is shown
          in its place. Try again in a moment.
        </p>
      </div>
    );
  }

  const items = checklistItems(checklist);
  const needing = itemsNeedingSomeone(items);

  return (
    <div className="admin-page">
      <PageHead
        kicker="Administration"
        title={TITLE}
        lede="Each line below is read from the deployment itself. Nothing is ticked by hand: a thing is in place when the system can see that it is, and each line that is not says what to do next and who can do it."
      />
      <AdminNav current="/admin" />

      <section className="acct-section admin-first">
        <div className="acct-head">
          <h2>What needs someone now</h2>
        </div>
        {needing.length === 0 ? (
          <p className="account-empty">Nothing needs anyone right now. Everything below is in place.</p>
        ) : (
          <ol className="admin-next">
            {needing.map((item) => (
              <li key={item.key}>
                <a href={`#${item.key}`}>{item.title}</a>
                {item.next && <span>{item.next}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="acct-section">
        <div className="acct-head">
          <h2>Everything, as it stands</h2>
        </div>
        <div className="admin-items">
          {items.map((item) => (
            <Item key={item.key} item={item}>
              {item.key === "checks" && <Checks checks={checklist.preflight.checks} />}
            </Item>
          ))}
        </div>
      </section>
    </div>
  );
}

function Item({ item, children }: { item: ChecklistItem; children?: React.ReactNode }) {
  return (
    <article className="admin-item" id={item.key}>
      <div className={`admin-state admin-state-${item.state}`}>{ITEM_STATE_WORDS[item.state]}</div>
      <div className="admin-item-body">
        <h3>{item.title}</h3>
        {item.facts.map((fact) => (
          <p key={fact}>{fact}</p>
        ))}
        {item.next && (
          <p className="admin-item-next">
            <span className="sc">Next</span> {item.next}
          </p>
        )}
        {children}
        {item.href && (
          <p className="admin-item-link">
            <Link href={item.href}>{item.link} →</Link>
          </p>
        )}
      </div>
    </article>
  );
}

// The preflight's checks: the ones that failed in full, each with the
// check's own sentence and what to do about it, and the rest folded away.
function Checks({ checks }: { checks: PreflightCheck[] }) {
  const failed = checks.filter((c) => c.status === "fail");
  const rest = checks.filter((c) => c.status !== "fail");
  return (
    <>
      {failed.length > 0 && (
        <ul className="admin-checks">
          {failed.map((check) => (
            <CheckLine key={check.name} check={check} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <details className="acct-asTable">
          <summary>
            The {rest.length} check{rest.length === 1 ? "" : "s"} that did not fail
          </summary>
          <ul className="admin-checks">
            {rest.map((check) => (
              <CheckLine key={check.name} check={check} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

const CHECK_STATUS_WORDS: Record<PreflightCheck["status"], string> = {
  pass: "Passes",
  fail: "Fails",
  not_applicable: "Does not apply",
};

function CheckLine({ check }: { check: PreflightCheck }) {
  const todo = preflightTodo(check);
  return (
    <li>
      <strong>{preflightTitle(check)}</strong>{" "}
      <span className="acct-detail">
        {CHECK_STATUS_WORDS[check.status]}
        {check.status === "fail" && check.blocking && " · agent work waits on this"}
      </span>
      <br />
      {check.message}
      {todo && (
        <>
          <br />
          <span className="admin-item-next">
            <span className="sc">What to do</span> {todo}
          </span>
        </>
      )}
    </li>
  );
}
