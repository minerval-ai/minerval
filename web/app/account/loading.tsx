import { PageHead } from "@/components/PageHead";

// Shown the moment a link to the account is followed, while the page reads
// the account, its owls, keys and work from the API (see
// app/mandates/loading.tsx).
export default function AccountLoading() {
  return (
    <div className="col account" aria-busy="true">
      <PageHead title="Account" />
      <p className="acct-note">Reading your account…</p>
    </div>
  );
}
