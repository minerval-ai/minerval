import { CopyButton } from "./CopyButton";

// A code block in the docs: a label naming what it is (a request, a call, a
// file), the code, and a copy button.
export function Code({ label, children }: { label?: string; children: string }) {
  return (
    <div className="dc-code">
      <div className="dc-code-bar">
        <span>{label ?? ""}</span>
        <CopyButton text={children} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}
