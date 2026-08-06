import Link from "next/link";

// Privacy policy for the site, API, and browser extension. The Chrome Web
// Store listing (#135) links here from its privacy-practices disclosure, so
// the extension section states exactly what the extension sends and why.

export const metadata = {
  title: "Privacy · Minerval",
  description:
    "What Minerval collects, what the browser extension sends, and what happens to it.",
};

export default function Privacy() {
  return (
    <div className="doc">
      <p className="sc" style={{ marginBottom: ".5rem" }}>Privacy</p>
      <h1>Privacy policy</h1>
      <p className="lede">
        Minerval collects the minimum it needs to run a metered claim-graph
        service, and nothing it collects is sold, shared for advertising, or
        used to track you anywhere else. What it does keep, including a
        contributor&rsquo;s track record on the graph, is described below.
      </p>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".84rem" }}>
        Effective July 31, 2026 · applies to minerval.ai, the Minerval API, and
        the Minerval browser extension.
      </p>

      <h2 id="accounts">Accounts</h2>
      <p>
        Signing in uses OAuth through GitHub or Google. We store the provider
        and account identifier (e.g. <code>github:12345</code>), your display
        name, and nothing else from your provider profile. We never see or
        store a password. API keys you create are stored only as salted
        hashes; the full key is shown once, to you.
      </p>

      <h2 id="reputation">Contributor standing</h2>
      <p>
        The graph is an open commons, and contributions to it are attributed:
        a contributor&rsquo;s track record is part of the graph&rsquo;s
        public record, the same way a cited source&rsquo;s track record is.
        From those outcomes each account accrues standing, which exists to
        keep sincere participation free while spam and deliberate
        manipulation carry a cost. Standing governs what an account may
        contribute, and because the graph weighs every source by its
        reliability, a contributor&rsquo;s record may likewise inform how
        much weight their submissions carry. It is built solely from
        contributions you choose to make; reading claims, analyzing pages
        with the extension, and API usage never affect it. Changes to
        standing are recorded with the contribution that caused them, and
        adverse outcomes can be appealed. Standing is never sold or used for
        advertising.
      </p>

      <h2 id="usage">Usage metering</h2>
      <p>
        Requests that invoke Minerval&rsquo;s analysis agents are metered
        against your account: for each call we record which agent ran, the
        model, token counts, and derived cost. This is billing and
        rate-limiting bookkeeping; it does not include the content you
        analyzed. Reading claims is unauthenticated and unmetered, and read
        requests are not tied to any account.
      </p>

      <h2 id="extension">The browser extension</h2>
      <p>
        The extension sends a page&rsquo;s readable text, its URL, and its
        title to the Minerval API <strong>only when you ask it to</strong>:
        by pressing <em>Analyze page</em> in the popup, or by opting a site
        (or all sites) into automatic analysis in the extension&rsquo;s
        settings. Nothing is sent by default, and any site can be disabled
        entirely. Questions you type into the popup chat, along with the
        page&rsquo;s claim context, are likewise sent only when you send them.
      </p>
      <p>
        Sent page text is used for exactly one purpose: extracting the claims
        on the page and matching them against the graph so the extension can
        annotate what you are reading and answer your questions. Analysis
        results are cached server-side, keyed by the page URL and a hash of
        its content, so re-analyzing an unchanged page is instant and is not
        re-processed. Analysis requests authenticate with your API key and
        are metered as described above.
      </p>
      <p>
        The extension stores your settings (API key, markup level, and
        per-site preferences) in your browser&rsquo;s extension storage
        (synced by your browser if you use profile sync). It sets no cookies,
        injects no trackers, runs no analytics, and never rewrites the text
        of pages you visit; annotations are drawn as an overlay.
      </p>

      <h2 id="processors">Service providers</h2>
      <p>
        Analysis runs on infrastructure and model providers acting on our
        behalf: pages you submit are processed by third-party large language
        model providers (currently Anthropic&rsquo;s Claude models), always
        under API terms that exclude training on your data, and our servers
        run on AWS with the web app hosted on Vercel. These providers process
        data to provide the service and for no other purpose.
      </p>

      <h2 id="retention">Retention &amp; deletion</h2>
      <p>
        Cached page analyses expire from the server cache; metering records
        are retained as account history. To delete your account and its
        associated records, email us and we will remove them.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        Questions or deletion requests:{" "}
        <a href="mailto:privacy@minerval.ai">privacy@minerval.ai</a>. See also{" "}
        <Link href="/about">about</Link> for who runs Minerval.
      </p>
    </div>
  );
}
