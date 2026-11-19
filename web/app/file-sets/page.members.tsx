import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Banner,
  ButtonLink,
  Drawer,
  Empty,
  Lbl,
  Party,
  Pill,
  Seg,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  plural,
  shortDay,
} from "@/components/work/ui";
import { fetchMyLabels, fetchParties } from "@/lib/admin-api";
import { fetchFileSets, type FileSetView } from "@/lib/inside-api";
import { bytesInWords } from "@/lib/inside-words";
import { LabelField } from "../sources/LabelField";
import { addFileSetAction } from "./actions";
import { FileSetState } from "./state";

export const metadata: Metadata = { title: "File sets · Minerval" };
export const dynamic = "force-dynamic";

// Sets of files added for the agents to explore in the deployment's own
// sandbox (docs/file-sets.md): the sets at labels the reader reads, and the
// two ways to add one, each offered to whoever may use it here, in the
// drawer (`?drawer=new`). The API's notice on what a set is sits behind the
// head's Tip.

const STATES = ["open", "hashing", "closed", "failed"] as const;
const STATE_NAMES: Record<string, string> = { open: "Open", hashing: "Hashing", closed: "Closed", failed: "Failed" };

export default async function FileSetsPage({ searchParams }: { searchParams: Promise<{ drawer?: string; state?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct") && !can(who, "administer")) return <NeedsPermission title="File sets" permission="direct" />;
  const q = await searchParams;
  const [{ notice, ways_in: ways, file_sets: sets }, labels, allParties] = await Promise.all([
    fetchFileSets(who.externalId),
    fetchMyLabels(who.externalId),
    // An administrator reads the parties in full; a person who directs reads their names, to say whose files a set holds.
    fetchParties(who.externalId).catch(() => null),
  ]);
  const parties = allParties ?? [];
  const filter = STATES.includes(q.state as (typeof STATES)[number]) ? (q.state as FileSetView["state"]) : null;
  const shown = filter ? sets.filter((s) => s.state === filter) : sets;
  const adding = q.drawer === "new";
  const close = filter ? `/file-sets?state=${filter}` : "/file-sets";
  const canAdd = ways.upload || ways.register_directory;

  const byState = STATES.map((s) => [s, sets.filter((x) => x.state === s).length] as const).filter(([, n]) => n > 0);
  const sub = [
    plural(sets.length, "set"),
    byState.filter(([s]) => s !== "closed").map(([s, n]) => `${n} ${s}`).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <WorkPage>
      <WorkHead
        title={
          <span className="w-row" style={{ gap: 8 }}>
            File sets <Tip>{notice}</Tip>
          </span>
        }
        sub={sub}
        actions={
          canAdd && (
            <ButtonLink href={`${close}${filter ? "&" : "?"}drawer=new`} primary icon="plus">
              New file set
            </ButtonLink>
          )
        }
      />

      {!ways.sandbox_configured && (
        <Banner>
          <Pill tone="warn">Sandbox not configured</Pill>
          <span>Agents can keep files but not run commands</span>
          {can(who, "administer") && (
            <Link className="w-spacer" href="/admin">
              Health
            </Link>
          )}
        </Banner>
      )}

      {byState.length > 1 && (
        <div className="w-toolbar">
          <Seg
            current={filter ?? "all"}
            options={[
              { key: "all", href: "/file-sets", label: `All ${sets.length}` },
              ...byState.map(([s, n]) => ({ key: s, href: `/file-sets?state=${s}`, label: `${STATE_NAMES[s]} ${n}` })),
            ]}
          />
        </div>
      )}

      {shown.length === 0 ? (
        <div className="w-card">
          <Empty>No file set is at a label you read. A set at another label is not listed here.</Empty>
        </div>
      ) : (
        <Table label="File sets">
          <thead>
            <tr>
              <th>Set</th>
              <th>Party</th>
              <th>Label</th>
              <th>State</th>
              <th className="w-num">Files</th>
              <th className="w-num">Commands run</th>
              <th className="w-num">
                <span className="w-row" style={{ gap: 6, justifyContent: "flex-end" }}>
                  Kept as sources <Tip>Files and command outputs agents kept as sources</Tip>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/file-sets/${s.id}`} style={{ fontWeight: 500 }}>
                    {s.name}
                  </Link>
                  <div className="w-faint w-small">
                    {s.origin === "directory" ? (
                      <>
                        Directory · <span className="w-mono">{s.directory}</span>
                      </>
                    ) : (
                      "Uploaded"
                    )}
                  </div>
                </td>
                <td>
                  <Party name={s.party.name} own={s.party.is_own_organization} />
                </td>
                <td>
                  <Lbl name={s.label} />
                </td>
                <td>
                  <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <FileSetState set={s} />
                    {s.state === "closed" && <span className="w-faint w-small">{shortDay(s.closed_at)}</span>}
                  </span>
                </td>
                <td className="w-num">
                  {s.file_count.toLocaleString("en-GB")}
                  <div className="w-faint w-small">
                    {bytesInWords(s.total_bytes)}
                    {s.state === "hashing" || s.state === "open" ? " so far" : ""}
                  </div>
                </td>
                <td className="w-num">{s.commands.toLocaleString("en-GB")}</td>
                <td className="w-num">{(s.analyses_kept + s.files_kept).toLocaleString("en-GB")}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <div className="w-faint w-small">
        Only sets at labels you read are listed · adding, closing and switching off are in the{" "}
        {can(who, "administer") ? <Link href="/admin/activity">Activity log</Link> : "activity log"}
      </div>

      {adding && (
        <Drawer title="New file set" close={close}>
          {!canAdd ? (
            <Empty>
              Neither way of adding a set works here for you. Uploading takes the permission to direct and a store configured for uploads;
              registering a directory takes the permission to administer and a root directory configured to register from.
            </Empty>
          ) : parties.length === 0 ? (
            <Empty>
              {allParties ? (
                <>
                  A set names the party whose files it holds, and no party is recorded yet.{" "}
                  {can(who, "administer") ? <Link href="/admin/parties">Add one on Parties</Link> : "An administrator adds one."}
                </>
              ) : (
                "A set names the party whose files it holds, and the parties could not be read just now."
              )}
            </Empty>
          ) : (
            <WorkForm action={addFileSetAction} submit="Add set" primary extra={<Link className="w-btn w-ghost" href={close} scroll={false}>Cancel</Link>}>
              <details className="w-small w-muted">
                <summary style={{ cursor: "pointer" }}>What a file set is</summary>
                <p style={{ margin: "6px 0 0" }}>{notice}</p>
              </details>
              <div className="w-field">
                <span className="w-label">Way in</span>
                <div className="w-options">
                  {ways.upload && (
                    <label className="w-option">
                      <input type="radio" name="way" value="upload" required defaultChecked={!ways.register_directory} />
                      <span>
                        <b>Upload files</b>
                        <span>For sets of modest size: every byte passes through this site. Added empty, filled, then closed.</span>
                      </span>
                    </label>
                  )}
                  {ways.register_directory && (
                    <label className="w-option">
                      <input type="radio" name="way" value="directory" required defaultChecked={!ways.upload} />
                      <span>
                        <b>Register a directory</b>
                        <span>For data too large to upload: hashed where it lies on the deployment&rsquo;s disk, nothing copied. Administrators only.</span>
                      </span>
                    </label>
                  )}
                </div>
              </div>
              <div className="w-field">
                <label htmlFor="fs-name">Name</label>
                <input id="fs-name" className="w-input" name="name" required maxLength={120} autoComplete="off" />
                <span className="w-help">What people and agents know the set by</span>
              </div>
              <div className="w-field">
                <label htmlFor="fs-desc" className="w-row" style={{ gap: 6 }}>
                  What it holds <span className="w-faint" style={{ fontWeight: 400 }}>optional</span>
                  <Tip>Agents are shown it as the words of whoever added the set.</Tip>
                </label>
                <textarea id="fs-desc" className="w-input" name="description" rows={2} />
              </div>
              {ways.register_directory && (
                <div className="w-field">
                  <label htmlFor="fs-dir" className="w-row" style={{ gap: 6 }}>
                    Directory <span className="w-faint" style={{ fontWeight: 400 }}>if registering one</span>
                    <Tip>A path under the root this deployment registers directories from. A symbolic link is not followed.</Tip>
                  </label>
                  <input id="fs-dir" className="w-input w-mono" name="directory" placeholder="finance/2026-q3" autoComplete="off" />
                </div>
              )}
              <div className="w-field">
                <label htmlFor="fs-party">Party</label>
                <select id="fs-party" className="w-select" name="party_id" required defaultValue="">
                  <option value="" disabled>
                    Whose files these are
                  </option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-field">
                <label htmlFor="fs-stake" className="w-row" style={{ gap: 6 }}>
                  Stake{" "}
                  <span className="w-faint" style={{ fontWeight: 400 }}>
                    optional
                  </span>
                  <Tip>
                    What the party stands to gain or lose from what the files show, where that is worth saying: for files an outside party supplied, say, whose interest in what they show the agents could not guess. Given, it is recorded on every source an agent keeps from the set, as a fact about the source; it is not a finding against the source. Left empty, none is recorded, and an interest that bears on one question is recorded by the agent weighing that question.
                  </Tip>
                </label>
                <textarea id="fs-stake" className="w-input" name="stake" rows={2} maxLength={1000} />
                <span className="w-help">Usually empty for your own organisation&rsquo;s files</span>
              </div>
              <LabelField
                mine={labels}
                tip="Agents whose work is at a label that reads this one can read every file in the set. The set keeps the label it is added at."
              />
            </WorkForm>
          )}
        </Drawer>
      )}
    </WorkPage>
  );
}
