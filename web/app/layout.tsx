import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "./Mark";
import "./globals.css";

export const metadata: Metadata = {
  title: "Minerval · an open repository of claims",
  description:
    "A knowledge graph of claims with transparent provenance, decomposition, and validity assessment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <div className="masthead-inner">
            <Link href="/" className="wordmark plain">
              <span className="glyph" aria-hidden><Mark size="0.82em" /></span>Minerval
            </Link>
            {/* Four routes carry the phone masthead; `tour` and `about` are marked
                wide-only and drop out below 640px, where the footer nav carries
                both (#367). Anything added here should be weighed the same way:
                the phone row is one line, and it stays one line. */}
            <nav>
              <Link href="/claims">claims</Link>
              <Link href="/mandates">mandates</Link>
              <Link href="/docs">docs</Link>
              {/* reopens the home walkthrough (#251) */}
              <Link className="wide-only" href="/findings">findings</Link>
              <Link className="wide-only" href="/?tour=1">tour</Link>
              <Link className="wide-only" href="/about">about</Link>
              <Link href="/account">account</Link>
            </nav>
          </div>
        </header>
        <main className="frame">{children}</main>
        <footer className="site">
          <div className="inner">
            <p style={{ margin: "0 0 .7rem" }}>
              Minerval is infrastructure for thought: a shared map of claims, evidence, and
              argument, maintained by LLM administrators under a public constitution.
              Assessments are based on evidence and reasoning, open to inspection and correction.
            </p>
            <nav style={{ display: "flex", gap: "1.1rem", flexWrap: "wrap" }}>
              <Link href="/claims">claims</Link>
              <Link href="/mandates">mandates</Link>
              <Link href="/docs">docs</Link>
              {/* the walkthrough's entry point on phones, where the masthead
                  drops its wide-only entries (#367) */}
              <Link href="/?tour=1">tour</Link>
              <Link href="/about">about</Link>
              {/* the findings feed (#394): the record of what the
                  administrators found worth telling people */}
              <Link href="/findings">findings</Link>
              {/* /contributors stays reachable by URL but is not linked until
                  the contributor experience is ready (#191) */}
              <Link href="/account">account</Link>
              <Link href="/privacy">privacy</Link>
              <a href="https://github.com/minerval-ai/minerval">source</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
