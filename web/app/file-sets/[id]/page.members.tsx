import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import {
  Banner,
  Empty,
  Lbl,
  Party,
  Pill,
  Strip,
  Table,
  Tabs,
  Tip,
  WorkHead,
  WorkPage,
  shortDay,
  shortWhen,
} from "@/components/work/ui";
import { fetchFileSet, fetchFileSetCommands, fetchFileSetFiles } from "@/lib/inside-api";
import { bytesInWords } from "@/lib/inside-words";
import { closeFileSetAction, rehashFileSetAction, switchFileSetAction } from "../actions";
import { FileSetState } from "../state";
import { Uploader } from "./Uploader";
import "../file-sets.css";

export const metadata: Metadata = { title: "A file set · Minerval" };
export const dynamic = "force-dynamic";

// One file set (docs/file-sets.md): what it is, its files with their
// hashes, the commands agents ran with it mounted, and switching it off.
// While a set is open its files are uploaded from here; while a registered
// directory is being walked the page shows how far the walk has got.

const OUTCOME_WORDS: Record<string, string> = {
  running: "Still running",
  exited: "Finished",
  timed_out: "Stopped at the time limit",
  memory: "Stopped: too much memory",
  output_ceiling: "Stopped: printed too much",
  scratch_full: "Stopped: scratch directory full",
  killed: "Ended by the system",
  failed: "Could not be run",
};

const FILES_SHOWN = 500;

