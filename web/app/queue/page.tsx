import { redirect } from "next/navigation";
import { accountApiConfigured, listMandates } from "../../lib/account-api";

export const dynamic = "force-dynamic";

/**
 * /queue retired into the mandate pages: the allocation engine's public
 * face is per-mandate now (the EV/EC computation belongs to the
 * mandates), and the General assessment mandate's page is the canonical
 * global view. This route survives as a redirect so old links keep
 * working.
 */
export default async function QueuePage() {
  if (accountApiConfigured()) {
    let generalId: string | null = null;
    try {
      const mandates = await listMandates();
      generalId =
        mandates.find(
          (m) => m.is_platform && m.title === "General assessment",
        )?.id ?? null;
    } catch {
      // fall through to the discovery page
    }
    if (generalId) redirect(`/mandates/${generalId}`);
  }
  redirect("/mandates");
}
