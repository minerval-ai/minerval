import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { NeedsPermission, Notice, can, viewer, when } from "@/components/admin/access";
import { Hash, WorkNav, day } from "@/components/inside/nav";
import { fetchFileSet, fetchFileSetCommands, fetchFileSetFiles } from "@/lib/inside-api";
import { closeFileSetAction, rehashFileSetAction, switchFileSetAction } from "../actions";
import { FILE_SET_STATE_WORDS as STATE_WORDS, bytesInWords } from "@/lib/inside-words";
import { Uploader } from "./Uploader";

export const metadata: Metadata = { title: "A file set · Minerval" };
export const dynamic = "force-dynamic";

// One file set (docs/file-sets.md): what it is, its files with their
// hashes, the commands agents ran with it mounted, and switching it off.
// While a set is open its files are uploaded from here; while a registered
// directory is being walked the page shows how far the walk has got.

const OUTCOME_WORDS: Record<string, string> = {
  running: "still running",
  exited: "finished",
  timed_out: "stopped at the time limit",
  memory: "stopped for using too much memory",
  output_ceiling: "stopped for printing too much",
  scratch_full: "stopped for filling its scratch directory",
  killed: "ended by the system",
  failed: "could not be run",
};

const FILES_SHOWN = 500;

export default async function FileSetPage({ params }: { params: Promise<{ id: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct") && !can(who, "administer")) return <NeedsPermission title="A file set" permission="direct" />;
  const { id } = await params;
  const got = await fetchFileSet(who.externalId, id).catch(() => null);
  if (!got) notFound();
  const set = got.file_set;
  const [files, commands] = await Promise.all([
    fetchFileSetFiles(who.externalId, id, FILES_SHOWN).catch(() => []),
    fetchFileSetCommands(who.externalId, id).catch(() => null),
  ]);

  return (
    <div className="admin-page">
      <PageHead
        back={{ href: "/file-sets", label: "file sets" }}
        kicker="File set"
        title={set.name}
        lede={set.description || "Whoever added this set gave no description of what it holds."}
      />
      <WorkNav who={who} current="" />
      <Notice>{got.notice}</Notice>

      <section className="acct-section admin-first" id="facts">
        <div className="acct-head">
          <h2>What it is</h2>
        </div>
        <div className="acct-scroll">
          <table className="account-table acct-table admin-facts">
            <tbody>
              <tr>
                <td>whose files</td>
                <td>
                  {set.party.name}
                  {set.party.is_own_organization ? ", the organisation itself" : ", an outside party"}
                </td>
              </tr>
              <tr>
                <td>its stake</td>
                <td>{set.stake}</td>
              </tr>
              <tr>
                <td>label</td>
                <td>
                  <code>{set.label}</code>
                  <span className="acct-detail">Agents whose work is at a label that reads this one are offered the set. It keeps this label.</span>
                </td>
              </tr>
              <tr>
                <td>how it was filled</td>
                <td>{set.origin === "directory" ? <>A directory registered where it lies: <code>{set.directory}</code>. Nothing was copied.</> : "Uploaded."}</td>
              </tr>
              <tr>
                <td>state</td>
                <td>
                  {(STATE_WORDS[set.state] ?? set.state).replace(/^./, (c) => c.toUpperCase())}
                  {set.state === "closed" ? ` on ${day(set.closed_at)}. Nothing is added, changed or removed afterwards; new files are a new set.` : "."}
                  {set.problem && <span className="acct-detail">Why it failed: {set.problem}</span>}
                </td>
              </tr>
              <tr>
                <td>files</td>
                <td>
                  {set.file_count.toLocaleString("en-GB")} file{set.file_count === 1 ? "" : "s"}, {bytesInWords(set.total_bytes)}
                  {set.state === "hashing" || set.state === "open" ? " so far" : ""}
                </td>
              </tr>
              <tr>
                <td>hash of the whole set</td>
                <td>
                  {set.manifest_sha256 ? (
                    <>
                      <code className="inside-hash-whole">{set.manifest_sha256}</code>
                      <span className="acct-detail">
                        SHA-256 over one line for each file, its hash and its path, in order of path: what <code>sha256sum</code> prints.
                        Anyone holding the files can compute it.
                      </span>
                    </>
                  ) : (
                    "Taken when the set closes."
                  )}
                </td>
              </tr>
              <tr>
                <td>address in the sandbox</td>
                <td>
                  <code>{set.origin === "directory" ? `/registered/${set.directory}` : `/sets/${set.slug}`}</code>, mounted read-only
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {set.state === "open" && (
        <section className="acct-section" id="upload">
          <div className="acct-head">
            <h2>Upload its files, then close it</h2>
          </div>
          {can(who, "direct") ? (
            <>
              <Uploader setId={set.id} />
              <p className="acct-prose acct-measure">
                No run is offered the set until it is closed. Closing fixes it: the hash of the whole set is taken over every file, and
                nothing is added afterwards.
              </p>
              <ActionForm action={closeFileSetAction} submit="Close this set">
                <input type="hidden" name="file_set_id" value={set.id} />
              </ActionForm>
            </>
          ) : (
            <p className="account-empty">Uploading into a set and closing it take the permission to direct.</p>
          )}
        </section>
      )}

      {set.state === "hashing" && (
        <section className="acct-section" id="walk">
          <div className="acct-head">
            <h2>The walk</h2>
          </div>
          <p className="acct-prose acct-measure">
            The deployment is walking the directory and hashing each file where it lies: {set.file_count.toLocaleString("en-GB")} file
            {set.file_count === 1 ? "" : "s"} and {bytesInWords(set.total_bytes)} so far. That takes as long as the data is large, and the set
            closes by itself when the walk is done. <Link href={`/file-sets/${set.id}`}>Look again.</Link>
          </p>
        </section>
      )}

      {(set.state === "failed" || set.state === "hashing") && set.origin === "directory" && can(who, "administer") && (
        <section className="acct-section" id="rehash">
          <div className="acct-head">
            <h2>Walk it again</h2>
          </div>
          <p className="acct-prose acct-measure">
            Where the walk failed or was cut short, it can be started again from nothing. The set then takes in whatever the directory holds
            now.
          </p>
          <ActionForm action={rehashFileSetAction} submit="Walk and hash the directory again">
            <input type="hidden" name="file_set_id" value={set.id} />
          </ActionForm>
        </section>
      )}

      <section className="acct-section" id="files">
        <div className="acct-head">
          <h2>Its files</h2>
        </div>
        {files.length === 0 ? (
          <p className="account-empty">No file is in the set yet.</p>
        ) : (
          <>
            {set.file_count > files.length && (
              <p className="acct-prose acct-measure">
                The first {files.length.toLocaleString("en-GB")} of {set.file_count.toLocaleString("en-GB")} files, in order of path.
              </p>
            )}
            <div className="acct-scroll">
              <table className="account-table acct-table">
                <thead>
                  <tr>
                    <th>path</th>
                    <th className="acct-num">size</th>
                    <th>SHA-256, taken when it was added</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.path}>
                      <td>
                        <code>{f.path}</code>
                      </td>
                      <td className="acct-num">{bytesInWords(f.bytes)}</td>
                      <td>
                        <Hash value={f.sha256} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="acct-section" id="commands">
        <div className="acct-head">
          <h2>Commands agents ran with it mounted</h2>
        </div>
        <p className="acct-prose acct-measure">
          Every command is stored whole with what it printed. A command is listed for those who read at the label of the run that ran it.
          What a command printed is not shown here: where an agent&rsquo;s judgement rested on a command it kept it as a source, and the
          source holds the command, any script given with it and the output, for a reader who may open sources at that label.
        </p>
        {commands?.not_shown_note && <p className="acct-prose acct-measure">{commands.not_shown_note}</p>}
        {!commands ? (
          <p className="account-empty">The commands could not be read just now. That says nothing about whether any was run.</p>
        ) : commands.commands.length === 0 ? (
          <p className="account-empty">
            {commands.not_shown > 0 ? "No command run against this set was run at a label you read." : "No agent has run a command with this set mounted."}
          </p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>when</th>
                  <th>command</th>
                  <th>how it ended</th>
                  <th>output</th>
                  <th>kept</th>
                </tr>
              </thead>
              <tbody>
                {commands.commands.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {when(c.called_at)}
                      {c.claim_id && (
                        <span className="acct-detail">
                          for <Link href={`/claims/${c.claim_id}`}>a node</Link>
                          {c.run_id ? <> · <Link href={`/runs/${c.run_id}`}>the run</Link></> : null}
                        </span>
                      )}
                    </td>
                    <td>
                      <code>{c.command}</code>
                      {c.files.length > 0 && <span className="acct-detail">with {c.files.map((f) => f.path).join(", ")}</span>}
                      {c.file_sets.length > 1 && <span className="acct-detail">also mounted: {c.file_sets.filter((s) => s.id !== set.id).map((s) => s.name).join(", ")}</span>}
                    </td>
                    <td>
                      {OUTCOME_WORDS[c.outcome] ?? c.outcome}
                      {c.exit_code !== null && <span className="acct-detail">exit code {c.exit_code}</span>}
                      {c.error && <span className="acct-detail">{c.error}</span>}
                    </td>
                    <td>
                      {c.output_chars === null ? "none" : `${c.output_chars.toLocaleString("en-GB")} characters`}
                      {c.output_sha256 && (
                        <span className="acct-detail">
                          <Hash value={c.output_sha256} />
                        </span>
                      )}
                    </td>
                    <td>{c.source_id ? <Link href={`/sources/${c.source_id}`}>as a source, {day(c.kept_at)}</Link> : "not kept"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {set.state === "closed" && can(who, "direct") && (
        <section className="acct-section" id="switch">
          <div className="acct-head">
            <h2>{set.enabled ? "Switch it off" : "Switch it on"}</h2>
          </div>
          <p className="acct-prose acct-measure">
            {set.enabled
              ? "A set is never deleted, since commands and kept sources refer to it. Switched off, no run is offered it. What agents already kept from it stays as it is, and it can be switched on again."
              : "This set is switched off: no run is offered it. Switched on, runs whose label reads its label are offered it again."}
          </p>
          <ActionForm action={switchFileSetAction} submit={set.enabled ? "Switch this set off" : "Switch this set on"} danger={set.enabled}>
            <input type="hidden" name="file_set_id" value={set.id} />
            <input type="hidden" name="enabled" value={set.enabled ? "false" : "true"} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
