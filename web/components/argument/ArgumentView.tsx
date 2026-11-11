import Link from "next/link";
import type { ArgumentPage, ArgumentInstanceItem, ArgumentEvaluationEntry } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { ArgumentText } from "@/components/ArgumentText";
import { StatusBadge, Unassessed } from "@/components/Assessment";
import { ArgumentVerdictTag, DecisiveTag, StanceTag } from "@/components/DecompositionTree";
import { Term } from "@/components/Term";
import { DEFINED_IN, premiseSummary } from "@/lib/ontology";
import type { Stance } from "@/lib/types";
import { fmtDate } from "@/lib/format";
import styles from "./argument.module.css";
import { PageHead } from "@/components/PageHead";

// How a passage stands toward the argument (§4, §7). A mention is
// provenance and counts in neither camp.
const STANCE_WORDS: Record<string, string> = {
  advances: "makes it",
  criticizes: "criticizes it",
  mentions: "mentions it",
};

// How well a passage states the argument: a fact about the passage, never
// about the argument (§4).
const READING_WORDS: Record<string, { label: string; gloss: string }> = {
  full: { label: "states it fully", gloss: "The passage states the inference with what it needs." },
  premise_unstated: {
    label: "leaves a premise unstated",
    gloss: "The passage relies on a premise the inference needs without saying it.",
  },
  strawman: {
    label: "states a weaker version",
    gloss: "The passage states the argument in a weaker form than it has, usually to attack it.",
  },
};

function isStance(s: string): s is Stance {
  return s === "for" || s === "against" || s === "neutral";
}

/**
 * An argument's own page (#541). An argument is canonical and belongs to no
 * one who makes it (§7), so the page leads with the inference: its written
 * form, the rating worded conditionally beside whether the premises hold,
 * and the premises themselves. Where sources make, criticize or mention it
 * comes after, as provenance, in no order of precedence and with no count
 * presented as a measure of the argument's standing.
 */
