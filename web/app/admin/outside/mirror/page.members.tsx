import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Banner,
  Empty,
  Pill,
  Section,
  Stat,
  Stats,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  age,
  plural,
  shortWhen,
  type Tone,
} from "@/components/work/ui";
import { OWNER_WORDS, type Owner } from "@/lib/health";
import { british, fetchMirrorSetup, type MirrorSetup, type MirrorSetupCheck } from "@/lib/outside-api";
import {
  acceptMirrorKeyAction,
  checkMirrorAction,
  followMirrorAction,
  pauseMirrorAction,
  readMirrorKeysAction,
} from "../actions";
import { Note, tryRead } from "../parts";

export const metadata: Metadata = { title: "Mirror · Minerval" };
export const dynamic = "force-dynamic";

// Following the public graph (docs/organizations.md, "The mirror"; GET
// /mirror/setup): what this deployment's mirror of the public graph is as of,
// what must hold before it follows, the feed's key and who accepted it, the
// batches applied, and what stopped the last one with who fixes it. Every
// member reads it; administrators start, pause and check it, and accept the
// feed's key, from their session. Where the operator's settings say what is
// followed, the page says so and offers none of that.

const CHECK_TITLE: Record<MirrorSetupCheck["key"], string> = {
  connected: "Connected, with read_feed",
  feed_key: "The feed's key accepted",
  embedding: "The same embedding model",
  shape: "The same table shape",
};

const CHECK_PILL: Record<MirrorSetupCheck["status"], { tone: Tone; text: string }> = {
  pass: { tone: "ok", text: "Holds" },
  fail: { tone: "bad", text: "Does not hold" },
  unknown: { tone: "neu", text: "Not said" },
};

/** What each refusal means, in a line, beside the message the deployment recorded. */
const REFUSAL_WORDS: Record<string, string> = {
  unknown_key: "The batch is signed with a key nobody here has accepted.",
  schema_newer: "The public graph runs a newer release; this deployment must be upgraded.",
  shape_differs: "The batch was cut in a table shape this release does not write.",
  embedding_differs: "The batch's vectors come from another embedding model.",
  row_refused: "A row in the batch could not be written here.",
  id_collision: "A row in the batch has the id of one this deployment made.",
};

function OwnerPill({ owner }: { owner: Owner }) {
  return (
    <Pill tone={owner === "admin" ? "info" : owner === "organization" ? "warn" : "neu"} title={OWNER_WORDS[owner].title}>
      {OWNER_WORDS[owner].name}
    </Pill>
  );
}

const STATE_PILL: Record<MirrorSetup["state"], { tone: Tone; text: string }> = {
  following: { tone: "ok", text: "Following" },
  paused: { tone: "warn", text: "Paused" },
  not_started: { tone: "neu", text: "Not started" },
};

