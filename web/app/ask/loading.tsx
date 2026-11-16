// Shown in the Ask section's middle column the moment a link is followed,
// while the conversation, mandate or page is read from the API. The sidebar,
// which is the section's layout, stays where it is (see
// app/mandates/loading.tsx).
export default function AskLoading() {
  return (
    <div className="ask-welcome" aria-busy="true">
      <p className="acct-note">Reading…</p>
    </div>
  );
}
