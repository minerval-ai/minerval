import { redirect } from "next/navigation";

// A boundary's redaction policy is now a tab of the boundary's page
// (gates/[id]); the list of policies is the list of boundaries.
export default function PoliciesPage() {
  redirect("/gates");
}
