import { redirect } from "next/navigation";

// "Your grants" was a list of the mandates you fund. It is the Mandates
// list's first tab now; this address is kept for links already out there.
export default function GrantsPage() {
  redirect("/mandates?show=mine");
}
