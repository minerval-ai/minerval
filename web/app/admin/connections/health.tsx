import { Pill } from "@/components/work/ui";
import type { ConnectionView } from "@/lib/admin-api";

// How a connection stands, as one pill: the same on the list and on its page.
export function ConnectionHealth({ connection: c }: { connection: Pick<ConnectionView, "enabled" | "state"> }) {
  if (!c.enabled || c.state.status === "off") {
    return (
      <Pill tone="neu" title="Switched off: no run is offered its tools; readings already kept stand">
        Off
      </Pill>
    );
  }
  switch (c.state.status) {
    case "answering":
      return (
        <Pill tone="ok" title={c.state.last_checked_at ? `Last asked ${c.state.last_checked_at.slice(0, 16).replace("T", " ")} UTC` : undefined}>
          Answering
        </Pill>
      );
    case "failing":
      return (
        <Pill tone="bad" title={c.state.last_error?.message}>
          Not answering
        </Pill>
      );
    default:
      return (
        <Pill tone="warn" title="The server has never been asked for its tools">
          Never asked
        </Pill>
      );
  }
}
