/**
 * Variables an administrator gave in the app that are no setting of the
 * config schema's (docs/settings.md, "Keys issued by someone else").
 *
 * One of the deployment's own model endpoints names the variable that
 * holds its key (key_env), so the names are the deployment's to choose and
 * the schema has no field for them. The settings service hands this
 * process's copy of the stored settings to the configuration
 * (noteStoredSettings in src/config.ts), which leaves the whole copy here,
 * and a reader asks for a variable by its name. The machine's environment
 * wins, as it does for every setting.
 *
 * It imports nothing, so a module can read a variable without loading the
 * configuration.
 */
let given: Readonly<Record<string, string>> = {};

/** Take the stored settings as last read: environment variable to text. */
export function noteGivenVariables(values: Readonly<Record<string, string>>): void {
  given = values;
}

/** The variable's value: the machine's where it has one, else what was given in the app. */
export function givenVariable(name: string): string | undefined {
  const onTheMachine = process.env[name];
  return onTheMachine === undefined || onTheMachine.trim() === "" ? given[name] : onTheMachine;
}
