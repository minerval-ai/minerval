import { WorkForm } from "@/components/work/WorkForm";
import type { SettingView } from "@/lib/admin-api";
import { fieldText, settingName, valueWords } from "@/lib/settings";
import { resetSettingAction, setSettingAction } from "./actions";

// The form that changes one setting (docs/settings.md), the same wherever
// the setting is shown: on the settings page and on Health's first day.
// What a value may be is the API's to say; the form only offers the kind.

export function SettingForm({ setting, idPrefix = "setting" }: { setting: SettingView; idPrefix?: string }) {
  const id = `${idPrefix}-${setting.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const current = setting.waiting ? setting.waiting.value : setting.source === "app" ? setting.value : null;
  const shown = fieldText(setting, current ?? (setting.secret ? null : setting.value));
  const restart = setting.applies === "restart";
  return (
    <>
      <WorkForm action={setSettingAction} submit={setting.secret ? "Save the key" : "Save"} primary>
        <input type="hidden" name="key" value={setting.key} />
        <input type="hidden" name="kind" value={setting.kind} />
        <input type="hidden" name="secret" value={setting.secret ? "true" : "false"} />
        <div className="w-field">
          <label htmlFor={id}>{setting.secret ? "The key" : settingName(setting)}</label>
          <Field id={id} setting={setting} shown={shown} />
          <span className="w-help">
            {setting.about}
            {setting.secret
              ? " It is kept sealed and never shown again: the page says only that one is set, and its last four characters."
              : setting.default !== null
                ? ` The default is ${valueWords(setting, setting.default)}.`
                : ""}
            {restart ? " A change takes effect when the API is next started." : " A change is in force within seconds."}
          </span>
        </div>
        <div className="w-field">
          <label htmlFor={`${id}-reason`}>Why (optional)</label>
          <input id={`${id}-reason`} className="w-input" name="reason" maxLength={500} autoComplete="off" />
          <span className="w-help">Kept with the change in the activity log.</span>
        </div>
      </WorkForm>
      {(setting.source === "app" || setting.waiting || setting.unopened) && (
        <WorkForm action={resetSettingAction} submit={setting.secret ? "Remove the key" : "Return to the default"} small>
          <input type="hidden" name="key" value={setting.key} />
          <input type="hidden" name="secret" value={setting.secret ? "true" : "false"} />
        </WorkForm>
      )}
    </>
  );
}

function Field({ id, setting, shown }: { id: string; setting: SettingView; shown: string }) {
  if (setting.secret) {
    return <input id={id} className="w-input" name="value" type="password" required autoComplete="off" spellCheck={false} />;
  }
  switch (setting.kind) {
    case "boolean":
      return (
        <select id={id} className="w-input" name="value" defaultValue={shown === "true" ? "true" : "false"}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case "number":
      return <input id={id} className="w-input" name="value" type="number" step="any" required defaultValue={shown} />;
    case "list":
      return (
        <>
          <textarea id={id} className="w-input" name="value" rows={4} defaultValue={shown} spellCheck={false} />
          <span className="w-help">One to a line. Empty for none.</span>
        </>
      );
    case "groups":
    case "lists":
      return (
        <>
          <textarea id={id} className="w-input" name="value" rows={10} defaultValue={shown} spellCheck={false} style={{ fontFamily: "var(--mono)" }} />
          <span className="w-help">
            {setting.kind === "groups"
              ? "A list of entries, as JSON, each with the names the config file gives them."
              : "Names with their lists, as JSON."}
          </span>
        </>
      );
    default:
      return <input id={id} className="w-input" name="value" defaultValue={shown} autoComplete="off" spellCheck={false} />;
  }
}
