import type { MyLabels } from "../../lib/admin-api";

// Choosing the label of something new: a source, a connection, a standing
// mandate. Shown only where the deployment holds material at more than one
// label; where it holds one, nothing is asked. Nothing is preselected, so
// that nothing is filed where more people read it by leaving a field alone,
// and each label is listed with who reads it, in the API's own words
// (GET /labels/mine). The labels are the ones the person reads: nobody
// places material at a label they could not themselves open.
export function LabelChoice({ mine, what }: { mine: MyLabels; what: string }) {
  if (!mine.must_choose) return null;
  return (
    <label>
      Label
      <select name="label" required defaultValue="">
        <option value="" disabled>
          Choose a label
        </option>
        {mine.labels.map((l) => (
          <option key={l.name} value={l.name}>
            {l.name}
          </option>
        ))}
      </select>
      <small>{what}</small>
      <details className="admin-args">
        <summary>who reads each label</summary>
        <dl className="admin-labels-who">
          {mine.labels.map((l) => (
            <div key={l.name}>
              <dt>
                <code>{l.name}</code>
                {l.description ? ` ${l.description}` : ""}
              </dt>
              <dd>{l.who_reads}</dd>
            </div>
          ))}
        </dl>
      </details>
    </label>
  );
}
