import { redirect } from "next/navigation";

// Adding a source is the drawer of the Sources page now (app/sources).
// The old address keeps working.
export default function AddSourcePage() {
  redirect("/sources?drawer=add");
}
