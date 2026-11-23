import { WorkForm } from "@/components/work/WorkForm";
import { Banner, Pill, Section, Tip, shortDay } from "@/components/work/ui";
import type { ReleaseAsks, VersionPart } from "@/lib/admin-api";
import { releaseStepDoneAction, uploadReleaseListAction } from "@/app/admin/settings/actions";

// What the deployment runs, what changed since the version before, and what
// is newer (GET /setup/checklist, `version`; docs/releases.md, "What a
// deployment shows"). A withdrawn release is said first. Each thing a
// release asks is for whoever runs the deployment, with the line on the
// machine to change; an administrator marks a step done here once it is.

const WHERE: Record<"environment" | "file" | "app", string> = {
  environment: "in the machine's environment (.env or api.env)",
  file: "in the config file",
  app: "on Settings",
};

export function VersionSection({ version }: { version: VersionPart }) {
  const { running, parts, before, list } = version;
  const others = [parts.web ? `web app ${parts.web}` : null, parts.sandbox ? `sandbox ${parts.sandbox}` : null].filter(Boolean);
  const newer = version.newer.filter((r) => !r.withdrawn);
  return (
    <Section
      title="Version"
      id="version"
      aside={
        <span className="w-row" style={{ gap: 6 }}>
          Minerval {running.version}
          <Tip>
            One version for the whole product: the API, the web app and the sandbox are released together. Upgrading is done on the machine, by whoever runs the deployment; nothing here upgrades it.
          </Tip>
        </span>
      }
    >
      {version.withdrawn && (
        <Banner tone="bad">
          Release {running.version}, which this deployment runs, was withdrawn on {version.withdrawn.date}: {version.withdrawn.reason} Move to{" "}
          {version.withdrawn.move_to}.
        </Banner>
      )}

      <div className="w-card">
        <div className="w-card-b">
          <div className="w-row" style={{ gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 15, color: "var(--w-ink)" }}>Minerval {running.version}</span>
            {version.dev && (
              <Pill tone="warn" title="A build of the main branch between releases, not a release. The notes below cover releases only.">
                Build of main
              </Pill>
            )}
            {running.commit && <span className="w-muted w-small">commit {running.commit.slice(0, 12)}</span>}
          </div>
          <div className="w-muted w-small" style={{ marginTop: 4 }}>
            {before
              ? `Upgraded from ${before.version} on ${shortDay(before.until)}.`
              : running.since
                ? `Running since ${shortDay(running.since)}.`
                : "When it started running this version was not recorded."}
            {others.length > 0 ? ` Also: ${others.join(", ")}.` : ""}
            {version.dev ? " This is a build of the main branch between releases; the notes below cover releases only." : ""}
          </div>
        </div>
      </div>

      {version.changes.length > 0 && (
        <div className="w-card">
          <div className="w-card-b">
            <div style={{ fontWeight: 500, color: "var(--w-ink)" }}>What changed since {before?.version}</div>
            {version.changes.map((release) => (
              <Asks key={release.version} release={release} marking />
            ))}
          </div>
        </div>
      )}
      {version.notes_problems.length > 0 && (
        <Banner tone="warn">Some release notes in this image could not be read: {version.notes_problems.join(" ")}</Banner>
      )}

      <div className="w-card">
        <div className="w-card-b">
          <div style={{ fontWeight: 500, color: "var(--w-ink)" }}>
            {newer.length === 0
              ? "No newer release is known"
              : `${newer.length} newer ${newer.length === 1 ? "release" : "releases"}, the latest ${version.latest}`}
          </div>
          <div className="w-muted w-small" style={{ marginTop: 4 }}>
            {listWords(list)}
          </div>
          {version.newer.map((release) => (
            <Asks key={release.version} release={release} withdrawn={release.withdrawn} />
          ))}
          {version.upgrade_commands && (
            <>
              <div className="w-muted w-small" style={{ margin: "12px 0 6px" }}>
                {version.through
                  ? `${version.latest} cannot be reached from ${running.version} directly. Upgrade to ${version.through} first, on the machine:`
                  : `To upgrade to ${version.latest}, on the machine:`}
              </div>
              <pre className="w-code">{version.upgrade_commands.join("\n")}</pre>
            </>
          )}
          {!list.reads && list.keys > 0 && (
            <div style={{ marginTop: 12 }}>
              <WorkForm action={uploadReleaseListAction} submit="Upload the list" inline>
                <input type="file" name="file" accept="application/json,.json" aria-label="The file of the list of releases" />
              </WorkForm>
              <span className="w-help">
                The list as the public graph serves it (GET /setup/releases there), saved as a file. Every entry is checked against Minerval&rsquo;s release key, which this version carries.
              </span>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

function listWords(list: VersionPart["list"]): string {
  if (list.keys === 0) {
    return "This version of Minerval carries no release key yet, so no list of releases can be checked. It knows of releases from the notes in its own images.";
  }
  if (!list.reads) {
    return list.check === "never"
      ? "This deployment asks nobody about releases (releases.check is \"never\"): it knows of them from the notes in its images, and from a file of the list uploaded here."
      : "This deployment serves the list of releases itself.";
  }
  if (list.error) return `The list of releases could not be read: ${list.error}. It is asked for again daily, and when this page is opened.`;
  if (!list.checked_at) return "The list of releases has not been read yet.";
  return `The list was read ${shortDay(list.checked_at)}, with nothing that names this deployment.`;
}

function Asks({ release, marking = false, withdrawn = false }: { release: ReleaseAsks; marking?: boolean; withdrawn?: boolean }) {
  const nothing =
    release.operator_steps.length === 0 && release.retired_still_set.length === 0 && release.defaults_pinned.length === 0 && release.added.length === 0;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="w-row" style={{ gap: 8 }}>
        <span style={{ fontWeight: 500, color: "var(--w-ink)" }}>{release.version}</span>
        <span className="w-muted w-small">{release.date}</span>
        {release.security && <Pill tone="bad">Security</Pill>}
        {withdrawn && <Pill tone="neu">Withdrawn</Pill>}
        <Pill title="For whoever runs the deployment, on the machine.">Operator</Pill>
      </div>
      {nothing ? (
        <div className="w-muted w-small" style={{ marginTop: 4 }}>
          {withdrawn ? "Withdrawn: not one to upgrade to." : "Asks nothing of this deployment beyond the upgrade itself."}
        </div>
      ) : (
        <ul className="w-small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {release.operator_steps.map((s) => (
            <li key={s.step} style={{ marginBottom: 4 }}>
              {s.step}{" "}
              {s.done ? (
                <span className="w-muted">
                  Done{s.done_by ? `, marked by ${s.done_by}` : ""}
                  {s.done_at ? ` ${shortDay(s.done_at)}` : ""}.
                </span>
              ) : marking ? (
                <WorkForm action={releaseStepDoneAction} submit="Mark done" inline>
                  <input type="hidden" name="version" value={release.version} />
                  <input type="hidden" name="step" value={s.step} />
                </WorkForm>
              ) : null}
            </li>
          ))}
          {release.retired_still_set.map((s) => (
            <li key={s.env} style={{ marginBottom: 4 }}>
              <code>{s.env}</code> is retired and still set {WHERE[s.where]}. In its place: {s.replaced_by}. {s.note}
            </li>
          ))}
          {release.defaults_pinned.map((s) => (
            <li key={s.env} style={{ marginBottom: 4 }}>
              The default of <code>{s.key}</code> went from {s.from || "empty"} to {s.to || "empty"}, and this deployment pins the old value {WHERE[s.where]}. {s.why}
            </li>
          ))}
          {release.added.map((s) => (
            <li key={s.key} style={{ marginBottom: 4 }}>
              New setting <code>{s.key}</code>
              {s.set ? " (set here)" : ""}: {s.note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
