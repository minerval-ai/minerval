// Shown the moment a link to a mandate is followed, while its page reads the
// mandate from the API (see app/mandates/loading.tsx).
export default function MandateLoading() {
  return (
    <div className="mnd" aria-busy="true">
      <p className="acct-note">Reading the mandate…</p>
    </div>
  );
}
