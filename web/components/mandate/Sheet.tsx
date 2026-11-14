import type { ReactNode } from "react";
import { Markdown } from "../Markdown";
import { paragraphs } from "@/lib/mandate-page";

// A sheet is text someone wrote, set apart from the page that reports on it:
// paper, a hairline, and a bar that says what it is and who wrote it. The
// mandate page's rule is that anything with a byline is an author's words
// and everything else is the page's own.
export function Sheet({
  label,
  by,
  children,
  id,
  className,
}: {
  label: ReactNode;
  by?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <article className={`mnd-sheet${className ? ` ${className}` : ""}`} id={id}>
      <div className="mnd-byline">
        <span className="sc">{label}</span>
        {by && <span className="mnd-by">{by}</span>}
      </div>
      <div className="mnd-sheet-body">{children}</div>
    </article>
  );
}

/** Prose written with blank lines between its paragraphs. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );
}

/**
 * Prose with its first paragraphs shown and the rest one click away. The
 * fold is a <details>, so it opens without scripts and a search in the page
 * finds what is folded.
 */
export function FoldedProse({ text, keep = 2, more = "Read the rest" }: { text: string; keep?: number; more?: string }) {
  const all = paragraphs(text);
  const head = all.slice(0, keep);
  const rest = all.slice(keep);
  return (
    <>
      {head.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {rest.length > 0 && (
        <details className="mnd-more">
          <summary>{more}</summary>
          {rest.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </details>
      )}
    </>
  );
}

/**
 * A note written in Markdown (a Grantmaker's update, its direction), cut at
 * a paragraph when it is long. The cut is made between blocks, so a list or
 * a heading is never split.
 */
export function FoldedNote({ text, keepChars = 700, more = "Read the rest" }: { text: string; keepChars?: number; more?: string }) {
  const blocks = text.split(/\n\s*\n/);
  let used = 0;
  let cut = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    used += blocks[i]!.length;
    if (used > keepChars && i + 1 < blocks.length) {
      cut = i + 1;
      break;
    }
  }
  const head = blocks.slice(0, cut).join("\n\n");
  const rest = blocks.slice(cut).join("\n\n");
  return (
    <>
      <Markdown>{head}</Markdown>
      {rest.trim() && (
        <details className="mnd-more">
          <summary>{more}</summary>
          <Markdown>{rest}</Markdown>
        </details>
      )}
    </>
  );
}
