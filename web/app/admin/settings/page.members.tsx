import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import { Banner, ButtonLink, Count, Drawer, Pill, Section, Table, Tip, WorkHead, WorkPage, plural, shortDay, type Tone } from "@/components/work/ui";
import { AccountApiError } from "@/lib/account-api";
import { fetchSettings, fetchSettingsFile, type SettingView, type SettingsListing } from "@/lib/admin-api";
import { groupSettings, settingName, sourceWords, valueWords, type SettingGroup } from "@/lib/settings";
import { SettingForm } from "./SettingForm";
import { restartAction } from "./actions";

export const metadata: Metadata = { title: "Settings · Minerval" };
export const dynamic = "force-dynamic";

// Every setting of the deployment (GET /settings; docs/settings.md), in
// groups: its value, where the value comes from, and for one the
// administrators may change, the form that changes it. A setting whoever
// runs the machine has fixed is shown with where it is set and is not
// offered. The tuning, which a deployment rarely decides, is folded away
// under the groups a deployment does decide; it is changed the same way.

const PAGE = "/admin/settings";

const SOURCE_TONE: Record<SettingView["source"], Tone> = { app: "info", default: "neu", environment: "warn", file: "warn" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; drawer?: string; back?: string }>;
}) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Settings" permission="administer" />;
  const { edit, drawer, back } = await searchParams;

  let listing: SettingsListing;
  try {
    listing = await fetchSettings(who.externalId);
  } catch (err) {
    return (
      <WorkPage>
        <WorkHead title="Settings" />
        <Banner tone="bad">
          The settings could not be read just now{err instanceof AccountApiError ? `: ${err.message}` : "."} Try again in a moment.
        </Banner>
      </WorkPage>
    );
  }

  const decided = groupSettings(listing.settings.filter((s) => !s.tuning));
  const tuning = groupSettings(listing.settings.filter((s) => s.tuning));
  const tuningCount = tuning.reduce((n, g) => n + g.settings.length, 0);
  const waiting = listing.settings.filter((s) => s.waiting);
  const editing = edit ? listing.settings.find((s) => s.key === edit) : undefined;
  // A drawer opened from Health closes back onto Health.
  const close = back === "health" ? "/admin" : PAGE;
  const file = drawer === "file" ? await fetchSettingsFile(who.externalId).catch(() => null) : null;

  return (
    <WorkPage>
      <WorkHead
        title="Settings"
        sub={
          <span className="w-row" style={{ gap: 6 }}>
            How this deployment works · each change is logged
            <Tip>
              A setting is chosen from four places, the first that has it winning: the machine's environment, its config file, what an administrator set here, and the default. The first two are whoever runs the machine's, and fix the setting: it is shown here and changed there.
            </Tip>
          </span>
        }
        actions={
          <>
            <ButtonLink href="/admin/activity?type=settings" icon="log">
              Changes
            </ButtonLink>
            <ButtonLink href={`${PAGE}?drawer=file`}>As a config file</ButtonLink>
          </>
        }
      />

      {listing.problem && (
        <Banner tone="bad">
          The settings saved here are not in force, because together with the machine&rsquo;s they cannot be used: {listing.problem} The
          deployment is running on the machine&rsquo;s settings and the defaults. Put the setting right below, or return it to its default.
        </Banner>
      )}

      {waiting.length > 0 && (
        <div className="w-card">
          <div className="w-card-b">
            <div className="w-row" style={{ gap: 8 }}>
              <span style={{ fontWeight: 600, color: "var(--w-ink)" }}>
                {plural(waiting.length, "change")} {waiting.length === 1 ? "waits" : "wait"} for the API to be started again
              </span>
              <Count n={waiting.length} hot />
            </div>
            <div className="w-muted w-small" style={{ margin: "6px 0 10px" }}>
              {waiting.map((s) => s.key).join(", ")}. These are read only where the API starts. Starting it again ends every run in flight; each hands its work back and is taken up again.
            </div>
            <WorkForm action={restartAction} submit="Start the API again" inline lock="Ends runs in flight">
              <input className="w-input" name="reason" maxLength={500} autoComplete="off" placeholder="Why (optional)" aria-label="Why" style={{ width: 260, height: 26 }} />
            </WorkForm>
          </div>
        </div>
      )}

      {decided.map((g) => (
        <GroupSection key={g.group} group={g} back={back} />
      ))}

      <Section title="Tuning" id="tuning" aside={<span>{plural(tuningCount, "setting")} a deployment rarely decides</span>}>
        {tuning.map((g) => (
          <details key={g.group} className="w-card" open={editing?.tuning && editing.group === g.group} id={`group-${g.group}`}>
            <summary className="w-card-b" style={{ cursor: "pointer" }}>
              <span style={{ fontWeight: 500, color: "var(--w-ink)" }}>{g.name}</span>{" "}
              <span className="w-muted w-small">
                {g.about} · {plural(g.settings.length, "setting")}
                {g.settings.some((s) => s.source === "app") ? ` · ${g.settings.filter((s) => s.source === "app").length} set here` : ""}
              </span>
            </summary>
            <SettingsTable group={g} back={back} />
          </details>
        ))}
      </Section>

      {editing && (
        <Drawer title={editing.key} close={close} wide={editing.kind === "groups" || editing.kind === "lists"}>
          {editing.changeable ? (
            <SettingForm setting={editing} />
          ) : (
            <>
              <p>{editing.about}</p>
              <p className="w-muted">{editing.fixed_by}</p>
              {!editing.secret && <p className="w-muted w-small">It is {valueWords(editing, editing.value)} now.</p>}
            </>
          )}
          <p className="w-help">
            In the environment this setting is <code>{editing.env}</code>
            {editing.secret ? "" : <>; in the config file, <code>{editing.key}</code></>}.
            {editing.set_by && editing.set_at ? ` Set here by ${editing.set_by.name || "an administrator"}, ${shortDay(editing.set_at)}.` : ""}
          </p>
        </Drawer>
      )}

      {drawer === "file" && (
        <Drawer title="As a config file" close={PAGE} wide>
          <p className="w-muted">
            What is set here, written as a config file: to start another deployment the same way, or to hand a setting to whoever runs the machine to fix there. It holds no key.
          </p>
          {file === null ? <Banner tone="bad">The file could not be written just now.</Banner> : <pre className="w-code">{file}</pre>}
        </Drawer>
      )}
    </WorkPage>
  );
}

