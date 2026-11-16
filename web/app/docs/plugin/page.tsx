import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Claude Code plugin · Minerval docs",
  description: "Install one plugin and Claude Code (or Cowork) is connected to the graph, with five slash commands, a fact-checking subagent, the caller skills, and an opt-in hook that suggests checking the Markdown Claude writes.",
};

const toc = [
  { depth: 2, text: "Signing in", slug: "signin" },
  { depth: 2, text: "Commands", slug: "commands" },
  { depth: 2, text: "The fact-checker subagent", slug: "agent" },
  { depth: 2, text: "Skills", slug: "skills" },
  { depth: 2, text: "The opt-in hook", slug: "hook" },
  { depth: 2, text: "Running a local copy", slug: "dev" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/plugin"
      title="Claude Code plugin"
      lede={<>Install one plugin and Claude Code (or Cowork) is connected to the graph, with five slash commands, a fact-checking subagent, the caller skills, and an opt-in hook that suggests checking the Markdown Claude writes.</>}
      toc={toc}
    >
      <Code label="In Claude Code">{`/plugin marketplace add minerval-ai/minerval
/plugin install minerval@minerval`}</Code>
      <p>The repository <code>minerval-ai/minerval</code> is its own marketplace, named <code>minerval</code>, holding one plugin of the same name. Everything the plugin adds is a file in <a href="https://github.com/minerval-ai/minerval/tree/main/plugin"><code>plugin/</code></a> on GitHub.</p>
      <h2 id="signin">Signing in</h2>
      <p>With nothing set, the first Minerval call gets an OAuth challenge and Claude Code opens the consent page in your browser. Approve it and you are done. Run <code>/mcp</code> to sign in again. To use an API key instead, export it before you start Claude Code:</p>
      <Code label="Shell">{`export MINERVAL_API_KEY=epk_…`}</Code>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>MINERVAL_API_KEY</code></td>
              <td>Sent as <code>x-api-key</code> on every call. Empty by default, which leaves sign-in to OAuth.</td>
            </tr>
            <tr>
              <td><code>MINERVAL_MCP_URL</code></td>
              <td>The server to connect to. Defaults to <code>https://api.claimgraph.io/mcp</code>; a local API serves <code>http://localhost:3000/mcp</code>.</td>
            </tr>
            <tr>
              <td><code>MINERVAL_FACTCHECK_HOOK</code></td>
              <td><code>1</code>, <code>true</code> or <code>yes</code> turns the hook on (<Link href="/docs/plugin#hook">below</Link>). Off otherwise.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>See <Link href="/docs/auth">Authentication</Link> for what each way in allows.</p>
      <h2 id="commands">Commands</h2>
      <p>Each command is a prompt that tells Claude which tools to call and how to report. The text of each is in <code>plugin/commands/</code>.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Command</th>
              <th>What it does</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>/minerval:check {"<"}text or file{">"}</code></td>
              <td>Runs a passage, or a file's prose, through <code>assess_text</code> and reads the verdicts with <code>get_text_analysis</code>. Groups the results worst first: contradicted or doubtful as written, misleading as written, supported, insufficient evidence, not in the graph. Each matched claim comes with its verdict and page link, and the report ends with a bottom line.</td>
              <td><span className="dc-pill dc-charged">charged</span> one <code>assess_text</code> per chunk</td>
            </tr>
            <tr>
              <td><code>/minerval:claim {"<"}id or assertion{">"}</code></td>
              <td>One node: its canonical form, assessment (status, credence where stated, summary, date), the subclaim tree marked by status, and its arguments and dependents. Given a UUID or a claim page URL it reads directly. Given an assertion it runs <code>match_claim</code> first, says whether you affirm or deny the claim, and falls back to <code>search_claims</code> when nothing matches.</td>
              <td><span className="dc-pill dc-read">free</span> by id; <span className="dc-pill dc-charged">charged</span> for an assertion</td>
            </tr>
            <tr>
              <td><code>/minerval:factcheck-diff [base ref]</code></td>
              <td>Collects the prose a diff adds (Markdown, docs, comments, user-facing strings), skips code and generated files, and checks it with <code>assess_text</code>. With no argument it reads staged and unstaged changes; with a ref, the diff from its merge base. Reports blockers, cautions and clear lines per file, and changes no files. It may run only <code>git diff</code>, <code>git status</code>, <code>git merge-base</code> and <code>git rev-parse</code>.</td>
              <td><span className="dc-pill dc-charged">charged</span> one <code>assess_text</code> per file or chunk</td>
            </tr>
            <tr>
              <td><code>/minerval:contribute {"<"}claim and what to file{">"}</code></td>
              <td>Finds the target node, reads what is already on record, settles the contribution type with you, and drafts it. Shows you the exact text and waits for your confirmation before <code>submit_contribution</code>. For a claim or question the graph does not hold, it uses <code>propose_claim</code> instead, after the same confirmation.</td>
              <td><span className="dc-pill dc-write">free</span> contribution; <span className="dc-pill dc-charged">charged</span> proposal, refunded if a good-faith proposal is rejected</td>
            </tr>
            <tr>
              <td><code>/minerval:report {"<"}what went wrong{">"}</code></td>
              <td>Files a report about the server or its tools with <code>raise_issue</code>: a failure, a missing tool, or an improvement, with a severity. Never about a claim. Shows you the draft first and returns the report id and how many others have hit the same thing.</td>
              <td><span className="dc-pill dc-write">free</span>, 5 an hour</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A contribution is free, and limited to 10 an hour (3 for an account under a day old or below 50 reputation), because each one commands a review nobody pays for. What a charged tool can cost is on <Link href="/docs/owls">Owls and pricing</Link>.</p>
      <h2 id="agent">The fact-checker subagent</h2>
      <p><code>fact-checker</code> is a subagent the main thread can hand a document, a diff or a single assertion. Its instructions confine it to the graph's judgment tools (<code>assess_text</code> with <code>get_text_analysis</code>, <code>match_claim</code>, <code>search_claims</code>, <code>get_claim</code>, <code>get_decomposition</code>) and local file reads, with no web search and no answers from its own recollection. It returns one entry per judged claim, worst first, and a bottom line on whether the text is safe to ship and the smallest edits that would fix it. When a tool errors it files the fault with <code>raise_issue</code> and finishes with what it has.</p>
      <div className="dc-callout dc-principle"><b>How the commands and the subagent read a verdict.</b>The verdict is the graph's: <code>verified</code>, <code>supported</code>, <code>inconclusive</code>, <code>doubtful</code>, <code>contradicted</code>, or <code>unknown</code>, which is an assessed finding that the evidence is insufficient. <code>unassessed</code> (no assessment yet) and <code>not_in_graph</code> are silence, and silence is not evidence either way. <code>undecided</code> means the Matcher reached no verdict on which claim the text states; it says nothing about the claim's truth, and is not the same as <code>unknown</code>. When <code>stance</code> is <code>denies</code>, the text asserts the claim's negation, so the verdict reads inverted.</div>
      <h2 id="skills">Skills</h2>
      <p>The plugin carries the caller skills: the graph's principles for an outside agent, written as guidance. Claude loads each when its description fits the task. The MCP server serves the same files as resources (<code>minerval://skills/…</code>) for clients that do not load skills. <Link href="/docs/resources">Resources, prompts, skills →</Link></p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Skill</th>
              <th>Loaded when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>claim-checking</code></td>
              <td>Writing or reviewing prose that asserts checkable facts, or asked whether a claim is true, disputed or supported</td>
            </tr>
            <tr>
              <td><code>commissioning-research</code></td>
              <td>The user wants to fund work on the graph: a mandate, an assessment, backing an existing mandate</td>
            </tr>
            <tr>
              <td><code>using-minerval</code></td>
              <td>Helping someone use the product: its surfaces, the site page by page, connecting, owls</td>
            </tr>
            <tr>
              <td><code>writing-from-the-graph</code></td>
              <td>Making a document from what the graph holds: which reads help, importance, pinned citations, requests</td>
            </tr>
            <tr>
              <td><code>sql</code></td>
              <td>A question needs a filter, join or count that only <code>query_sql</code> offers</td>
            </tr>
            <tr>
              <td><code>minerval-constitution</code></td>
              <td>Asking why the graph judged as it did, or what a status, confidence or contestation means. The constitution is bundled in full</td>
            </tr>
            <tr>
              <td><code>administrator-skills</code></td>
              <td>Asking how one of the graph's own agents will treat something. Its skills and role prompts are bundled verbatim</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="hook">The opt-in hook</h2>
      <p>The plugin has one hook, off unless <code>MINERVAL_FACTCHECK_HOOK</code> is <code>1</code>, <code>true</code> or <code>yes</code> in the environment Claude Code starts in. It runs after every <code>Write</code> or <code>Edit</code>. When the file ends in <code>.md</code>, <code>.mdx</code>, <code>.markdown</code>, <code>.rst</code> or <code>.txt</code>, it adds a note to Claude's context: if the new text asserts disputable facts, check it with <code>assess_text</code>, warn only about clear cases the graph holds as contradicted or doubtful, cite each one's page, mind the stance, and do not re-check text already checked this session.</p>
      <p>The hook calls nothing itself. The charge comes when Claude acts on the note, so with the hook on, writing Markdown can spend owls without a separate request from you. It is off by default for that reason, and because most edits assert nothing checkable.</p>
      <h2 id="dev">Running a local copy</h2>
      <p>To try a checkout of the repository, start Claude Code with <code>claude --plugin-dir ./plugin</code>, or add the checkout as a marketplace with <code>/plugin marketplace add /path/to/minerval</code>. Set <code>MINERVAL_MCP_URL</code> to point it at a local API.</p>
    </DocPage>
  );
}
