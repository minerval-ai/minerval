import { redirect } from "next/navigation";

// Owls, the General mandates and the prices an owl is counted at are on
// Budget now (app/admin/budget). An old link's #standing-mandate-<label>
// anchor is not sent to the server, so it cannot be carried over; Budget
// anchors each General mandate as #general-<label>.
export default function OwlsPage() {
  redirect("/admin/budget");
}
