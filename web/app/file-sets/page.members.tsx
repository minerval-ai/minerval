import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { ActionForm } from "@/components/admin/ActionForm";
import { LabelChoice } from "@/components/admin/LabelChoice";
import { NeedsPermission, Notice, can, viewer } from "@/components/admin/access";
import { WorkNav, day, plural } from "@/components/inside/nav";
import { fetchMyLabels, fetchParties } from "@/lib/admin-api";
import { fetchFileSets } from "@/lib/inside-api";
import { FILE_SET_STATE_WORDS as STATE_WORDS, bytesInWords } from "@/lib/inside-words";
import { addFileSetAction } from "./actions";

export const metadata: Metadata = { title: "File sets · Minerval" };
export const dynamic = "force-dynamic";

// Sets of files added for the agents to explore in the deployment's own
// sandbox (docs/file-sets.md): the sets at labels the reader reads, and the
// two ways to add one, each offered to whoever may use it here. The notice
// at the top is the API's, shown in full wherever a set is added.

export default async function FileSetsPage() {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct") && !can(who, "administer")) return <NeedsPermission title="File sets" permission="direct" />;
  const [{ notice, ways_in: ways, file_sets: sets }, labels, allParties] = await Promise.all([
    fetchFileSets(who.externalId),
    fetchMyLabels(who.externalId),
    // The list of parties is an administrator's read. A person who directs
    // and does not administer is offered the parties their own grants name.
    fetchParties(who.externalId).catch(() => null),
  ]);
  const ownParties = [...new Map(who.mine.grants.filter((g) => g.party).map((g) => [g.party!.id, g.party!])).values()];
  const parties = allParties ?? ownParties;

  return (
    <div className="admin-page">
      <PageHead
        title="File sets"
        lede="Much of what an organisation knows is too large or too raw to be a document: a data export, a month of logs, the transcripts of an evaluation, a repository of code. A file set takes such files in together, and the agents that weigh evidence explore it by running commands of their own in a sandbox this deployment runs, which has no network."
      />
      <WorkNav who={who} current="/file-sets" />
      <Notice>{notice}</Notice>

      <section className="acct-section admin-first" id="sets">
        <div className="acct-head">
          <h2>The sets at labels you read</h2>
        </div>
        {!ways.sandbox_configured && (
          <p className="acct-prose acct-measure">
            This deployment has no sandbox configured, so agents cannot run commands over a set. They can still keep a file of a set, or a
            passage of one, as a source.
          </p>
        )}
        {sets.length === 0 ? (
          <p className="account-empty">No file set is at a label you read. A set at another label is not listed here.</p>
        ) : (
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>set</th>
                  <th>whose files</th>
                  <th>label</th>
                  <th>state</th>
                  <th className="acct-num">files</th>
                  <th className="acct-num">commands run</th>
                  <th className="acct-num">kept as sources</th>
                </tr>
              </thead>
              <tbody>
                {sets.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/file-sets/${s.id}`}>{s.name}</Link>
                      <span className="acct-detail">{s.origin === "directory" ? "a directory registered where it lies" : "uploaded"}</span>
                    </td>
                    <td>{s.party.name}</td>
                    <td>
                      <code>{s.label}</code>
                    </td>
                    <td>
                      {STATE_WORDS[s.state] ?? s.state}
                      {s.state === "closed" && <span className="acct-detail">{day(s.closed_at)}</span>}
                      {!s.enabled && <span className="acct-detail">switched off: no run is offered it</span>}
                    </td>
                    <td className="acct-num">
                      {s.file_count.toLocaleString("en-GB")}
                      <span className="acct-detail">{bytesInWords(s.total_bytes)}</span>
                    </td>
                    <td className="acct-num">{s.commands.toLocaleString("en-GB")}</td>
                    <td className="acct-num">{(s.analyses_kept + s.files_kept).toLocaleString("en-GB")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="acct-section" id="add">
        <div className="acct-head">
          <h2>Add a set</h2>
        </div>
        {!ways.upload && !ways.register_directory ? (
          <p className="account-empty">
            {can(who, "direct") || can(who, "administer")
              ? "Neither way of adding a set works here for you. Uploading takes the permission to direct and a store configured for uploads; registering a directory takes the permission to administer and a root directory configured to register from."
              : ""}
          </p>
        ) : parties.length === 0 ? (
          <p className="account-empty">
            {allParties
              ? <>A set names the party whose files it holds, and no party is recorded yet. An administrator adds one on <Link href="/admin/labels#parties">Labels and parties</Link>.</>
              : "A set names the party whose files it holds. The list of parties is read by administrators only, because a deployment may hold material from parties who are not to learn of each other, and your own permissions name no party. So a set cannot be added from this page by you; a person who both directs and administers can add one."}
          </p>
        ) : (
          <>
            <p className="acct-prose acct-measure">
              {ways.upload && "Uploading is for sets of modest size: every byte passes through this site, and the set is added empty for you to fill and then close. "}
              {ways.register_directory &&
                "Registering a directory is for data too large to upload: the deployment walks a directory already on its own disk and hashes each file where it lies, copying nothing. It takes the permission to administer, because whoever registers a directory decides what label files already on the disk get. "}
              Either way the set is added at a label you read, and keeps it.
            </p>
            {!allParties && (
              <p className="acct-prose acct-measure">
                The parties offered are the ones your own permissions name, because the full list of parties is read by administrators.
                If the files belong to another party, an administrator can tell you, or add the set.
              </p>
            )}
            <ActionForm action={addFileSetAction} submit="Add this set">
              <fieldset className="admin-fieldset inside-choices">
                <legend>How it is filled</legend>
                {ways.upload && (
                  <label className="admin-check">
                    <input type="radio" name="way" value="upload" required defaultChecked={!ways.register_directory} />
                    <span>By uploading files from this page.</span>
                  </label>
                )}
                {ways.register_directory && (
                  <label className="admin-check">
                    <input type="radio" name="way" value="directory" required defaultChecked={!ways.upload} />
                    <span>From a directory already on the deployment&rsquo;s disk.</span>
                  </label>
                )}
              </fieldset>
              <label>
                Name
                <input name="name" required maxLength={120} />
                <small>What people and agents know the set by.</small>
              </label>
              <label>
                What it holds
                <textarea name="description" rows={2} />
                <small>A sentence or two. Agents are shown it as the words of whoever added the set.</small>
              </label>
              {ways.register_directory && (
                <label>
                  Directory, if registering one
                  <input name="directory" placeholder="finance/2026-q3" />
                  <small>A path under the root this deployment registers directories from. A symbolic link is not followed.</small>
                </label>
              )}
              <label>
                Whose files these are
                <select name="party_id" required defaultValue="">
                  <option value="" disabled>
                    Choose a party
                  </option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                That party&rsquo;s stake in what the files show
                <textarea name="stake" rows={2} required />
                <small>
                  What the party stands to gain or lose, in a sentence or two. It is recorded on every source an agent keeps from the set, as a
                  fact about the source. It is not a finding against the source, and a stake does not make the files wrong.
                </small>
              </label>
              <LabelChoice mine={labels} what="Agents whose work is at a label that reads this one can read every file in the set. The set keeps the label it is added at." />
            </ActionForm>
          </>
        )}
      </section>
      <p className="acct-prose acct-measure">
        {plural(sets.length, "set")} listed. Every set added, closed or switched off is in the log on{" "}
        <Link href="/admin/people#log">People and permissions</Link>, with a set&rsquo;s name shown only to readers of its label.
      </p>
    </div>
  );
}