export default async function MirrorPage() {
  const who = await viewer();
  if (!who) return null;
  const mayAdminister = can(who, "administer");
  const { data: m, problem } = await tryRead(() => fetchMirrorSetup(who.externalId), "The mirror could not be read");

  if (!m) {
    return (
      <WorkPage>
        <WorkHead title="Mirror" />
        <Banner tone="bad">{problem}</Banner>
      </WorkPage>
    );
  }

  const bySettings = m.source.set_by === "settings";
  const status = m.status;
  const blocking = m.checks.filter((c) => c.status === "fail");
  const behind = m.feed?.head != null && status.sequence != null ? Math.max(0, m.feed.head - status.sequence) : null;
  const nextCheck =
    m.state === "following" && m.last_checked_at
      ? new Date(new Date(m.last_checked_at).getTime() + m.interval_seconds * 1000).toISOString()
      : null;
  const waitingKeys = m.keys.filter((k) => !k.accepted);
  const acceptedKeys = m.keys.filter((k) => k.accepted);
  const batches = m.batches ?? [];
  const pill = STATE_PILL[m.state];

  return (
    <WorkPage>
      <WorkHead
        title="Mirror"
        sub={
          <span className="w-row" style={{ gap: 10 }}>
            <Pill tone={pill.tone}>{pill.text}</Pill>
            <span>
              {status.public_graph_as_of ? `The public graph as of ${shortWhen(status.public_graph_as_of)}` : "Nothing mirrored yet"}
              {status.applied && !status.complete ? " · a snapshot is partly applied" : ""}
            </span>
            <Tip>
              This deployment never asks the live public graph about anything, because what it asks would show what it works on. It pulls the whole
              feed, which shows minerval.ai only that it exists and when it pulls, and reads the public graph from what the feed left here.
            </Tip>
          </span>
        }
        actions={
          mayAdminister &&
          !bySettings && (
            <>
              {m.state === "following" && <WorkForm action={checkMirrorAction} submit="Check now" small inline />}
              {m.state === "following" && <WorkForm action={pauseMirrorAction} submit="Pause" small inline />}
              {m.state !== "following" && (
                <WorkForm action={followMirrorAction} submit={m.state === "paused" ? "Follow again" : "Start following"} primary small inline />
              )}
            </>
          )
        }
      />

      {bySettings && (
        <Banner>
          The operator&apos;s settings say what this deployment follows ({m.source.kind === "files" ? "MIRROR_FEED_DIR" : "MIRROR_FEED_URL"}
          {m.source.address ? `: ${m.source.address}` : ""}), so it is not started or paused here.
          {m.keys_set_by_settings ? " The feed's keys are named there too (MIRROR_FEED_PUBLIC_KEYS)." : ""}
        </Banner>
      )}

      {status.last_refusal && (
        <Banner tone="bad">
          <span className="w-row" style={{ gap: 8 }}>
            <span>
              {REFUSAL_WORDS[status.last_refusal.code] ?? "A batch was refused."} {british(status.last_refusal.message)}
              {status.last_refusal.code === "unknown_key" && waitingKeys.length > 0 && (
                <>
                  {" "}
                  <a href="#key">Compare and accept the key below.</a>
                </>
              )}
            </span>
            {m.refusal_owner && <OwnerPill owner={m.refusal_owner} />}
          </span>
        </Banner>
      )}
      {m.last_check_error && !status.last_refusal && <Note tone="warn">{british(m.last_check_error)}</Note>}
      {m.check_requested && <Note>Check now was pressed; the mirror looks at the feed within a few seconds.</Note>}

      {m.state !== "not_started" || bySettings ? (
        <Stats>
          <Stat k="As of" v={status.public_graph_as_of ? age(status.public_graph_as_of) : "—"} s={status.public_graph_as_of ? shortWhen(status.public_graph_as_of) : "no batch applied"} />
          <Stat k="Newest batch" v={status.sequence ?? "—"} s={status.applied_at ? `applied ${shortWhen(status.applied_at)}` : undefined} />
          <Stat
            k="Behind the feed"
            v={behind === null ? "—" : plural(behind, "batch", "batches")}
            s={m.feed?.error ? british(m.feed.error) : m.feed?.head != null ? `the feed is at ${m.feed.head}` : undefined}
          />
          <Stat
            k="Next check"
            v={m.state === "following" ? (nextCheck ? shortWhen(nextCheck) : "soon") : "—"}
            s={m.state === "following" ? `every ${Math.round(m.interval_seconds / 60) || 1} min` : m.state === "paused" ? `paused ${shortWhen(m.paused_at)}${m.paused_by ? ` by ${m.paused_by}` : ""}` : undefined}
          />
          <Stat k="Public claims" v={status.searchable_claims.toLocaleString("en-GB")} s="a search here can find" />
        </Stats>
      ) : null}

      {!bySettings && (
        <Section
          title="Before following"
          aside={blocking.length === 0 ? "Everything holds" : `${plural(blocking.length, "thing")} to put right`}
        >
          <Table label="What must hold before following">
            <thead>
              <tr>
                <th>Check</th>
                <th>Status</th>
                <th>What it says</th>
                <th>Who fixes it</th>
              </tr>
            </thead>
            <tbody>
              {m.checks.map((c) => (
                <tr key={c.key}>
                  <td style={{ whiteSpace: "nowrap" }}>{CHECK_TITLE[c.key]}</td>
                  <td>
                    <Pill tone={CHECK_PILL[c.status].tone}>{CHECK_PILL[c.status].text}</Pill>
                  </td>
                  <td className="w-muted w-small">
                    {british(c.message)}
                    {c.key === "connected" && c.status === "fail" && (
                      <>
                        {" "}
                        <Link href="/admin/outside">Overview</Link>
                      </>
                    )}
                  </td>
                  <td>{c.status !== "pass" && <OwnerPill owner={c.owner} />}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {m.state === "not_started" && (
            <p className="w-muted w-small" style={{ marginTop: 8 }}>
              Following starts with the public graph&apos;s latest snapshot: every public claim, source and assessment, several gigabytes the
              first time, applied a batch at a time. After that each batch is the changes since the one before. Pulling the whole feed shows
              minerval.ai that this deployment exists and when it pulls, and nothing about what it reads.
              {mayAdminister && blocking.length > 0 ? " Start following is refused until every check above holds." : ""}
            </p>
          )}
        </Section>
      )}

      {!m.keys_set_by_settings && (
        <Section
          title="The feed's key"
          id="key"
          aside={acceptedKeys.length > 0 ? `${plural(acceptedKeys.length, "key")} accepted` : "None accepted"}
          actions={mayAdminister && <WorkForm action={readMirrorKeysAction} submit="Read the key again" small inline />}
        >
          <p className="w-muted w-small" style={{ marginTop: 0 }}>
            A batch is applied only when its signature verifies under a key accepted here; the key a batch carries is never trusted. Compare the
            key below, character for character, with the key Minerval publishes in its documentation, outside this deployment, before accepting
            it. An accepted key stays accepted, so a new one can be accepted beside it while the feed changes keys.
          </p>
          {m.keys.length === 0 ? (
            <div className="w-tbox">
              <Empty>No key has been read from the feed yet. It is read when the deployment connects with read_feed.</Empty>
            </div>
          ) : (
            <Table label="The feed's keys">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Read</th>
                  <th>Accepted</th>
                </tr>
              </thead>
              <tbody>
                {m.keys.map((k) => (
                  <tr key={k.key_id}>
                    <td>
                      <div className="w-mono" style={{ wordBreak: "break-all" }}>
                        {k.public_key}
                      </div>
                      <div className="w-faint w-small">
                        id <span className="w-mono">{k.key_id.slice(0, 16)}</span>
                        {k.current ? " · the feed signs with this one now" : ""}
                      </div>
                    </td>
                    <td className="w-small" style={{ whiteSpace: "nowrap" }}>
                      {shortWhen(k.first_seen_at)}
                    </td>
                    <td className="w-small">
                      {k.accepted ? (
                        <span>
                          <Pill tone="ok">Accepted</Pill> {k.accepted_by ? `by ${k.accepted_by}, ` : ""}
                          {shortWhen(k.accepted_at)}
                        </span>
                      ) : mayAdminister ? (
                        <WorkForm action={acceptMirrorKeyAction} submit="Accept" small>
                          <input type="hidden" name="key_id" value={k.key_id} />
                          <label className="w-row w-small" style={{ gap: 6 }}>
                            <input type="checkbox" name="compared" value="1" required /> I compared it with the key Minerval publishes
                          </label>
                        </WorkForm>
                      ) : (
                        <Pill tone="warn">Waiting for an administrator</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>
      )}

      {m.files && (
        <Section title="Batch files" aside={`${plural(m.files.length, "file")} in ${m.source.address ?? "MIRROR_FEED_DIR"}`}>
          <p className="w-muted w-small" style={{ marginTop: 0 }}>
            This deployment follows from files. The next batch it needs is {status.sequence != null ? status.sequence + 1 : "the start of the latest snapshot"}
            ; files are checked exactly as fetched batches are.
          </p>
          {m.files.length === 0 ? (
            <div className="w-tbox">
              <Empty>No batch file is there.</Empty>
            </div>
          ) : (
            <Table label="Batch files">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Batch</th>
                  <th>Here</th>
                </tr>
              </thead>
              <tbody>
                {m.files.slice(-50).reverse().map((f) => (
                  <tr key={f.name}>
                    <td className="w-mono w-small">{f.name}</td>
                    <td>{f.sequence}</td>
                    <td>{f.applied ? <Pill tone="ok">Applied</Pill> : status.sequence != null && f.sequence < status.sequence ? <Pill>Passed over</Pill> : <Pill tone="info">Not yet</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>
      )}

      <Section title="Batches applied" aside={batches.length > 0 ? `the newest ${batches.length}` : undefined}>
        {batches.length === 0 ? (
          <div className="w-tbox">
            <Empty>No batch has been applied here.</Empty>
          </div>
        ) : (
          <Table label="Batches applied">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Cut</th>
                <th>Applied</th>
                <th>Rows</th>
                <th>For this deployment&apos;s own work</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.sequence}>
                  <td>
                    {b.sequence} {b.kind === "snapshot" && <Pill tone="info">Snapshot</Pill>}
                  </td>
                  <td className="w-small">{shortWhen(b.cut_at)}</td>
                  <td className="w-small">{shortWhen(b.applied_at)}</td>
                  <td className="w-small">
                    {b.written.toLocaleString("en-GB")} written{b.removed > 0 ? `, ${b.removed.toLocaleString("en-GB")} removed` : ""}
                  </td>
                  <td className="w-small">{notesWords(b.notes)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </WorkPage>
  );
}

/** A batch's notes in words, the ones that touch this deployment's own work first. */
function notesWords(n: NonNullable<MirrorSetup["batches"]>[number]["notes"]) {
  if (!n) return <span className="w-faint">Shown to administrators</span>;
  const parts = [
    n.kept_claims > 0 && `${plural(n.kept_claims, "public claim")} withdrawn there and kept here as deprecated, because something here rests on it`,
    n.merged_with_local_rows > 0 && `${plural(n.merged_with_local_rows, "public claim")} merged away there that something here still points to`,
    n.local_judgments_retired > 0 && `${plural(n.local_judgments_retired, "judgment")} recorded at a public node's own label retired`,
    n.kept_rows > 0 && `${plural(n.kept_rows, "public row")} withdrawn there and kept here`,
    n.local_rows_followed > 0 && `${plural(n.local_rows_followed, "local row")} removed with a public row`,
  ].filter((p): p is string => typeof p === "string");
  if (parts.length === 0) return <span className="w-faint">Nothing</span>;
  return (
    <span>
      {parts.join("; ")}.{" "}
      <span className="w-faint">The Steward at each label concerned was told.</span>
    </span>
  );
}
