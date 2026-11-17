import { redirect } from "next/navigation";

// The usage report is a tab of Budget now (app/admin/budget).
export default function UsageReportPage() {
  redirect("/admin/budget?tab=usage");
}
