import Link from "next/link";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Running a private graph · Minerval docs",
  description:
    "For the person who runs Minerval for an organisation once it is installed: what to decide, in what order, and where in the web app each step is. Labels, people, budget, material, first questions, and what to say in public.",
};

const toc = [
  { depth: 2, text: "Before you start", slug: "before" },
  { depth: 2, text: "Words you will meet", slug: "words" },
  { depth: 2, text: "1. Read the setup page", slug: "setup" },
  { depth: 2, text: "2. Decide your labels", slug: "labels" },
  { depth: 2, text: "3. Add people", slug: "people" },
  { depth: 2, text: "4. Set a budget", slug: "budget" },
  { depth: 2, text: "5. Bring in material", slug: "material" },
  { depth: 2, text: "6. Ask questions", slug: "questions" },
  { depth: 2, text: "7. Read what comes back", slug: "reading" },
  { depth: 2, text: "8. Say things in public", slug: "public" },
  { depth: 3, text: "What you believe, and what your evidence shows", slug: "two-kinds" },
  { depth: 3, text: "Set the gate before anything leaves", slug: "gate" },
  { depth: 3, text: "Publish a page", slug: "publish" },
  { depth: 3, text: "A public face people can ask", slug: "face" },
  { depth: 3, text: "What comes back from outside", slug: "back" },
  { depth: 2, text: "9. Bring in another organisation", slug: "others" },
  { depth: 2, text: "Where everything is", slug: "where" },
  { depth: 2, text: "Not in the web app yet", slug: "not-yet" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/running-a-private-graph"
      title="Running a private graph"
      lede={
        <>
          For the person who runs Minerval for an organisation once it is installed. It says what to decide, in what order, and
          where in the web app each step is. Nothing here needs a terminal, except where it says to ask whoever installed it.
        </>
      }
      toc={toc}
    >
      <h2 id="before">Before you start</h2>
      <p>
        A private graph is Minerval run for one organisation: the same agents and the same constitution as the public graph, working
        on your own material, behind your own sign-in. Whoever installs it follows <Link href="/docs/self-hosting">Self-hosting</Link>{" "}
        and hands you three things:
      </p>
      <ul>
        <li>the address of the site, where you sign in with your organisation&rsquo;s usual login;</li>
        <li>the first administrator&rsquo;s permissions, given to you at your first sign-in;</li>
        <li>
          an account for the organisation on the public graph, at <a href="https://minerval.ai">minerval.ai</a>, connected to the
          deployment, if you mean to say anything in public.
        </li>
      </ul>
      <p>
        Some settings can only be changed by them, in the deployment&rsquo;s settings file: which model providers may read which
        label, and who may act on the public graph in the organisation&rsquo;s name. Where a step needs one, this page says so.
      </p>

      <h2 id="words">Words you will meet</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Word</th>
              <th>What it means here</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Node, claim</td>
              <td>One statement, quantity or question the graph holds, with its assessment and the evidence it rests on</td>
            </tr>
            <tr>
              <td>Label</td>
              <td>
                Who may read something. Everything the graph holds carries one. <code>public</code> always exists; you define the
                rest. A label can read other labels: one that reads <code>public</code> sees the public graph as well as its own
                material
              </td>
            </tr>
            <tr>
              <td>Party</td>
              <td>
                Whose material something is: your organisation, or a partner, supplier or customer whose material you hold. Nothing
                resting on a party&rsquo;s material leaves without the say of whoever holds <em>release</em> for that party
              </td>
            </tr>
            <tr>
              <td>Owls</td>
              <td>
                The unit agents&rsquo; work is budgeted in. In a private graph your administrators create them, one owl for a
                dollar of what the models cost you
              </td>
            </tr>
            <tr>
              <td>Mandate</td>
              <td>
                A standing piece of work with a budget: an area to cover, a question to keep current. A Grantmaker plans it with you
                and runs it
              </td>
            </tr>
            <tr>
              <td>Steward</td>
              <td>The agent that assesses a node, under the constitution</td>
            </tr>
            <tr>
              <td>Gate</td>
              <td>
                Where anything going from a label to people who do not read it is checked. The gate to outside is the one between
                your graph and the public
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="setup">1. Read the setup page</h2>
      <p>
        Open <code>/admin</code>. It reads the deployment and lists what needs someone now, then everything as it stands. Nothing on
        it is ticked by hand: a line clears when the thing it is about is done. If the first line, &ldquo;The deployment&rsquo;s own
        checks&rdquo;, says something fails, send it to whoever installed the deployment. Each failure says what to change. Come back
        to this page after each step below.
      </p>

      <h2 id="labels">2. Decide your labels</h2>
      <p>
        On <code>/admin/labels</code>, <b>Define the label</b>. Start with one label for the organisation&rsquo;s own material, say{" "}
        <code>internal</code>, and tick that its holders may also read <code>public</code>. Most organisations need nothing more at
        first. Add a second only for material that a narrower group must not share with the rest of the organisation, such as
        security findings, personnel matters or a partner&rsquo;s confidential data. A label&rsquo;s name cannot be changed, and labels
        are never removed, so take a minute over it.
      </p>
      <div className="dc-callout">
        <b>Then ask whoever installed it to clear a model provider for the label.</b>A model provider is sent nothing at a label you
        define until the deployment&rsquo;s settings say it may (<code>PROVIDER_LABELS</code>). Until then no agent works at that
        label, and the setup page says so under &ldquo;Labels and model providers&rdquo;.
      </div>
      <p>
        On the same page, under the parties, check that one is marked as &ldquo;the organisation that runs this deployment&rdquo;. If
        the setup page says none is, <b>Add the party</b> with that box ticked. Add a party for each outside organisation whose
        material you will bring in, and use <b>Record whose it is</b> to say which sources are theirs.
      </p>

      <h2 id="people">3. Add people</h2>
      <p>
        Ask each colleague to sign in once. They will see that they have no access yet, and the identity to grant it to. Then, on{" "}
        <code>/admin/people</code>, <b>Grant</b> each the permissions they need, or grant them to a group your login provider
        already has.
      </p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              <th>Give it to</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Read at a label</td>
              <td>Everyone who should see what the agents wrote at that label</td>
            </tr>
            <tr>
              <td>Open raw sources at a label</td>
              <td>Those who should also see the documents themselves, not only what the agents took from them</td>
            </tr>
            <tr>
              <td>Direct the graph</td>
              <td>Those who add material, start mandates, and ask for pages to be shown outside</td>
            </tr>
            <tr>
              <td>Fund work</td>
              <td>Those who decide what the agents&rsquo; time is spent on</td>
            </tr>
            <tr>
              <td>Release a party&rsquo;s material</td>
              <td>
                For your organisation&rsquo;s party: whoever signs off on what the organisation says in public. For a partner&rsquo;s
                party: someone at that partner, where they have an account here
              </td>
            </tr>
            <tr>
              <td>Administer the deployment</td>
              <td>Two people, so that one can cover for the other. It grants permissions, and so can grant itself anything</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Every grant and removal is on the log at the foot of the page, which every member can read. A grant is never deleted, only
        marked removed.
      </p>

      <h2 id="budget">4. Set a budget</h2>
      <p>On <code>/admin/owls</code>:</p>
      <ol className="dc-steps">
        <li>
          <strong>Set up the General mandate at each label</strong>
          <p>
            <b>Set up General at</b> your label pays for the graph&rsquo;s upkeep there: re-checking assessments that have gone
            stale, audits, and following up what earlier work left open. Give it a budget and the most it may commit in a day. A
            small daily figure is the safe start; you can raise it once you see what the work costs.
          </p>
        </li>
        <li>
          <strong>Create owls for the people who fund work</strong>
          <p>
            <b>Create the owls</b> into each person&rsquo;s balance, with a note saying what they are for. Every creation is
            logged, and every member can see how many owls exist and how many have been spent. There is no ceiling: the budget is
            your organisation&rsquo;s own money at its own model providers.
          </p>
        </li>
      </ol>

      <h2 id="material">5. Bring in material</h2>
      <p>Agents can only weigh what they can read. Three ways in, each filed at a label you choose:</p>
      <ul>
        <li>
          <b>A document or an address</b>: <code>/sources/new</code>, &ldquo;Add a source&rdquo;. Paste the text if the address
          cannot be reached from where the deployment runs.
        </li>
        <li>
          <b>A set of files</b>: <code>/file-sets</code>, &ldquo;Add this set&rdquo;. Exports, logs, transcripts, a code repository.
          Agents explore them in a sealed sandbox, run their own analysis, and keep what an assessment rests on.
        </li>
        <li>
          <b>A connection to a system</b>: <code>/admin/connections</code>. Agents read a wiki, a warehouse or a ticket system where
          it lives, through tools you pick one by one. Whoever installed the deployment adds the system&rsquo;s read-only credential;
          the page names the setting.
        </li>
      </ul>
      <p>For each, say whose material it is and what that party stands to gain or lose: the agents weigh a source by its stake.</p>

      <h2 id="questions">6. Ask questions</h2>
      <ul>
        <li>
          <b>Propose a claim or a question</b> at the foot of <code>/claims</code>, in one neutral sentence, and choose its label.
          It is reviewed for form, matched against what the graph holds, and assessed.
        </li>
        <li>
          <b>Start a mandate</b> from <code>/ask</code>, &ldquo;Start a mandate&rdquo;. Choose its label, then tell the Grantmaker
          what you want covered. It surveys what the graph holds, asks what it needs, and proposes a plan with a cost. Nothing is
          spent until someone who funds work funds it. A Grantmaker declines a mandate designed to reach a chosen conclusion.
        </li>
        <li>
          <b>Ask the Assistant</b> at <code>/ask</code>. Choose the label it works at for the conversation. It reads the graph for
          you and can propose, contribute and commission work, and it waits for you before anything that spends or speaks for you.
        </li>
        <li>
          <b>Judge a public claim yourselves.</b> On the page of a claim from the public graph, &ldquo;Assess it here&rdquo; has
          your Steward assess it at your label, on everything that label reads, your own material included. Your version sits
          beside the public one and only your label&rsquo;s readers see it. Nothing is sent outside.
        </li>
        <li>
          <b>Connect your own agents.</b> On <code>/account</code>, create an API key and choose its label. An agent holding it
          (Claude Code, say, with the <Link href="/docs/plugin">plugin</Link>) reads and writes at that label only.
        </li>
      </ul>

      <h2 id="reading">7. Read what comes back</h2>
      <p>
        A node&rsquo;s page shows its verdict at each label you read, with the reasoning, the arguments and the evidence. Where your
        label&rsquo;s version and the public one differ, the page shows both. A mandate&rsquo;s page shows what its Grantmaker is
        doing now, what it has paid for, and what it found. Every verdict links to the agent run that made it, step by step.
      </p>
      <p>
        Read the verdicts as findings about the evidence. &ldquo;Inconclusive&rdquo; and &ldquo;doubtful&rdquo; are results, and a
        verdict that goes against what the organisation hoped is the graph working. The point of running one is to learn what your
        own evidence supports.
      </p>

      <h2 id="public">8. Say things in public</h2>
      <h3 id="two-kinds">What you believe, and what your evidence shows</h3>
      <p>An organisation speaks to the public graph in two ways, and readers are shown which is which.</p>
      <ul>
        <li>
          <b>What the organisation believes or intends</b> is a <em>stated view</em>. Sign in to{" "}
          <a href="https://minerval.ai">minerval.ai</a> as the organisation&rsquo;s account, open the node, and state your view at
          the foot of its page: whether you hold it true, false or likely, your reasons, and your stake in the answer. It is shown
          beside the public assessment, as yours, and changes nothing by being there. Reasons you give are put to the node&rsquo;s
          Steward as a challenge, and what it answered is shown. Plans and commitments (&ldquo;we will publish X by June&rdquo;) are
          stated this way, on a node proposed for them if none exists.
        </li>
        <li>
          <b>What your private evidence shows</b> is a <em>published page</em>: your Steward&rsquo;s assessment at your label, with
          what the gate removed marked in place. The public node&rsquo;s Steward weighs it as a source, knowing it cannot see your
          evidence and knowing everything the page&rsquo;s record says about how it was made and released.
        </li>
      </ul>

      <h3 id="gate">Set the gate before anything leaves</h3>
      <p>
        On <code>/gates</code>, the gate to outside says how each kind of thing is treated on its way out. Each kind can be{" "}
        <b>open</b> (it goes as written), left to <b>the Redactor</b> (an agent removes what your redaction policy names, and Audit
        checks its work), or set so that <b>a person decides as well</b>. Most kinds start with the Redactor. For your first weeks,
        set <em>a node&rsquo;s page</em>, <em>mandate terms</em> and <em>proposal</em> to &ldquo;a person decides as well&rdquo;: you
        see every redaction the Redactor proposes, and you learn what it does before trusting it alone.
      </p>
      <p>
        The redaction policy lists what is removed: personal data, security detail, unreleased product detail, commercial figures and
        the like. Read it under <code>/redaction-policies</code> once your first page has been asked for, and save a version with the
        categories your organisation needs. It cannot name a category by how a passage reflects on you; the policy is shown to every
        reader of what you publish.
      </p>

      <h3 id="publish">Publish a page</h3>
      <ol className="dc-steps">
        <li>
          <strong>Register once</strong>
          <p>
            On <code>/outbound</code>, an administrator presses <b>Register this deployment&rsquo;s key on the public graph</b>, and
            may add a sentence on the organisation&rsquo;s interest in what it publishes. That makes the organisation&rsquo;s public
            account the publisher of what the deployment signs.
          </p>
        </li>
        <li>
          <strong>Ask for the page to be shown</strong>
          <p>
            On the node&rsquo;s page, open the version at your label and follow &ldquo;Ask for this page to be shown to them&rdquo;.
            Choose &ldquo;People outside this deployment&rdquo;, once or standing (standing sends each later version too), and the
            node alone or with what sits under it.
          </p>
        </li>
        <li>
          <strong>Decide at the gate</strong>
          <p>
            Where a person decides, the page waits on <code>/gate</code> for whoever holds release for each party it rests on. Approve
            it as the Redactor left it, remove a further passage, or hold a part with a reason. Nobody can edit the words, and a release
            is not taken back.
          </p>
        </li>
        <li>
          <strong>It goes out</strong>
          <p>
            As it starts, the gate to outside sends what it releases at once; <code>/outbound</code> shows each package and what the
            public graph answered. A node that exists only in your graph has nowhere to land yet: on <code>/outbound</code>, write the
            words it is to be proposed in, and they go through the gate too.
          </p>
        </li>
      </ol>
      <div className="dc-callout">
        <b>What the public sees of your choices.</b>A held part is shown as held, with who holds it and since when. A version you did
        not publish is listed as held. Every act on a showing is listed with the permissions the person held, so a reader can see
        when the person who directed the work also released it. What a gate hides is visible as hidden: that is what makes a
        published page worth weighing.
      </div>

      <h3 id="face">A public face people can ask</h3>
      <p>
        A mandate can stand on the public graph as the organisation&rsquo;s face there. On the mandate&rsquo;s page,{" "}
        <b>Offer this mandate on the public graph</b>. Once the gate lets its terms through, anyone on the public graph can address a
        request to it, its Grantmaker decides which to take up under its terms, and the request&rsquo;s public record shows what
        followed. A mandate whose terms are &ldquo;questions about this organisation&rsquo;s own work&rdquo; is how an organisation
        invites the public to ask.
      </p>
      <p>
        Work on the public graph itself is paid in public owls, bought there; your own owls never convert. On{" "}
        <code>/admin/outside</code> you see the organisation&rsquo;s public balance, open a public mandate in your own words, and on a
        public claim&rsquo;s page &ldquo;Fund this on the public graph&rdquo; pays for a fresh public assessment. Each of these is
        public, under the organisation&rsquo;s name.
      </p>

      <h3 id="back">What comes back from outside</h3>
      <ul>
        <li>
          <b>What readers said back</b> (<code>/admin/outside/said-back</code>): challenges to your published pages, each given to
          your Steward to answer.
        </li>
        <li>
          <b>Public requests</b> (<code>/admin/outside/requests</code>): questions on the public graph you may hold evidence for.
          Adopt one to work on it here, and say in public that you are taking it up or that you will not.
        </li>
        <li>
          <b>Agents&rsquo; reports</b> (<code>/admin/outside/reports</code>): faults your agents found in Minerval&rsquo;s own tools,
          which go to Minerval&rsquo;s maintainers through the gate.
        </li>
      </ul>

      <h2 id="others">9. Bring in another organisation</h2>
      <p>
        Another organisation can work inside your graph: an auditor, a partner, an outside reviewer who needs to see what you see
        and reach their own conclusions. Give them:
      </p>
      <ul>
        <li>
          <b>A label of their own that reads yours</b>, say <code>review</code>. They see everything at your label; you do not see
          what they write at theirs, which reaches you only through the gate between the two.
        </li>
        <li>
          <b>A party of their own</b>, with release for it granted to them. What rests on their material needs their say to leave;
          what rests on yours needs yours.
        </li>
        <li>
          <b>Permissions</b>: read at their label; open raw sources at your label only if they should see your documents themselves;
          direct and fund; and a budget, created into their balance or a General mandate at their label.
        </li>
      </ul>
      <div className="dc-callout">
        <b>Before anyone outside your administrators holds &ldquo;direct&rdquo;</b>, ask whoever installed the deployment to set{" "}
        <code>PUBLIC_ACTS_BY=administer</code>. Otherwise anyone who directs can spend the organisation&rsquo;s public owls and
        write to the public Grantmaker in its name.
      </div>
      <p>Be plain with them about what this arrangement does not give them.</p>
      <ul>
        <li>
          Your administrators set the gate as a whole and the redaction policy for their label, and can grant themselves read at it.
          Every grant is logged and every member can read the log; nothing prevents it.
        </li>
        <li>
          A page published from their label is published under your organisation&rsquo;s account, since a deployment has one. What
          they say in their own name, they say from their own account on the public graph.
        </li>
        <li>
          What protects them is that holds show: a part you hold appears outside as held, by whom and since when, and the gate&rsquo;s
          backlog says how many items wait on whose say.
        </li>
      </ul>

      <h2 id="where">Where everything is</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Page</th>
              <th>For</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>/admin</code></td><td>What the setup still needs</td></tr>
            <tr><td><code>/admin/labels</code></td><td>Labels, what each reads, parties, whose a source is</td></tr>
            <tr><td><code>/admin/people</code></td><td>Permissions, and the log of every grant</td></tr>
            <tr><td><code>/admin/owls</code></td><td>Creating owls; the General mandate at each label</td></tr>
            <tr><td><code>/admin/connections</code></td><td>Your systems, read where they live</td></tr>
            <tr><td><code>/sources/new</code>, <code>/file-sets</code></td><td>Adding material</td></tr>
            <tr><td><code>/claims</code></td><td>Finding nodes; proposing one</td></tr>
            <tr><td><code>/ask</code></td><td>The Assistant; starting a mandate</td></tr>
            <tr><td><code>/mandates</code></td><td>Your mandates, and the organisation&rsquo;s public ones</td></tr>
            <tr><td><code>/account</code></td><td>Your owls and your API keys</td></tr>
            <tr><td><code>/gates</code>, <code>/gate</code></td><td>How each gate treats each kind of thing; what waits for your say</td></tr>
            <tr><td><code>/showings</code>, <code>/redaction-policies</code></td><td>Pages asked to be shown; what the Redactor removes</td></tr>
            <tr><td><code>/outbound</code></td><td>Registering the key; pages on their way out</td></tr>
            <tr><td><code>/admin/outside</code></td><td>The organisation on the public graph: balance, public mandates, requests, what came back</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="not-yet">Not in the web app yet</h2>
      <p>These work through the API or an agent holding a key, and have no page of their own yet:</p>
      <ul>
        <li>
          Giving a label a face that people at other labels can address, and asking one (<code>PUT /labels/:label/face</code>,{" "}
          <code>POST /asks</code>).
        </li>
        <li>Stating the organisation&rsquo;s view at a private label, beside an internal assessment, rather than in public.</li>
        <li>Changing the deployment&rsquo;s settings: those are in its settings file, and whoever installed it changes them.</li>
      </ul>
      <p>
        <Link href="/docs/members-only">Members-only deployments</Link> is the reference for everything above, with the routes and the
        rules behind each step.
      </p>
    </DocPage>
  );
}
