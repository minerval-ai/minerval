import { PageHead } from "@/components/PageHead";

// Shown the moment a link to the mandates is followed, while the page reads
// the list from the API. The page is rendered for its reader on every visit,
// and without this the page the reader came from stays up, unchanged, until
// the whole list has arrived.
export default function MandatesLoading() {
  return (
    <div className="mnd mnds" aria-busy="true">
      <PageHead title="Mandates" />
      <p className="acct-note">Reading the mandates…</p>
    </div>
  );
}
