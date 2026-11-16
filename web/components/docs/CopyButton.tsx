"use client";

import { useState } from "react";

// Copies a snippet. Where the clipboard is refused (an embedded view, an old
// browser) it says so, and the snippet stays selectable by hand.
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="dc-copy"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => setState("copied"), () => setState("failed"))
          .finally(() => setTimeout(() => setState("idle"), 1500));
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : "Copy"}
    </button>
  );
}
