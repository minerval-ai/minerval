import { redirect } from "next/navigation";

// The agents' reports moved to the Outbox, beside the pages sent outside.
export default function ReportsPage() {
  redirect("/outbound?tab=reports");
}
