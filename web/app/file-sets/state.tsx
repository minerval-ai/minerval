import { Pill } from "@/components/work/ui";
import type { FileSetView } from "@/lib/inside-api";

// A file set's state as pills: where filling it has got, and whether it is
// switched off. The same on the list and on the set's own page.

export function FileSetState({ set }: { set: Pick<FileSetView, "state" | "enabled" | "closed_at" | "problem"> }) {
  return (
    <>
      {set.state === "open" && <Pill tone="info" title="Files are being uploaded; no run is offered it until it is closed">Open — uploading</Pill>}
      {set.state === "hashing" && <Pill tone="info" title="The directory is being walked and each file hashed where it lies">Hashing</Pill>}
      {set.state === "closed" && <Pill tone="ok" title={set.closed_at ? `Closed ${set.closed_at.slice(0, 10)}: nothing is added or changed afterwards` : undefined}>Closed</Pill>}
      {set.state === "failed" && <Pill tone="bad" title={set.problem ?? undefined}>Failed</Pill>}
      {!set.enabled && <Pill tone="neu" title="Switched off: no run is offered it; what was kept from it stays">Off</Pill>}
    </>
  );
}
