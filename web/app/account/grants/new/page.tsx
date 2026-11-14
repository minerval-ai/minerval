import { redirect } from "next/navigation";

// A mandate is started in conversation with a Grantmaker, which is in the
// Ask section now; this address is kept for links already out there.
export default async function NewGrantPage({
  searchParams,
}: {
  searchParams: Promise<{ claim_id?: string }>;
}) {
  const { claim_id } = await searchParams;
  redirect(`/ask/mandates/new${claim_id ? `?claim_id=${encodeURIComponent(claim_id)}` : ""}`);
}