export default async function FileSetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; path?: string }>;
}) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "direct") && !can(who, "administer")) return <NeedsPermission title="A file set" permission="direct" />;
  const { id } = await params;
  const q = await searchParams;
  const got = await fetchFileSet(who.externalId, id).catch(() => null);
  if (!got) notFound();
  const set = got.file_set;
  const [files, commands] = await Promise.all([
    fetchFileSetFiles(who.externalId, id, FILES_SHOWN).catch(() => []),
    fetchFileSetCommands(who.externalId, id).catch(() => null),
  ]);
  const tab = q.tab === "commands" ? "commands" : "files";
  const base = `/file-sets/${set.id}`;
  const pathFilter = (q.path ?? "").trim();
  const filesShown = pathFilter ? files.filter((f) => f.path.toLowerCase().includes(pathFilter.toLowerCase())) : files;
  const filling = set.state === "hashing" || set.state === "open";
  const sandboxPath = set.origin === "directory" ? `/registered/${set.directory}` : `/sets/${set.slug}`;
  const directs = can(who, "direct");

  return (
    <WorkPage>
      <WorkHead
        crumbs={[{ href: "/file-sets", label: "File sets" }]}
        title={set.name}
        tags={
          <>
            <FileSetState set={set} />
            <Lbl name={set.label} />
            <Party name={set.party.name} own={set.party.is_own_organization} />
            <Tip>{got.notice}</Tip>
          </>
        }
        sub={
          <>
            {set.description || "No description of what it holds"} · {set.origin === "directory" ? "registered directory" : "uploaded"},{" "}
            {shortDay(set.created_at)}
          </>
        }
        actions={
          <>
            {set.state === "open" && directs && (
              <WorkForm action={closeFileSetAction} submit="Close set" primary inline lock="Can't be undone">
                <input type="hidden" name="file_set_id" value={set.id} />
              </WorkForm>
            )}
            {set.state === "closed" && directs && (
              <WorkForm action={switchFileSetAction} submit={set.enabled ? "Switch off" : "Switch on"} inline>
                <input type="hidden" name="file_set_id" value={set.id} />
                <input type="hidden" name="enabled" value={set.enabled ? "false" : "true"} />
              </WorkForm>
            )}
            {(set.state === "failed" || set.state === "hashing") && set.origin === "directory" && can(who, "administer") && (
              <WorkForm action={rehashFileSetAction} submit="Rehash" inline>
                <input type="hidden" name="file_set_id" value={set.id} />
              </WorkForm>
            )}
          </>
        }
      />

      {set.state === "failed" && set.problem && (
        <Banner tone="bad">
          <span>Why it failed: {set.problem}</span>
        </Banner>
      )}
      {set.state === "hashing" && (
        <Banner>
          <span>
            Walking the directory and hashing each file where it lies: {set.file_count.toLocaleString("en-GB")} file{set.file_count === 1 ? "" : "s"},{" "}
            {bytesInWords(set.total_bytes)} so far. It closes by itself when the walk is done.
          </span>
          <Link className="w-spacer" href={base}>
            Look again
          </Link>
        </Banner>
      )}
      {set.state === "closed" && !set.enabled && (
        <Banner>
          <span>Switched off: no run is offered it. What agents already kept from it stays.</span>
        </Banner>
      )}

      <Strip
        rows={[
          [
            "Party",
            <span key="p" className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
              <Party name={set.party.name} own={set.party.is_own_organization} />
              <Tip>{`Stake: ${set.stake}`}</Tip>
            </span>,
          ],
          ["Label", <Lbl key="l" name={set.label} />],
          [
            <span key="k" className="w-row" style={{ gap: 6 }}>
              Sandbox path <Tip>{`Mounted read-only for agents whose label reads ${set.label}`}</Tip>
            </span>,
            <span key="v" className="w-mono">
              {sandboxPath}
            </span>,
          ],
          [
            "Files",
            <span key="f">
              {set.file_count.toLocaleString("en-GB")} · {bytesInWords(set.total_bytes)}
              {filling && <span className="w-faint w-small"> so far</span>}
            </span>,
          ],
          [
            <span key="k" className="w-row" style={{ gap: 6 }}>
              Manifest <Tip>SHA-256 over one line for each file, its hash and its path, in order of path: what sha256sum prints. Anyone holding the files can compute it.</Tip>
            </span>,
            set.manifest_sha256 ? (
              <span key="m" className="w-mono" title={set.manifest_sha256}>
                {set.manifest_sha256.slice(0, 16)}…
              </span>
            ) : (
              <span key="m" className="w-muted">
                Taken when the set closes
              </span>
            ),
          ],
          [
            "Agents",
            set.state !== "closed" ? (
              <Pill key="a" tone="neu">
                Not offered until closed
              </Pill>
            ) : set.enabled ? (
              <Pill key="a" tone="ok">
                Offered
              </Pill>
            ) : (
              <Pill key="a" tone="neu">
                Switched off
              </Pill>
            ),
          ],
        ]}
      />

      {set.state === "open" &&
        (directs ? (
          <Uploader setId={set.id} />
        ) : (
          <Banner>
            <span>Uploading into a set and closing it take the permission to direct.</span>
          </Banner>
        ))}

      <section className="w-sec">
        <Tabs
          current={tab}
          tabs={[
            { key: "files", label: "Files", href: base, count: set.file_count },
            { key: "commands", label: "Commands", href: `${base}?tab=commands`, count: commands?.commands.length ?? 0 },
          ]}
        />

        {tab === "files" ? (
          <>
            {files.length > 0 && (
              <form className="w-toolbar" method="get" action={base}>
                <label className="w-search" style={{ margin: 0, width: 300 }}>
                  <input name="path" defaultValue={pathFilter} placeholder="Filter by path" aria-label="Filter by path" />
                </label>
                {pathFilter && <Link href={base}>Clear</Link>}
                <span className="w-faint w-small w-spacer">
                  In path order{set.file_count > files.length ? ` · first ${files.length.toLocaleString("en-GB")} of ${set.file_count.toLocaleString("en-GB")}` : ""}
                </span>
              </form>
            )}
            {filesShown.length === 0 ? (
              <div className="w-card">
                <Empty>{files.length === 0 ? "No file is in the set yet." : "No file here matches."}</Empty>
              </div>
            ) : (
              <Table label="Files">
                <thead>
                  <tr>
                    <th>Path</th>
                    <th className="w-num">Size</th>
                    <th>
                      <span className="w-row" style={{ gap: 6 }}>
                        SHA-256 <Tip>Taken by the deployment when the file arrived</Tip>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filesShown.map((f) => (
                    <tr key={f.path}>
                      <td className="w-mono">{f.path}</td>
                      <td className="w-num">{bytesInWords(f.bytes)}</td>
                      <td>
                        <span className="w-mono w-faint" title={f.sha256}>
                          {f.sha256.slice(0, 16)}…
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : (
          <>
            <div className="w-toolbar">
              <span className="w-muted w-small">Commands agents ran with it mounted</span>
              <Tip>
                Every command is stored whole with what it printed. A command is listed for those who read at the label of the run that ran it. What a command printed is not shown here: where an agent&rsquo;s judgement rested on a command it kept it as a source, and the source holds the command, any script given with it and the output, for a reader who may open sources at that label.
              </Tip>
              {commands?.not_shown_note && <span className="w-faint w-small w-spacer">{commands.not_shown_note}</span>}
            </div>
            {!commands ? (
              <div className="w-card">
                <Empty>The commands could not be read just now. That says nothing about whether any was run.</Empty>
              </div>
            ) : commands.commands.length === 0 ? (
              <div className="w-card">
                <Empty>
                  {commands.not_shown > 0 ? "No command run against this set was run at a label you read." : "No agent has run a command with this set mounted."}
                </Empty>
              </div>
            ) : (
              <Table label="Commands">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Command</th>
                    <th>How it ended</th>
                    <th className="w-num">Output</th>
                    <th>Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.commands.map((c) => (
                    <tr key={c.id}>
                      <td className="w-top" style={{ whiteSpace: "nowrap" }}>
                        {shortWhen(c.called_at)}
                        {(c.claim_id || c.run_id) && (
                          <div className="w-small">
                            {c.claim_id && <Link href={`/claims/${c.claim_id}`}>Node</Link>}
                            {c.claim_id && c.run_id && " · "}
                            {c.run_id && <Link href={`/runs/${c.run_id}`}>Run</Link>}
                          </div>
                        )}
                      </td>
                      <td className="w-top">
                        <code className="w-mono">{c.command}</code>
                        {c.files.length > 0 && <div className="w-faint w-small">with {c.files.map((f) => f.path).join(", ")}</div>}
                        {c.file_sets.length > 1 && (
                          <div className="w-faint w-small">
                            also mounted: {c.file_sets.filter((s) => s.id !== set.id).map((s) => s.name).join(", ")}
                          </div>
                        )}
                      </td>
                      <td className="w-top">
                        <Pill tone={c.outcome === "exited" ? (c.exit_code === 0 ? "ok" : "warn") : c.outcome === "running" ? "info" : "bad"}>
                          {OUTCOME_WORDS[c.outcome] ?? c.outcome}
                        </Pill>
                        {c.exit_code !== null && <div className="w-faint w-small">exit code {c.exit_code}</div>}
                        {c.error && <div className="w-faint w-small">{c.error}</div>}
                      </td>
                      <td className="w-num w-top">
                        {c.output_chars === null ? "none" : `${c.output_chars.toLocaleString("en-GB")} chars`}
                        {c.output_sha256 && (
                          <div className="w-mono w-faint" title={c.output_sha256}>
                            {c.output_sha256.slice(0, 12)}…
                          </div>
                        )}
                      </td>
                      <td className="w-top">
                        {c.source_id ? (
                          <Link href={`/sources/${c.source_id}`}>As a source, {shortDay(c.kept_at)}</Link>
                        ) : (
                          <span className="w-faint">Not kept</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </section>
    </WorkPage>
  );
}