function GroupSection({ group, back }: { group: SettingGroup; back?: string }) {
  return (
    <Section title={group.name} id={`group-${group.group || "provider_labels"}`} aside={group.about}>
      <SettingsTable group={group} back={back} />
    </Section>
  );
}

function SettingsTable({ group, back }: { group: SettingGroup; back?: string }) {
  return (
    <Table label={group.name}>
      <thead>
        <tr>
          <th>Setting</th>
          <th>Value</th>
          <th>From</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {group.settings.map((s) => {
          const from = sourceWords(s);
          return (
            <tr key={s.key} id={`setting-${s.key}`}>
              <td style={{ maxWidth: 420 }}>
                <div style={{ fontWeight: 500, color: "var(--w-ink)" }}>{settingName(s)}</div>
                <div className="w-muted w-small">{s.about}</div>
              </td>
              <td style={{ maxWidth: 320, overflowWrap: "anywhere" }}>
                {valueWords(s, s.value)}
                {s.waiting && (
                  <div className="w-small">
                    <Pill tone="warn" title="Saved, and read only where the API starts.">
                      Waits for a restart
                    </Pill>{" "}
                    <span className="w-muted">{s.secret ? "a new key" : valueWords(s, s.waiting.value)}</span>
                  </div>
                )}
                {s.unopened && (
                  <div className="w-small">
                    <Pill tone="bad" title="The key this deployment seals with is not the one that sealed it.">
                      Cannot be opened
                    </Pill>
                  </div>
                )}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <Pill tone={s.where === "machine" ? "neu" : SOURCE_TONE[s.source]} title={from.title}>
                  {from.word}
                </Pill>
              </td>
              <td className="w-num">
                <Link
                  className="w-btn w-sm"
                  href={`${PAGE}?edit=${encodeURIComponent(s.key)}${back ? `&back=${encodeURIComponent(back)}` : ""}`}
                  scroll={false}
                >
                  {s.changeable ? (s.secret ? (s.is_set ? "Replace" : "Give") : "Change") : "Why"}
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
