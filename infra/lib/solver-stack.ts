import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/**
 * The solver worker (docs/mathematics.md 7.9 and 13.1): a second ECS Fargate
 * service running `npm run worker:solver`, desiredCount 1, on its own task
 * definition with more memory than the API's, the same secrets as the API,
 * and SOLVER_ENABLED and SOLVER_MODEL as environment. The worker claims
 * `attempt_proof` actions from the ledger and runs hours-long attempts, so
 * it lives outside the API's task: an `await` that lasts an afternoon must
 * never stall the local runner's other lanes.
 *
 * Stopping it: SOLVER_ENABLED=false and a deploy (the loop exits), the
 * `solver_paused` row in `platform_flags` (polled each turn, no deploy), or
 * POST /admin/attempts/:id/cancel for one attempt.
 */
export interface SolverStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  apiSg: ec2.SecurityGroup;
  dbInstance: rds.DatabaseInstance;
  dbSecret: rds.DatabaseSecret;
  openaiApiKeySecret: secretsmanager.ISecret;
  openrouterApiKeySecret: secretsmanager.ISecret;
  anthropicApiKeySecret: secretsmanager.ISecret;
  apiKeysSecret: secretsmanager.ISecret;
  elicitApiKeySecret: secretsmanager.ISecret;
  stripeSecretKeySecret: secretsmanager.ISecret;
  stripeWebhookSecretSecret: secretsmanager.ISecret;
  leanChecker?: { url: string; tokenSecret: secretsmanager.ISecret };
  /** "true" to run attempts; anything else keeps the worker idle. Defaults to "false". */
  solverEnabled?: string;
  /** The strong-tier model the solver runs on. */
  solverModel?: string;
}

export class SolverStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: SolverStackProps) {
    super(scope, id, props);

    // Its own cluster in the API's VPC: the API stack keeps its cluster
    // private, and a worker that is deployed and stopped on its own
    // schedule is better off not sharing the API's service rollouts.
    this.cluster = new ecs.Cluster(this, "SolverCluster", {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    } as ecs.ClusterProps);

    const taskDef = new ecs.FargateTaskDefinition(this, "SolverTaskDef", {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });
    this.taskDefinition = taskDef;

    props.dbSecret.grantRead(taskDef.taskRole);
    props.openaiApiKeySecret.grantRead(taskDef.taskRole);
    props.openrouterApiKeySecret.grantRead(taskDef.taskRole);
    props.anthropicApiKeySecret.grantRead(taskDef.taskRole);
    props.apiKeysSecret.grantRead(taskDef.taskRole);
    props.elicitApiKeySecret.grantRead(taskDef.taskRole);
    props.stripeSecretKeySecret.grantRead(taskDef.taskRole);
    props.stripeWebhookSecretSecret.grantRead(taskDef.taskRole);
    if (props.leanChecker) props.leanChecker.tokenSecret.grantRead(taskDef.taskRole);

    taskDef.addContainer("solver", {
      image: ecs.ContainerImage.fromAsset("..", {
        platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
      }),
      command: ["npm", "run", "worker:solver"],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "episteme-solver" }),
      environment: {
        ENVIRONMENT: "production",
        DB_HOST: props.dbInstance.dbInstanceEndpointAddress,
        DB_PORT: props.dbInstance.dbInstanceEndpointPort,
        DB_NAME: "episteme",
        // The kill switch (docs/mathematics.md 7.3): off unless the deploy
        // says otherwise, so no environment runs multi-hour attempts by
        // accident.
        SOLVER_ENABLED: props.solverEnabled ?? "false",
        // The strong tier; config refuses production without it (7.8).
        SOLVER_MODEL: props.solverModel ?? "claude-fable-5-1",
        // The model-env guard names every load-bearing agent, and the
        // Steward's attempt_completed run is invoked from this process on
        // the strong tier (6.4).
        STEWARD_MODEL: "claude-fable-5-1",
        STEWARD_STRONG_MODEL: "claude-fable-5-1",
        CURATOR_MODEL: "claude-fable-5-1",
        AUDIT_MODEL: "claude-fable-5-1",
        ARBITRATION_MODEL: "claude-fable-5-1",
        EXTRACTOR_MODEL: "claude-fable-5-1",
        MATCHER_MODEL: "deepseek/deepseek-v4-flash",
        PUBLIC_API_BASE_URL: "https://api.claimgraph.io",
        CITATION_URL_BASE: "https://w3id.org/minerval/claim",
        ...(props.leanChecker ? { LEAN_CHECKER_URL: props.leanChecker.url } : {}),
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(props.dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, "password"),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(props.openaiApiKeySecret),
        OPENROUTER_API_KEY: ecs.Secret.fromSecretsManager(props.openrouterApiKeySecret),
        API_KEYS: ecs.Secret.fromSecretsManager(props.apiKeysSecret),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(props.anthropicApiKeySecret),
        ELICIT_API_KEY: ecs.Secret.fromSecretsManager(props.elicitApiKeySecret),
        STRIPE_SECRET_KEY: ecs.Secret.fromSecretsManager(props.stripeSecretKeySecret),
        STRIPE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(props.stripeWebhookSecretSecret),
        ...(props.leanChecker
          ? { LEAN_CHECKER_TOKEN: ecs.Secret.fromSecretsManager(props.leanChecker.tokenSecret) }
          : {}),
      },
    });

    // One task, in the API's security group so it reaches the database and
    // the checker the way the API does; no load balancer, no port.
    this.service = new ecs.FargateService(this, "SolverService", {
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [props.apiSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // A deploy replaces the one task; an attempt in flight is found by the
      // reopen sweep and marked orphaned, its spend already on the meter.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    new cdk.CfnOutput(this, "SolverServiceName", {
      value: this.service.serviceName,
      description: "The solver worker's ECS service",
    });
  }
}
