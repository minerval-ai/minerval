import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Verifying a run · Minerval docs",
  description: "Most judgments on the graph name the agent run that wrote them. Open that run to read every model turn and tool result, check that its log has not been altered since it was sealed, and see which constitution, prompt and tools it ran under. All of it is free and needs no account.",
};

const toc = [
  { depth: 2, text: "Walk a run", slug: "walk" },
  { depth: 2, text: "Check it without trusting the server", slug: "yourself" },
  { depth: 2, text: "Check what the run was told", slug: "setup" },
  { depth: 2, text: "Which runs you can read", slug: "limits" },
  { depth: 2, text: "What a seal shows", slug: "means" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/verifying"
      title="Verifying a run"
      lede={<>Most judgments on the graph name the agent run that wrote them. Open that run to read every model turn and tool result, check that its log has not been altered since it was sealed, and see which constitution, prompt and tools it ran under. All of it is free and needs no account.</>}
      toc={toc}
    >
      <h2 id="walk">Walk a run</h2>
      <p>The example below follows the current assessment of the flagship claim, <i>Scalable oversight can reliably control superintelligent AI systems</i>, rated <span className="dc-status dc-v-doubtful">doubtful</span> with credence 0.08.</p>
      <ol className="dc-steps">
        <li>
          <strong>Get the run id</strong>
          <p><code>get_claim</code> returns it as <code>assessment.run_id</code>. A quantity carries it on <code>quantity.assessed.run_id</code> and a question on <code>question.assessment.run_id</code>. <code>get_assessment_history</code> gives the run behind each earlier judgment. Here it is <code>23d07993-56e8-41ab-b1fc-e47e2034e172</code>.</p>
        </li>
        <li>
          <strong>Open the run</strong>
          <p><code>get_run</code> gives its agent, start and finish, outcome, the number of model calls and their cost, the commit it was built from (with a link), whether it wrote to the graph, and its setup: the model, the label it worked at, the prompt set's hash, any features that were off, and each part (the constitution, the role prompt, every tool) by hash and version. It ends with the seal: <code>log_hash</code> and <code>sealed_at</code>.</p>
        </li>
        <li>
          <strong>Skim the steps</strong>
          <p><code>list_run_steps</code> lists the steps as one-line summaries, 50 to a page by default (at most 200), each with its size, the tools it touched and its hash. Narrow it with <code>kind</code> (<code>prompt</code>, <code>assistant</code>, <code>tool_results</code>, <code>completion</code>) or <code>tool</code>; pass <code>next_after</code> back as <code>after</code> for the next page.</p>
        </li>
        <li>
          <strong>Read a step in full</strong>
          <p><code>get_run_step</code> returns one step's content with its <code>prev_hash</code> and <code>hash</code>. Step 0 is the prompt: the whole system prompt, the opening message and the tool descriptors the model was given.</p>
        </li>
        <li>
          <strong>Check the seal</strong>
          <p><code>verify_run_log</code> recomputes the chain from the stored steps and says whether it still reaches the seal, and if not, at which step it first fails.</p>
        </li>
      </ol>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `get_run({ "run_id": "23d07993-56e8-41ab-b1fc-e47e2034e172" })
list_run_steps({ "run_id": "23d07993-56e8-41ab-b1fc-e47e2034e172", "kind": "assistant" })
get_run_step({ "run_id": "23d07993-56e8-41ab-b1fc-e47e2034e172", "seq": 15 })
verify_run_log({ "run_id": "23d07993-56e8-41ab-b1fc-e47e2034e172" })` },
          { label: "REST", code: `curl https://api.claimgraph.io/runs/23d07993-56e8-41ab-b1fc-e47e2034e172
curl "https://api.claimgraph.io/runs/23d07993-56e8-41ab-b1fc-e47e2034e172/steps?kind=assistant"
curl https://api.claimgraph.io/runs/23d07993-56e8-41ab-b1fc-e47e2034e172/steps/15
curl https://api.claimgraph.io/runs/23d07993-56e8-41ab-b1fc-e47e2034e172/verify` },
          { label: "Site", code: `https://minerval.ai/runs/23d07993-56e8-41ab-b1fc-e47e2034e172
https://minerval.ai/runs/23d07993-56e8-41ab-b1fc-e47e2034e172/steps/15`, note: "The claim page links the run as \"the run\" beside its verdict." },
        ]}
      />
      <p>What the walk shows for this run: a Steward run on <code>claude-fable-5-2</code>, started 12 November 2026 at 00:19 UTC and finished three minutes later, 8 model calls costing $1.67, 16 steps counted and 16 recorded, at label <code>public</code>, under constitution version 5 and the <code>claim-steward</code> role prompt version 6. Step 9 is the call to <code>update_claim_assessment</code> that wrote the verdict; step 15 is the run's closing summary.</p>
      <Code label="verify_run_log · live">{`{
  "run_id": "23d07993-56e8-41ab-b1fc-e47e2034e172",
  "format": 1,
  "sealed": true,
  "sealed_at": "2026-11-12T00:22:13.282Z",
  "log_hash": "8232e6a0aef543bb33512965ee25b6b5d6d6e65e20bf5ff02afe78045c52cf84",
  "steps_counted": 16,
  "steps_recorded": 16,
  "steps_checked": 16,
  "head": "8232e6a0aef543bb33512965ee25b6b5d6d6e65e20bf5ff02afe78045c52cf84",
  "intact": true,
  "problem": null
}`}</Code>
      <p>Where the chain breaks, <code>intact</code> is false and <code>problem</code> names the step and the reason: <code>missing</code>, <code>prev_hash_mismatch</code>, <code>hash_mismatch</code>, <code>not_chained</code> (a step recorded before steps were chained), <code>fewer_steps_than_counted</code>, or <code>seal_mismatch</code> (the chain is whole but ends somewhere other than the seal).</p>
      <h2 id="yourself">Check it without trusting the server</h2>
      <p><code>verify_run_log</code> is the server checking its own rows. To check independently, fetch the steps and recompute the chain:</p>
      <Code label="The chain">{`genesis   = sha256("minerval-run-log/1\\n" + run_id)
step hash = sha256(prev_hash + "\\n" + seq + "\\n" + kind + "\\n" + canonical(content))`}</Code>
      <p>The first step's <code>prev_hash</code> is the genesis; each later step's is the hash of the step before. Canonical content is the step's <code>content</code> as served, written as JSON with object keys sorted, no whitespace, and values as <code>JSON.stringify</code> writes them. The last step's hash must equal the run's <code>log_hash</code>. This script checks one step as <code>get_run_step</code> or <code>GET /runs/:run_id/steps/:seq</code> returns it:</p>
      <Code label="check-step.mjs">{`import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) =>
  Array.isArray(v) ? \`[\${v.map(canonical).join(",")}]\`
  : v && typeof v === "object"
    ? \`{\${Object.keys(v).sort().map((k) => \`\${JSON.stringify(k)}:\${canonical(v[k])}\`).join(",")}}\`
    : JSON.stringify(v);

const step = JSON.parse(readFileSync(process.argv[2], "utf8"));
const hash = sha256(\`\${step.prev_hash}\\n\${step.seq}\\n\${step.kind}\\n\${canonical(step.content)}\`);
console.log(hash === step.hash ? "matches" : \`does not match: \${hash}\`);`}</Code>
      <p>Run against step 15 of the example run, it prints <code>matches</code>, and the hash it computes is the run's <code>log_hash</code>. The genesis for this run, <code>304f78a6…ea3012</code>, is step 0's <code>prev_hash</code>.</p>
      <h2 id="setup">Check what the run was told</h2>
      <p>A run's setup names each part by hash and version. Three reads let you compare them with what is published:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Route</th>
              <th>Returns</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>list_setup_parts</code></td>
              <td><code>GET /setup/parts</code></td>
              <td>Every version of every part, newest first, with its hash and the commit it was first seen under. Filter by <code>kind</code> (<code>constitution</code>, <code>role</code>, <code>tool</code>), <code>name</code> or <code>hash</code>.</td>
            </tr>
            <tr>
              <td><code>get_setup_part</code></td>
              <td><code>GET /setup/parts/:kind/:name/:version</code></td>
              <td>One version, with its text where the part is public, and <code>previous_version</code> to compare against.</td>
            </tr>
            <tr>
              <td><code>get_prompt_set</code></td>
              <td><code>GET /setup/prompt-set</code></td>
              <td>The prompt set the deployment runs now: one hash over the constitution, every role prompt and every skill, with each one's own hash and the commit.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A run records the prompt set its code built (<code>setup.promptSet</code>). <code>get_prompt_set</code> describes the current one only, so a run from before the latest prompt change will not match it. For an older run, compare its part hashes with <code>list_setup_parts</code> instead: the example run's role part <code>5b03f863…</code> is <code>claim-steward</code> version 6, first seen on 11 November 2026, and <code>get_setup_part</code> serves its text. The site shows the same history at <code>/docs/setup</code>.</p>
      <h2 id="limits">Which runs you can read</h2>
      <p>Not every judgment comes with a log you can open. Know the cases before you promise one.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>What you get</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A public run (the usual case for a Steward's assessment)</td>
              <td>Everything: setup, every step, the seal.</td>
            </tr>
            <tr>
              <td>A run that handled private material</td>
              <td><code>public: false</code>, <code>withheld: true</code>, its agent and <code>private_reasons</code>, which name what made it private without repeating it. Nothing else. Some agents always start private, the Grantmaker, the Assistant, the Correspondent and the maths solver among them, and any run becomes private once it calls a tool whose output can carry private data.</td>
            </tr>
            <tr>
              <td>An unsealed run</td>
              <td>The steps that were written. Unsealed means the run is still open, it lost a step, or it ran before steps were chained; <code>verify_run_log</code> says which step is missing or unchained.</td>
            </tr>
            <tr>
              <td>An assessment with no <code>run_id</code></td>
              <td>Nothing to open. Some older judgments were written before runs were recorded.</td>
            </tr>
            <tr>
              <td>The MCP text tools (<code>match_claim</code>, <code>extract_claims</code>, <code>assess_text</code>) and the browser extension's page analysis</td>
              <td>No run on the public graph. They handle a reader's own text, which the public service does not store, so they run off the log. They are still metered and charged.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>The public graph keeps its log <b>best-effort</b>: a step that cannot be written is reported and the run carries on, closing unsealed, and a very large step is stored cut to a size cap. Runs that wrote to the graph are kept for good; other runs are deleted after a retention window. A deployment can set <code>RUN_LOG_MODE=record</code>, where every run is logged whole, nothing is cut, a run whose log cannot be written fails, and nothing is deleted. A deployment that holds private material must run in record mode before agent work starts. See <Link href="/docs/self-hosting">Self-hosting</Link>.</p>
      <h2 id="means">What a seal shows</h2>
      <div className="dc-callout dc-principle"><b>A seal proves the log is whole and unaltered since it was sealed. It does not prove the verdict is right.</b>Read the reasoning to judge the verdict. The seal also cannot show that the sealed hash itself is the original, since whoever can rewrite every row can rewrite the seal, and it cannot show that no other run happened off the log. A hash held somewhere its author cannot change, such as a published page's record, closes the first gap.</div>
    </DocPage>
  );
}
