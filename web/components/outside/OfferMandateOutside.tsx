import { ActionForm } from "@/components/admin/ActionForm";
import { offerMandateOutsideAction } from "@/app/admin/outside/actions";
import { membersOnly } from "@/lib/members";
import { holds, loadStanding } from "@/lib/standing";

// On a private deployment, under a mandate's page: offer the mandate to the
// gate to outside, so that once through it stands on the organisation's
// record on the public graph as its face there, and requests on the public
// graph can be addressed to it (docs/the-gate.md, "A published mandate").
// The mandate's Grantmaker then decides what to take up, under its terms.
// On the public site this renders nothing.
export async function OfferMandateOutside({ mandateId, live }: { mandateId: string; live: boolean }) {
  if (!membersOnly() || !live) return null;
  const standing = await loadStanding();
  if (standing.state !== "signed_in" || !holds(standing, "direct")) return null;
  return (
    <section className="acct-section" id="outside">
      <div className="acct-head">
        <h2>On the public graph</h2>
      </div>
      <p className="acct-prose acct-measure">
        Offer this mandate to the gate to outside to make it the organisation&rsquo;s face on the public graph. Once the gate lets it
        through, its name and terms stand on the organisation&rsquo;s record there, with how the gate to outside is set for its work,
        and anyone on the public graph can address a request to it. Its Grantmaker decides which to take up, under its terms, and pays
        for the work from this mandate&rsquo;s budget here. That a request was taken up or declined, and the page of each node it bears
        on, then go to the gate to outside as they are ready.
      </p>
      <ActionForm action={offerMandateOutsideAction} submit="Offer this mandate on the public graph">
        <input type="hidden" name="mandate_id" value={mandateId} />
        <p className="admin-kept">
          <small>
            The offer goes through the gate to outside under its setting for mandates, so the Redactor, and a person where the gate
            says so, read the terms before anything leaves. Offering it again changes nothing. Ending the offer later withdraws the
            mandate there.
          </small>
        </p>
      </ActionForm>
    </section>
  );
}
