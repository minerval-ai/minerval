import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface ApiStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  albSg: ec2.SecurityGroup;
  apiSg: ec2.SecurityGroup;
  dbInstance: rds.DatabaseInstance;
  dbSecret: rds.DatabaseSecret;
  urlExtractionQueue: sqs.Queue;
  claimPipelineQueue: sqs.Queue;
  openaiApiKeySecret: secretsmanager.Secret;
  openrouterApiKeySecret: secretsmanager.Secret;
  anthropicApiKeySecret: secretsmanager.Secret;
  apiKeysSecret: secretsmanager.Secret;
  elicitApiKeySecret: secretsmanager.Secret;
  stripeSecretKeySecret: secretsmanager.Secret;
  stripeWebhookSecretSecret: secretsmanager.Secret;
}

export class ApiStack extends cdk.Stack {
  public readonly albDnsName: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, "EpistemeCluster", {
      vpc: props.vpc,
      // containerInsightsV2 is supported at runtime but types lag behind
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    } as ecs.ClusterProps);

    const taskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    // IAM permissions
    props.urlExtractionQueue.grantSendMessages(taskDef.taskRole);
    props.urlExtractionQueue.grantConsumeMessages(taskDef.taskRole);
    props.claimPipelineQueue.grantSendMessages(taskDef.taskRole);
    props.claimPipelineQueue.grantConsumeMessages(taskDef.taskRole);
    props.dbSecret.grantRead(taskDef.taskRole);
    props.openaiApiKeySecret.grantRead(taskDef.taskRole);
    props.openrouterApiKeySecret.grantRead(taskDef.taskRole);
    props.anthropicApiKeySecret.grantRead(taskDef.taskRole);
    props.apiKeysSecret.grantRead(taskDef.taskRole);
    props.elicitApiKeySecret.grantRead(taskDef.taskRole);
    props.stripeSecretKeySecret.grantRead(taskDef.taskRole);
    props.stripeWebhookSecretSecret.grantRead(taskDef.taskRole);

    const container = taskDef.addContainer("api", {
      image: ecs.ContainerImage.fromAsset("..", {
        platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "episteme-api" }),
      environment: {
        ENVIRONMENT: "production",
        PORT: "3000",
        HOST: "0.0.0.0",
        DB_HOST: props.dbInstance.dbInstanceEndpointAddress,
        DB_PORT: props.dbInstance.dbInstanceEndpointPort,
        DB_NAME: "episteme",
        // Only the ingestion queues use SQS. The Steward is a DB-backed,
        // importance-prioritized drain (claims.steward_state) run in-process by
        // the local runner, so it needs no queue here — and the Curator + other
        // in-memory queues are now drained in prod too (see index.ts).
        SQS_URL_EXTRACTION_QUEUE: props.urlExtractionQueue.queueUrl,
        SQS_CLAIM_PIPELINE_QUEUE: props.claimPipelineQueue.queueUrl,
        // OAuth issuer identity for the remote MCP server: must match the
        // public host clients dial, since it's baked into the /.well-known
        // metadata and token endpoint URLs.
        PUBLIC_API_BASE_URL: "https://api.claimgraph.io",
        // Where the API sends users and points claim links — the OAuth consent
        // redirect (/oauth/authorize → /oauth/consent), MCP page_url values,
        // and the extension's claim links — rides the code default
        // (https://minerval.ai). This had been pinned to episteme.wiki while
        // that was the only zone that resolved; with minerval.ai live the pin
        // was leaking the old domain into citations, MCP links, and OAuth
        // (docs/infrastructure.md cutover step 5).
        //
        // Citation URLs (#290/#292/#322) use the permanent w3id form instead —
        // the registered namespace 302s to the claim page, and stays valid
        // across any future domain move.
        CITATION_URL_BASE: "https://w3id.org/minerval/claim",
        // The Steward assesses/decomposes the main claims — use Fable 5.1 there
        // (issue #77). The importance-priority drain means Fable only ever runs
        // on the top of the queue; the rest stay embedded stubs until budget
        // allows.
        STEWARD_MODEL: "claude-fable-5-1",
        // The other load-bearing governance agents also run on Fable: the
        // Curator adjudicates merges/splits, the Audit Agent polices the
        // governance system, and the Dispute Arbitrator resolves escalations
        // and appeals. The Contribution Reviewer stays on the Sonnet default
        // (governanceModel). Refusal false-positives degrade to Opus 4.8 via
        // the server-side fallback in src/llm/client.ts.
        CURATOR_MODEL: "claude-fable-5-1",
        AUDIT_MODEL: "claude-fable-5-1",
        ARBITRATION_MODEL: "claude-fable-5-1",
        // The Extractor authors the graph's canonical language from arbitrary,
        // wholly untrusted documents whose framing it must not adopt, and
        // everything downstream inherits its wording. It also runs once per
        // DOCUMENT rather than once per claim (6 sources yielded 41 claims in
        // the first live epoch), so the tier is cheap leverage, and the spend
        // is already attributed to the mandate that chose the source. It ran
        // on the Sonnet default through that whole epoch only because it had
        // no knob; config.ts now requires this env in production.
        //
        // Bio-adjacent refusals are the known failure here (#78) and Fable's
        // server-side Opus fallback refuses with it, so extraction retries on
        // EXTRACTOR_FALLBACK_MODEL (Sonnet by default) rather than losing the
        // document.
        EXTRACTOR_MODEL: "claude-fable-5-1",
        // The Matcher's judgment is narrow (same proposition?) over candidates
        // it retrieves itself, and DeepSeek V4 Flash beats Haiku 4.5 on both
        // quality and price (#257). First agent routed off Anthropic; the rest
        // keep their defaults until the eval apparatus (#273/#297) can rank
        // candidates. Pinned here AND as the config default
        // (OPENROUTER_MODELS.deepseekFlash) so corpus and dev runs match on the
        // model production matches on; the model guard asserts the two agree.
        MATCHER_MODEL: "deepseek/deepseek-v4-flash",
        // Spend guardrails. Call limits cap request rate; the TOKEN limits are
        // the real $ governor (they reset hourly/daily, so this is a rate limit:
        // the drain works the highest-importance claims each window and pauses
        // when spent). Tune to taste — these counters are per-process, so they
        // scale with the autoscaled task count. NOTE: Fable is priced 2x Opus
        // per token ($10/$50 vs $5/$25 per MTok). Lowered to a 500k-token/day
        // ceiling, with the other three limits scaled proportionally (1/3 of the
        // first-window values), to hold down spend on the load-bearing agents
        // (issue #77); the drain works the top of the importance queue each
        // window and pauses when spent.
        LLM_HOURLY_CALL_LIMIT: "167",
        LLM_DAILY_CALL_LIMIT: "1667",
        LLM_HOURLY_TOKEN_LIMIT: "133333",
        LLM_DAILY_TOKEN_LIMIT: "500000",
        // Extension page analysis is synchronous behind the ALB (#91): cap
        // claims per page so a typical analyze finishes inside the idle
        // timeout below. The async flow (#93) relaxes the latency pressure,
        // but the cap stays sensible — extension pages are reading surfaces,
        // not corpus ingestion, and this bound is about RESPONSE TIME rather
        // than fan-out cost.
        //
        // EXTRACTION_MAX_CLAIMS (was "8") is deliberately gone: a per-source
        // claim cap truncated dense sources and invited padding in thin ones,
        // and the fan-out cost it stood in for is now bounded by the mandate
        // ledger instead of by a count. See src/config.ts.
        EXTENSION_MAX_CLAIMS: "10",
        // Agent traces (#334 L0): the full tool-use transcript of every agent
        // run, persisted for the eval harness, debugging and the production
        // monitors. On by default now; this pin makes the choice visible.
        // Kept for 30 days by the retention sweep — a Steward run is tens of
        // KB of transcript, so this is a window, not history. llm_usage keeps
        // run_id and cost indefinitely.
        TRACE_LEVEL: "full",
        TRACE_RETENTION_DAYS: "30",
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(props.dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, "password"),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(
          props.openaiApiKeySecret
        ),
        // OpenRouter (#257): holds a placeholder until manually populated;
        // inert unless an agent's *_MODEL is pointed at a vendor/model ID.
        OPENROUTER_API_KEY: ecs.Secret.fromSecretsManager(
          props.openrouterApiKeySecret
        ),
        // Operator/service keys (#70) — the API fails closed in production
        // without them. The web frontend's EPISTEME_API_KEY must be one of
        // these entries.
        API_KEYS: ecs.Secret.fromSecretsManager(props.apiKeysSecret),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(
          props.anthropicApiKeySecret
        ),
        // Elicit connector (#299): opt-in; an invalid/placeholder key
        // degrades to the tools being omitted from Steward runs.
        ELICIT_API_KEY: ecs.Secret.fromSecretsManager(
          props.elicitApiKeySecret
        ),
        // Stripe (#309): placeholder values keep payments disabled (the
        // provider only activates on a real "sk_…" key).
        STRIPE_SECRET_KEY: ecs.Secret.fromSecretsManager(
          props.stripeSecretKeySecret
        ),
        STRIPE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(
          props.stripeWebhookSecretSecret
        ),
      },
    });

    container.addPortMappings({ containerPort: 3000 });

    const service = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [props.apiSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "ApiAlb", {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      // Extension analyze/chat are long synchronous LLM requests; the 60s
      // default idle timeout 504'd real page analyses while the API kept
      // working (#91). 300s covers a capped analyze; #93 makes it async.
      idleTimeout: cdk.Duration.seconds(300),
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
    });

    listener.addTargets("ApiTarget", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // HTTPS:443 listener fronting api.claimgraph.io (the public hostname the
    // Vercel app calls server-to-server). The ACM certificate was provisioned
    // with DNS validation through Cloudflare and is referenced by ARN: the
    // claimgraph.io zone lives on Cloudflare, not Route 53, so CDK cannot
    // DNS-validate a certificate itself here.
    //
    // RECONCILIATION NOTE: this listener was first created out-of-band via the
    // AWS CLI to bring api.claimgraph.io online before this code existed, so
    // CloudFormation does not yet own it. The next `cdk deploy` will fail with
    // "a listener already exists on this port (443)" until the manual listener
    // is removed once:
    //   aws elbv2 describe-listeners --load-balancer-arn <alb-arn> \
    //     --query "Listeners[?Port==\`443\`].ListenerArn" --output text
    //   aws elbv2 delete-listener --listener-arn <that-arn>
    // After that one-time cleanup CDK creates and owns the listener. There is a
    // brief api.claimgraph.io HTTPS gap between delete and deploy; set Cloudflare
    // SSL/TLS to Flexible during the window or run it in a low-traffic period.
    // See docs/infrastructure.md.
    const apiCertificate = acm.Certificate.fromCertificateArn(
      this,
      "ApiCertificate",
      "arn:aws:acm:us-east-1:702111526219:certificate/49ad38f0-d695-468b-9424-f69bd3c8769b"
    );

    const httpsListener = alb.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [apiCertificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });

    httpsListener.addTargets("ApiTargetHttps", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Auto-scaling
    const scaling = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    });

    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 70,
    });

    this.albDnsName = alb.loadBalancerDnsName;

    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name",
    });
  }
}
