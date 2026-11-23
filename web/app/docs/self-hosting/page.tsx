import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Self-hosting · Minerval docs",
  description: "Run a private Minerval on one machine of your own: the same code and the same agents as the public graph, behind your own sign-in, working on your own material. This page covers what you need, how to start it, and what to decide first.",
};

const toc = [
  { depth: 2, text: "What you need", slug: "needs" },
  { depth: 2, text: "Starting it", slug: "start" },
  { depth: 2, text: "Settings", slug: "settings" },
  { depth: 2, text: "Features", slug: "features" },
  { depth: 2, text: "The deployment's own checks", slug: "checks" },
  { depth: 2, text: "Mirroring the public graph", slug: "mirror" },
  { depth: 2, text: "Publishing back", slug: "publish" },
  { depth: 2, text: "What the package does not do yet", slug: "not-yet" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/self-hosting"
      title="Self-hosting"
      lede={<>Run a private Minerval on one machine of your own: the same code and the same agents as the public graph, behind your own sign-in, working on your own material. This page covers what you need, how to start it, and what to decide first.</>}
      toc={toc}
    >
      <p>The package in <a href="https://github.com/minerval-ai/minerval/tree/main/deploy"><code>deploy/</code></a> is one Docker Compose file that runs four containers. It stands up a <Link href="/docs/members-only">members-only deployment</Link>: every page and every API route needs a signed-in person or a key, and what a person may do follows from the permissions your administrators grant. Nothing is shaped for a kind of organisation. A deployment starts from the public graph's own settings and you change the ones you need.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Container</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>postgres</code></td>
              <td>Postgres 16 with pgvector. It holds everything: the graph, the ledger, the run log</td>
            </tr>
            <tr>
              <td><code>api</code></td>
              <td>The API, MCP at <code>/mcp</code>, and the workers that run the agents, in one process. It applies the database migrations each time it starts</td>
            </tr>
            <tr>
              <td><code>web</code></td>
              <td>The web app, built so that nothing is shown to anyone who has not signed in</td>
            </tr>
            <tr>
              <td><code>sandbox</code></td>
              <td>Where agents run commands over file sets, on a network that reaches the API and nothing else</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="needs">What you need</h2>
      <ul>
        <li><b>A Linux machine</b> with Docker Engine and the Compose plugin. About 4 GB of disk for the images, as much again while they build, and room for the database and your files.</li>
        <li><b>Landlock</b> (Linux 5.13 or later, with <code>landlock</code> among the active security modules) for the sandbox to confine each command to its run's files. Without it the sandbox starts and runs no command: file sets can be added and not explored, and everything else works.</li>
        <li><b>An identity provider that speaks OpenID Connect</b>, with a client registered for the deployment and the callback <code>{"<"}site address{">"}/api/auth/callback/oidc</code>. There is no local accounts page.</li>
        <li><b>A model provider key</b> (Anthropic, OpenAI or OpenRouter), or a model endpoint of your own that speaks the OpenAI Chat Completions API, and a choice of model for each role. Matching and search need embeddings, which only OpenAI's key provides.</li>
        <li><b>A reverse proxy</b> for TLS. The package listens on plain HTTP, on <code>127.0.0.1</code> unless <code>BIND_ADDRESS</code> says otherwise: the web app on port 3001 and the API on 3000.</li>
      </ul>
      <h2 id="start">Starting it</h2>
      <ol className="dc-steps">
        <li>
          <strong>Get the code</strong>
          <p>Clone <code>minerval-ai/minerval</code> onto the machine. The images are built from it; none is published.</p>
        </li>
        <li>
          <strong>Write <code>.env</code></strong>
          <Code label="Shell">{`cd deploy
install -m 600 env.example .env   # readable by you alone
openssl rand -hex 32   # one per secret`}</Code>
          <p><code>install -m 600</code> copies the file readable by your account alone; a plain <code>cp</code> leaves every secret in it readable by every account on the machine. If yours was made that way, run <code>chmod 600 .env api.env</code>. An account that may run <code>docker</code> can read the secrets from the running containers whatever the file's mode.</p>
          <p>Every line of <code>env.example</code> that is not commented out must be filled in: the site's address (<code>SITE_URL</code>); two database passwords (<code>POSTGRES_PASSWORD</code>, <code>DB_OWNER_PASSWORD</code>); the web app's session secret (<code>AUTH_SECRET</code>); the key the web app presents to the API (<code>WEB_API_KEY</code>) and the token the API presents to the sandbox (<code>SANDBOX_TOKEN</code>); your identity provider's issuer, client id and secret; and the model for six roles (Steward, Steward strong, Curator, Extractor, Audit, Dispute Arbitrator). <code>DB_OWNER_PASSWORD</code> must be letters and digits only, which <code>openssl rand -hex</code> gives. With mathematics on, the solver's model is needed too. <code>docker compose</code> stops and names any required setting left empty. Leave <code>RUN_LOG_MODE</code> as the package sets it, <code>record</code>: once you define a label, no agent work starts without it.</p>
        </li>
        <li>
          <strong>Build and start</strong>
          <Code label="Shell">{`docker compose build
docker compose up -d
docker compose logs -f api`}</Code>
          <p>The build takes several minutes. On the first start the API applies every migration; the log should show <code>Migrations complete.</code> and then <code>Server listening</code>.</p>
        </li>
        <li>
          <strong>Become the first administrator</strong>
          <p>Open the site and sign in. A person who holds nothing is shown their sign-in identity (<code>oidc:</code> and their subject at the provider). Put yours in <code>.env</code> as <code>FIRST_ADMINISTRATOR</code>, run <code>docker compose up -d</code>, and sign in again. The first sign-in by that identity, while the deployment has never had an administrator, is granted every permission. It works once.</p>
        </li>
        <li>
          <strong>Follow the setup checklist</strong>
          <p>Health (<code>/admin</code>) says what needs someone now: the deployment's own checks of its configuration, then permissions, labels, the General mandate, owls and material, each item marked as one the operator or an administrator puts right. From there: define labels and tick the model providers and outside services each may be sent to (<code>/admin/labels</code>), grant permissions (<code>/admin/people</code>), set up the General mandate and owls (<code>/admin/budget</code>), and add material (<code>/sources</code>).</p>
        </li>
      </ol>
      <p>To stop: <code>docker compose down</code>; the database and file sets stay in Docker volumes. <code>docker compose down -v</code> deletes them. To upgrade: <code>git pull</code>, <code>docker compose build</code>, <code>docker compose up -d</code>.</p>
      <h2 id="settings">Settings</h2>
      <p>Three places hold them. <code>deploy/.env</code> holds what <code>env.example</code> names, and Compose hands each setting only to the container that reads it. <code>deploy/api.env</code>, optional, holds any other setting the API reads (budgets, intervals, Stripe keys, a connection's credential); the repository's root <code>.env.example</code> lists them. It holds secrets too: make it with <code>install -m 600 /dev/null api.env</code>. The Compose file fixes the rest: members-only, production mode, where the database and the sandbox are.</p>
      <p>The API can also read its settings from one TOML file, named in <code>MINERVAL_CONFIG</code> or found as <code>minerval.toml</code> in the directory it starts in. An environment variable overrides the file, and secrets are never accepted in it. <a href="https://github.com/minerval-ai/minerval/blob/main/deploy/minerval.example.toml"><code>deploy/minerval.example.toml</code></a> is the public graph's own settings written out. The Compose file does not mount one yet.</p>
      <p>The decisions most deployments make first:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>What it decides</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>OWLS</code></td>
              <td><code>sold</code> (the public graph's setting: owls are bought through Stripe) or <code>created</code>, where your administrators create the owls that budget the agents' work. A deployment that pays its own model providers sets <code>created</code></td>
            </tr>
            <tr>
              <td><code>PROVIDER_LABELS</code></td>
              <td>Leave it unset: your administrators then choose, on <code>/admin/labels</code>, which model providers and outside services each label may be sent text at, with nothing cleared until someone ticks it and no restart for a change. Set it only to make that choice here alone: it then overrides the page and fixes the clearance, and a provider with no entry is cleared for <code>public</code> only. <code>public</code> is the public graph&rsquo;s own material: your own work is at <code>members</code> and <code>published</code>, so name both on the line of each provider that is to serve your agents</td>
            </tr>
            <tr>
              <td><code>MODEL_ENDPOINTS</code></td>
              <td>Model servers you run yourself (vLLM, llama.cpp, TGI, Ollama), each with what a call costs per million tokens</td>
            </tr>
            <tr>
              <td><code>RUN_LOG_MODE</code></td>
              <td><code>record</code> (where this package starts it), where every run is logged in full and does not finish until its log is sealed, or <code>best_effort</code>. Keep <code>record</code>: once a label is defined, the blocking <code>run_log</code> check fails in best-effort mode and no agent work starts</td>
            </tr>
            <tr>
              <td><code>FEATURES_OFF</code></td>
              <td>Optional parts to switch off (below)</td>
            </tr>
            <tr>
              <td><code>PRIVATE_RUN_FETCHES</code></td>
              <td><code>any</code>, or <code>given</code>: a run that reads a private label fetches only addresses it was given from outside, never one it wrote</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Every setting, with its file name and environment variable, is in <a href="https://github.com/minerval-ai/minerval/blob/main/docs/deployment.md">docs/deployment.md</a>.</p>
      <h2 id="features">Features</h2>
      <p>Every feature is on unless <code>FEATURES_OFF</code> names it. A feature that is off has its routes unmounted, so the MCP tools generated from them do not exist; its own tools are not registered, agents are not offered its tools, and its workers do not start. Its tables stay.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Feature</th>
              <th>Switching it off removes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>extension</code></td>
              <td>The browser extension's API: the <code>/extension</code> routes and <code>get_page_analysis</code> and <code>get_page_claims</code>, and the backfill of page hashes that lets the extension find pages the graph has read</td>
            </tr>
            <tr>
              <td><code>mathematics</code></td>
              <td>Formal statements in Lean, the Lean checker and the solver's proof attempts, with their routes, tools and worker. Prizes go off with it</td>
            </tr>
            <tr>
              <td><code>prizes</code></td>
              <td>Prizes and bounties for machine-checked proofs: their routes, tools, and the runner's prize-check and window-closing lanes</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p><code>list_features</code> (<code>GET /setup/features</code>) reports which are on, and it is how the web app and outside agents learn it. Where the deployment holds private material and its run log is best-effort, the <code>features</code> check fails while the extension is on, because a best-effort log leaves out the extension's page analysis. The Lean checker is not in the package, so with mathematics on its machine checks are absent.</p>
      <h2 id="checks">The deployment's own checks</h2>
      <p>The preflight is a list of named checks, each answering pass, fail, to do or not applicable with one sentence. To do is not a failure: it is something not set up yet that a check will fail on later. Read it on the setup checklist, or from the machine:</p>
      <Code label="Shell">{`docker compose exec api npm run preflight`}</Code>
      <p>It exits non-zero when any check fails. Once a label besides <code>public</code> is defined, no agent work starts until six blocking checks pass: <code>database</code>, <code>run_log</code>, <code>provider_labels</code>, <code>reports_stay_inside</code>, <code>model_prices</code> and <code>sandbox_confinement</code>. The API still serves meanwhile, logs which check failed, and looks again every minute. <code>GET /setup/preflight</code> serves the same report to whoever holds the operator key.</p>
      <h2 id="mirror">Mirroring the public graph</h2>
      <p>A private deployment reads the public graph from a local, read-only copy: the mirror. It never queries the live graph, because the sequence of things it asked about would show what it is working on. It pulls the whole feed instead, as signed batches of full public rows, and applies a batch only when its signature verifies against a key you configured, it follows the last batch applied, and its tables have the shape this code writes. Mirrored rows are never edited locally. Your own judgment of a public node is recorded beside the public one, at your label.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>MIRROR_FEED_URL</code></td>
              <td>The publishing graph's API address. Setting it makes the deployment a mirror. For Minerval's public graph, <code>https://api.claimgraph.io</code></td>
            </tr>
            <tr>
              <td><code>MIRROR_FEED_PUBLIC_KEYS</code></td>
              <td>The feed's public key or keys, comma-separated. A batch that does not verify is not applied. For Minerval's public graph, the <code>public_key</code> that <code>https://api.claimgraph.io/mirror/feed/key</code> answers</td>
            </tr>
            <tr>
              <td><code>MIRROR_APPLY_INTERVAL_SECONDS</code></td>
              <td>How often the feed is checked. Default 300</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Connect the deployment first (<b>Connect to minerval.ai</b> on the public graph&rsquo;s Overview, <code>/admin/outside</code>): it shows a code that an admin of your organisation on minerval.ai approves, with the grants they choose, and from then on every request is signed with a key the deployment keeps itself. With <code>MIRROR_FEED_URL</code> unset the deployment holds no copy of the public graph. <code>get_mirror_status</code> says how current the mirror is. The feed carries embeddings, so a mirror must embed with the same model as the publisher. <a href="https://github.com/minerval-ai/minerval/blob/main/docs/mirror.md">docs/mirror.md</a> has what travels, the checks, and how mirrored and local rows live together.</p>
      <h2 id="publish">Publishing back</h2>
      <p>A deployment can put what an agent concluded from private evidence on the public graph without the evidence. A page is redacted under a policy, released part by part at the deployment's gate, and built into a package signed with the deployment's Ed25519 key. Anyone can check a package with no database and no network.</p>
      <ol className="dc-steps">
        <li>
          <strong>Set the key and where you run</strong>
          <p><code>PUBLISH_SIGNING_KEY</code> (make one with <code>npx tsx scripts/published-page.ts keygen</code>, and keep a copy: a lost key breaks the record of what you published) and <code>DEPLOYMENT_HOSTING</code> (<code>own_machines</code>, <code>minerval</code> or <code>third_party</code>). No package is built until both are set.</p>
        </li>
        <li>
          <strong>Connect to minerval.ai</strong>
          <p>An administrator presses <b>Connect to minerval.ai</b> on the public graph&rsquo;s Overview; an admin of your organisation on minerval.ai approves it there and gives it <code>publish</code>. Released packages are then sent as the gate&apos;s settings say, signed with the deployment&apos;s own key. A deployment the network does not join connects by hand, and a member of the organisation submits each package on minerval.ai as a file.</p>
        </li>
        <li>
          <strong>Register the key on the public graph</strong>
          <p>An administrator presses <b>Register key</b> on the public graph&rsquo;s Overview (<code>/admin/outside</code>). The deployment signs the registration for the organisation&rsquo;s account and sends it there. Without a connection, sign it with <code>POST /outbound/registration</code> and submit it from that account with <code>register_publisher_key</code> (<code>POST /publishers</code>). The registration and the key are public.</p>
        </li>
      </ol>
      <p>On the public graph a package is checked against the registered key, kept as signed, and the first one for a node files an ordinary contribution, reviewed like any other and charged as a source submission (refunded if not admitted). Once admitted it is a source on the node, weighed by that node's Steward. It gets no special trust. <a href="https://github.com/minerval-ai/minerval/blob/main/docs/published-pages.md">docs/published-pages.md</a> has the package format and the check.</p>
      <h2 id="not-yet">What the package does not do yet</h2>
      <ul>
        <li>No TLS, no published images, no backups: put a proxy in front, build from the repository, and back up the Docker volumes yourself. Back up <code>deploy/.env</code> and <code>deploy/api.env</code> too, somewhere off the machine such as a password manager: they are in neither volume, the restored database needs the owner&rsquo;s password it was run with (or a new one set inside it), and a lost <code>PUBLISH_SIGNING_KEY</code> breaks the record of what you published. The other secrets can be made or issued again.</li>
        <li>One machine and one API process; more than one has not been tried.</li>
        <li>No model server and no identity provider: you bring both.</li>
        <li>No fully offline mode: open-web search, page reading and embeddings cannot be switched off yet.</li>
        <li>No hosted option: Minerval does not yet run a private deployment for an organisation. Installing this package takes someone comfortable with a Linux server.</li>
        <li>Settings change by editing <code>.env</code> and starting again, not in the web app.</li>
      </ul>
      <p>Once it runs, <Link href="/docs/running-a-private-graph">Running a private graph</Link> walks through what to decide, in the web app, in order: labels, people, budgets, material, and what to say outside.</p>
      <p>Further reading on GitHub: <a href="https://github.com/minerval-ai/minerval/blob/main/docs/self-hosting.md">self-hosting.md</a> (the steps in full), <a href="https://github.com/minerval-ai/minerval/blob/main/docs/deployment.md">deployment.md</a> (every setting and check), <a href="https://github.com/minerval-ai/minerval/blob/main/docs/mirror.md">mirror.md</a>, <a href="https://github.com/minerval-ai/minerval/blob/main/docs/published-pages.md">published-pages.md</a>, <a href="https://github.com/minerval-ai/minerval/blob/main/docs/file-sets.md">file-sets.md</a>, <a href="https://github.com/minerval-ai/minerval/blob/main/docs/connections.md">connections.md</a>.</p>
    </DocPage>
  );
}
