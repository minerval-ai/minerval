"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./home.module.css";

// A guided walkthrough of the home page (#251). Five steps, each anchored to
// a [data-tour] element; a quiet ring highlights the anchor and a card beside
// it explains what the visitor is looking at. No library: the backdrop is the
// ring's box-shadow, so the page underneath stays clickable throughout.
//
// Strictly opt-in: nothing opens or invites on its own. The masthead's "tour"
// entry (/?tour=1) is the only way in, from any page, as often as wanted.

const STEPS: { target: string; title: string; body: string }[] = [
  {
    target: "search",
    title: "It starts with a claim",
    body:
      "Everything on Minerval is a claim: one checkable statement, broken down " +
      "into the smaller claims it rests on. Search any topic to find its claims.",
  },
  {
    target: "map",
    title: "Read the map",
    body:
      "Each box is a claim, and the lines between them say which claims support, " +
      "contradict, or assume which. Hover any claim for a preview; click one and " +
      "it opens in the full-screen map, where you can walk the graph.",
  },
  {
    target: "legend",
    title: "The verdicts",
    body:
      "Every assessed claim carries a verdict from the evidence: verified, " +
      "supported, contested, unsupported, contradicted, or unknown. Hover any " +
      "term in this legend for its definition.",
  },
  {
    target: "tabs",
    title: "Three ways in",
    body:
      "The same graph is served three ways: this map, a browser extension that " +
      "checks claims on the pages you read, and an MCP server your AI tools can query.",
  },
  {
    target: "docs",
    title: "Who keeps it honest",
    body:
      "Eight LLM administrators maintain the graph under a public constitution, " +
      "and every verdict keeps its reasoning open to challenge. These pages " +
      "explain how; the claims themselves are the best place to start.",
  },
];

type Box = { top: number; left: number; width: number; height: number };

export function HomeTour() {
  const router = useRouter();
  const params = useSearchParams();
  const wantsTour = params.has("tour");

  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const dir = useRef(1); // travel direction, so hidden anchors are skipped past
  const cardRef = useRef<HTMLDivElement>(null);

  // The measuring effect advances past hidden anchors without re-subscribing;
  // it reads the current step through a ref.
  const stepRef = useRef<number | null>(null);
  stepRef.current = step;

  const close = useCallback(() => {
    setStep(null);
    setBox(null);
  }, []);

  const go = useCallback(
    (n: number) => {
      dir.current = n > (stepRef.current ?? -1) ? 1 : -1;
      if (n < 0) return;
      if (n >= STEPS.length) return close();
      setStep(n);
    },
    [close],
  );

  useEffect(() => {
    if (!wantsTour) return;
    dir.current = 1;
    setStep(0);
    router.replace("/", { scroll: false });
  }, [wantsTour, router]);

  // Measure the active anchor (document coordinates, so scrolling doesn't
  // invalidate them) and bring it to the middle of the viewport. An anchor
  // that is missing or display:none (e.g. the map when another tab is open)
  // skips its step in the direction of travel.
  useEffect(() => {
    if (step === null) return;
    const el = document.querySelector<HTMLElement>(`[data-tour="${STEPS[step].target}"]`);
    if (!el || el.offsetParent === null) {
      const next = step + dir.current;
      if (next < 0 || next >= STEPS.length) close();
      else setStep(next);
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({
        top: r.top + window.scrollY,
        left: r.left + window.scrollX,
        width: r.width,
        height: r.height,
      });
    };
    measure();
    const r = el.getBoundingClientRect();
    const y = Math.max(0, r.top + window.scrollY - Math.max(16, (window.innerHeight - r.height) / 2));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: y, behavior: reduced ? "auto" : "smooth" });
    cardRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step, close]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") go(step + 1);
      if (e.key === "ArrowLeft" && step > 0) go(step - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, go, close]);

  const active = step !== null && box !== null;
  // A tall anchor (the map) fills the viewport; docking the card to the bottom
  // of the screen keeps the two visible together.
  const tall = active && typeof window !== "undefined" && box!.height > window.innerHeight * 0.55;

  return (
    <>
      {active &&
        createPortal(
          <>
            <div
              className={styles.tourRing}
              aria-hidden
              style={{
                top: box!.top - 5,
                left: box!.left - 5,
                width: box!.width + 10,
                height: box!.height + 10,
              }}
            />
            <div
              ref={cardRef}
              tabIndex={-1}
              role="dialog"
              aria-label={`Tour, step ${step! + 1} of ${STEPS.length}: ${STEPS[step!].title}`}
              className={`${styles.tourCard}${tall ? ` ${styles.tourCardDocked}` : ""}`}
              style={
                tall
                  ? undefined
                  : {
                      top: box!.top + box!.height + 14,
                      left: Math.max(16, Math.min(box!.left, window.innerWidth - 356)),
                    }
              }
            >
              <div className={styles.tourHead}>
                <span className="sc">tour · {step! + 1} of {STEPS.length}</span>
                <button
                  type="button"
                  className={styles.tourDismiss}
                  aria-label="End the tour"
                  onClick={close}
                >
                  ✕
                </button>
              </div>
              <p className={styles.tourTitle}>{STEPS[step!].title}</p>
              <p className={styles.tourBody}>{STEPS[step!].body}</p>
              <div className={styles.tourFoot}>
                {step! > 0 ? (
                  <button type="button" className={styles.tourNav} onClick={() => go(step! - 1)}>
                    ← back
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" className={styles.tourNav} onClick={() => go(step! + 1)}>
                  {step! < STEPS.length - 1 ? "next →" : "done ✓"}
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