export function ArgumentView({ page, source }: { page: ArgumentPage; source: DataSource }) {
  const a = page.argument;
  const conclusion = a.conclusion;
  const premiseCounts = premiseSummary(page.premises);
  const retired = a.retired;

  return (
    <div className="col">
      <PageHead
        back={{ href: `/claims/${conclusion.id}`, label: "the claim it bears on" }}
        kicker={
          <Term gloss="A line of reasoning from premises to a conclusion. Like a claim, it belongs to no one who makes it." href={DEFINED_IN.argument}>
            argument
          </Term>
        }
        tags={
          source === "fixture" && (
            <span className="tag" title="The API is not connected; showing a design fixture.">
              fixture data
            </span>
          )
        }
        title={a.name ?? "Unnamed argument"}
      />

      <div className={styles.head}>
        {isStance(a.stance) && a.stance !== "neutral" && <StanceTag stance={a.stance} />}
        <span className={styles.conclusion}>
          {a.stance === "for" || a.stance === "against" ? "" : "on "}
          <Link href={`/claims/${conclusion.id}`}>{conclusion.text ?? "the claim"}</Link>
        </span>
      </div>

      {a.merged_into && (
        <p className={styles.notice}>
          This argument was found to be the same argument as another and merged into it. Its record
          is kept here as history; its instances and premises are on{" "}
          <Link href={`/arguments/${a.merged_into}`}>the argument it became</Link>.
        </p>
      )}
      {retired && !a.merged_into && (
        <p className={styles.notice}>
          Retired {fmtDate(retired.at)}. It is no longer among the arguments on the claim&apos;s page.
          {retired.reason && <> Reason: {retired.reason}</>}
        </p>
      )}

      {a.shows && (
        <p className={styles.shows}>
          <span className="sc">shows</span> {a.shows.text}
        </p>
      )}

      <section className={styles.section}>
        <h2 className="sc">The argument</h2>
        {a.has_written_form ? (
          <p className="argform">
            <ArgumentText content={a.written_form} />
          </p>
        ) : (
          <p className={styles.muted}>Its written form has not been written yet.</p>
        )}
      </section>

      <section className={styles.section}>
        <h2 className="sc">Does it work?</h2>
        {page.evaluation ? (
          <>
            <dl className="argcheck">
              <dt>Does it follow?</dt>
              <dd>
                <ArgumentVerdictTag verdict={page.evaluation.verdict} />
                <DecisiveTag decisive={page.evaluation.decisive} />
              </dd>
              {premiseCounts.length > 0 && (
                <>
                  <dt>Do the premises hold?</dt>
                  <dd>
                    {premiseCounts.map((p) => (
                      <span className={`premise-count ${p.cls}`} key={p.key}>{p.label}</span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
            <p className="argeval">
              <ArgumentText content={page.evaluation.content} />
            </p>
            {page.evaluation.stale && (
              <p className={styles.muted}>
                This rating was made under an earlier assessment of the claim and has not been
                reviewed since.
              </p>
            )}
          </>
        ) : (
          <p className={styles.muted}>Not yet evaluated.</p>
        )}
      </section>

      <section className={styles.section}>
        <h2 className="sc">Premises</h2>
        {page.premises.length === 0 ? (
          <p className={styles.muted}>No premises are attached; any it relies on are stated in its written form.</p>
        ) : (
          <ul className={styles.premises}>
            {page.premises.map((p) => (
              <li key={p.id}>
                <span className={styles.badge}>
                  {p.assessment_status ? <StatusBadge status={p.assessment_status} /> : <Unassessed />}
                </span>
                <Link href={`/claims/${p.id}`}>{p.text}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2 className="sc">Where it is made</h2>
        <p className={styles.muted}>
          Passages where sources make, criticize or mention this argument. They record where it
          appears, not how strong it is, and none has precedence over another.
        </p>
        {page.instances.length === 0 ? (
          <p className={styles.muted}>No source is recorded as making it.</p>
        ) : (
          <ul className={styles.instances}>
            {page.instances.map((i) => (
              <Instance key={i.id} item={i} />
            ))}
          </ul>
        )}
        {page.instances_total > page.instances.length && (
          <p className={styles.muted}>Further passages are recorded beyond those shown here.</p>
        )}
      </section>

      {page.evaluation_history.length > 0 && (
        <section className={styles.section}>
          <h2 className="sc">Earlier ratings</h2>
          <ul className={styles.history}>
            {page.evaluation_history.map((e, idx) => (
              <HistoryEntry key={idx} entry={e} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Instance({ item }: { item: ArgumentInstanceItem }) {
  const reading = item.reading ? READING_WORDS[item.reading] : null;
  const where = [item.speaker, item.publication, item.source_date].filter(Boolean).join(" · ");
  return (
    <li className={styles.instance}>
      <div className={styles.instanceHead}>
        <Link href={`/sources/${item.source.id}`}>{item.source.title ?? item.source.url ?? "a source"}</Link>
        <span className={styles.instanceStance}>{STANCE_WORDS[item.stance] ?? item.stance}</span>
        {reading && (
          <Term gloss={reading.gloss} href="/docs/constitution#4-instances" className={styles.reading}>
            {reading.label}
          </Term>
        )}
      </div>
      <blockquote className={styles.quote}>{item.verbatim_text}</blockquote>
      {item.stated_shows && <p className={styles.muted}>The source says it shows: {item.stated_shows.text}</p>}
      {where && <p className={styles.muted}>{where}</p>}
    </li>
  );
}

function HistoryEntry({ entry }: { entry: ArgumentEvaluationEntry }) {
  return (
    <li className={styles.historyEntry}>
      <div className={styles.instanceHead}>
        <span className={styles.muted}>{fmtDate(entry.created_at)}</span>
        <ArgumentVerdictTag verdict={entry.verdict} />
        <DecisiveTag decisive={entry.decisive} />
      </div>
      <p className={styles.historyText}>
        <ArgumentText content={entry.content} />
      </p>
    </li>
  );
}
