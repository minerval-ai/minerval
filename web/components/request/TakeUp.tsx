"use client";

import { useState } from "react";
import styles from "./request.module.css";

// Taking a request up from its page (docs/outward-acts.md, "Taking up a
// request in public"): one statement on the record, under the account's
// name and dated. The page says plainly what it commits to before the click.
export function TakeUp({ requestId }: { requestId: string }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const takeUp = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/requests/${requestId}/take-up`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.code === "SIGN_IN") {
        window.location.href = `/signin?callbackUrl=${encodeURIComponent(`/requests/${requestId}`)}`;
        return;
      }
      if (!res.ok) setError(data.error ?? "That did not go through; please try again.");
      else setSaid(data.already ? data.in_words : "It is on the record: your account is taking this request up.");
    } catch {
      setError("That did not go through; please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (said) {
    return (
      <p role="status" className={styles.sideNote}>
        {said} When you have something, contribute it on a page the request bears on.
      </p>
    );
  }
  return (
    <>
      <button type="button" className={styles.sideButton} onClick={takeUp} disabled={busy}>
        {busy ? "Saying so…" : "Take it up"}
      </button>
      {error && (
        <p role="status" className={styles.sideNote}>
          {error}
        </p>
      )}
    </>
  );
}
