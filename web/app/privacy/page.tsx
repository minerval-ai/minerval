import Link from "next/link";
import { PageHead } from "@/components/PageHead";

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
      <PageHead
        title="Privacy policy"
        lede={
          <>
            Minerval collects the minimum it needs to run a metered claim-graph
            service, and nothing it collects is sold, shared for advertising, or
            used to track you anywhere else. What it does keep, including a
            contributor&rsquo;s track record on the graph, is described below.
          </>
        }
      />
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".84rem" }}>
        Effective November 11, 2026 · applies to minerval.ai, the Minerval API, and
        the Minerval browser extension.
      </p>

      <h2 id="accounts">Accounts</h2>
      <p>
        Signing in uses OAuth through GitHub or Google. We store the provider
        and account identifier (e.g. <code>github:12345</code>), and the
        display name, email address and avatar your provider sends. Your
        display name is public; your email address and avatar are shown only
        to you. We never see or
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

      <h2 id="transcripts">Agent transcripts</h2>
      <p>
        The graph&rsquo;s own work is kept on the record. When you submit a
        URL for ingestion, the agents that read it and reason about it leave
        a transcript: the fetched document, their searches, and their
        reasoning. A transcript of a run that changed the graph is kept as
        the record of how the graph was made, and is public unless what the
        run read was private; other transcripts are kept for thirty days.
        Which account asked is never shown with a transcript. Sources are
        public pages by construction (our servers fetch them without
        credentials), and the claims they yield become part of the public
        graph with their provenance.
      </p>
      <p>
        Content you hand over to be analyzed rather than ingested is
        different, and is never part of a transcript: the page open in your
        browser when you use the extension and passages sent to the MCP
        server&rsquo;s analysis tools are processed and then discarded. The
        result of an analysis, which quotes the passages it found claims in,
        is kept for you alone to read for one day after it finishes, and
        then deleted. Only the metering record described above remains.
      </p>

      <h2 id="assistant">The Assistant</h2>
      <p>
        The Assistant is an agent that works for your account, on the Ask
        page and in the extension&rsquo;s chat. Its conversations are yours
        and are kept so you can return to them: we store what you wrote,
        what it replied, the actions it prepared for you and what you
        decided about each, the pages it saved for you, and what each reply
        cost. They are private to your account. A conversation started from
        the extension also stores the address and title of the page you were
        reading and the passages the extension had marked on it, because the
        Assistant is told them; it does not store the page&rsquo;s text.
      </p>
      <p>
        The Assistant&rsquo;s runs leave a transcript like other agents&rsquo;,
        visible only to you and kept for thirty days. Deleting a conversation
        on the Ask page deletes its text, its prepared actions and all of
        those transcripts; deleting a page deletes the page. A page is private
        unless you share it by link: then anyone who holds the link can read
        it, without seeing whose it is, until you stop sharing or delete it. What a conversation
        cost stays in your owl history. Anything the Assistant sends to the
        graph for you (a proposed claim, a contribution, a funded mandate)
        is public like any other, and happens only when you run it or have
        allowed that kind of action. The Assistant is the place to weigh
        anything you would not publish before you bring it to the graph.
      </p>

      <h2 id="mandates">Mandates and the Grantmaker</h2>
      <p>
        Talking to a Grantmaker directs the public graph&rsquo;s work, and
        what directs it is public, so that anyone can see why work was paid
        for. A conversation with a Grantmaker is public from your first
        message, whether or not you fund it, and so is everything after it:
        the mandate&rsquo;s plan while it is drafted, what you say to its
        Grantmaker, the notes it keeps, and the transcripts of the agents
        that direct its money. You are shown as &ldquo;a reader&rdquo;
        unless you choose to be named; your account and email are never
        shown. The page says this before your first message. Conversations
        and mandates begun before this was the rule stay private to their
        funder, as they were promised.
      </p>

      <h2 id="extension">The browser extension</h2>
      <p>
        The extension sends a page&rsquo;s readable text, its URL, and its
        title to the Minerval API <strong>only when you ask it to</strong>:
        by pressing <em>Analyze page</em> in the popup, or by opting a site
        (or all sites) into automatic analysis in the extension&rsquo;s
        settings. Any site can be disabled entirely. Questions you type into
        the popup chat, along with the page&rsquo;s address, title and
        claim context, are likewise sent only when you send them, and are
        kept as a conversation with <a href="#assistant">the Assistant</a>.
      </p>
      <p>
        To show you what is already known about a page (a check another
        reader ran, or the passages the graph recorded from a page it read
        as a source), the extension does send something on each page you
        open (unless you turn this off in its settings): the first four
        characters of a hash of the page&rsquo;s address, a value shared by
        thousands of addresses, with no API key or other identifier. Our
        server answers with the hashes of every such page in that group,
        and the extension asks for a page&rsquo;s results only if its own
        hash is among them, which can happen only for a public page someone
        has already analyzed or one the graph already holds as a source.
      </p>
      <p>
        Sent page text is used for exactly one purpose: extracting the claims
        on the page and matching them against the graph so the extension can
        annotate what you are reading and answer your questions. Page text
        is transient: it is never written to our database or to agent
        transcripts, and no claim is added to the graph from it unless you
        propose that claim. Proposing a claim from the extension sends only
        the claim&rsquo;s wording and any note you write, never the
        page&rsquo;s address, title, or text; it is handled like any claim
        proposed on the site, reviewed and, if accepted, published.
      </p>
      <p>
        The one exception is sharing with other readers, which you can turn
        off in the extension&rsquo;s settings or for any single page. When
        you analyze a page with sharing on, our server fetches that page
        itself, signed out, and keeps the analysis only if it finds the same
        text there, so only pages anyone could read are kept: never inboxes,
        logged-in pages, or paywalled articles. The extension never offers
        drafts you are editing. What is kept is the page&rsquo;s address
        and, for each claim found, the short phrase it was found in, the
        claim it matched, and the verdict; not the page&rsquo;s text, its
        title, or anything about who analyzed it. Analysis
        results are cached in server memory, keyed by the page URL and a
        hash of its content, so re-analyzing an unchanged page is instant
        and is not re-processed; the cache expires within about an hour and
        does not survive a server restart. Chat is different: it is a
        conversation with the Assistant, kept in your account as described
        above until you delete it. Analysis and chat requests
        authenticate with your API key and are metered as described above.
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
        model providers (currently Anthropic, OpenAI for embeddings, and
        Z.ai routed through OpenRouter), always under API terms that
        exclude training on your data, and our servers run on AWS with the
        web app hosted on Vercel. These providers process data to provide
        the service and for no other purpose.
      </p>

      <h2 id="retention">Retention &amp; deletion</h2>
      <p>
        Cached page analyses expire from server memory within about an hour;
        agent transcripts from source ingestion are deleted after thirty
        days; metering records are retained as account history. To delete
        your account and its associated records, email us and we will remove
        them.
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
