import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The Lean checker of docs/mathematics.md sections 5.3, 5.8, and 13.1.
 *
 * - An ECR repository, one image per pin, whose lifecycle rule expires only
 *   untagged images: every tagged pin image is kept so any historical
 *   verdict can be re-run.
 * - A Fargate service for the warm lane in the isolated subnets
 *   (2 vCPU, 16 GB, 60 GB ephemeral), reachable from the API by private DNS.
 * - A task definition for cold-lane checks (4 vCPU, 16 GB) that the API
 *   launches with RunTask, one task per prize check.
 * - Interface endpoints for ECR API, ECR DKR, CloudWatch Logs, and Secrets
 *   Manager, and a gateway endpoint for S3, because the isolated subnets
 *   have no NAT and a task must still pull its image, fetch its token, and
 *   write its logs.
 * - A Secrets Manager secret for the bearer token, generated here and read
 *   by both sides.
 * - A security group with no egress to the load balancer's or the API's
 *   group. The "no callback" rule of section 5.3 is this rule: the checker
 *   can answer the API, and reach nothing else.
 */
export interface LeanCheckerStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  apiSg: ec2.SecurityGroup;
  albSg: ec2.SecurityGroup;
  /**
   * Tag of the image in the ECR repository. Defaults to the pin id in
   * lean-checker/pin.json, which is also the tag README.md's build pushes.
   */
  imageTag?: string;
  /**
   * The pushed image's registry digest (`sha256:...`), reported on every
   * verdict as `image_digest`. Optional because it exists only after the
   * first push; see README.md.
   */
  imageDigest?: string;
  /** A Loogle mirror pinned to the same Mathlib, when one is deployed. */
  loogleUrl?: string;
}

/**
 * The managed S3 prefix list per region, used for the checker's one
 * non-endpoint egress rule (the S3 gateway endpoint, for image layers).
 * Account-independent and stable, but region-specific: a region missing here
 * must be added, or passed as the `s3PrefixListId` context value, after
 * `aws ec2 describe-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.<region>.s3`.
 * A CIDR-based rule would not do: an "anywhere on 443" egress reaches the
 * load balancer's private addresses, which is the callback path this stack
 * exists to close.
 */
const S3_PREFIX_LISTS: Record<string, string> = {
  "us-east-1": "pl-63a5400a",
};

export const CHECKER_PORT = 8080;
export const CHECKER_DNS_NAME = "lean-checker";
export const CHECKER_NAMESPACE = "minerval.internal";

export function readPin(): { pin_id: string; mathlib_tag: string; lean_toolchain: string } {
  const file = path.join(__dirname, "..", "..", "lean-checker", "pin.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export class LeanCheckerStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly tokenSecret: secretsmanager.Secret;
  public readonly checkerSg: ec2.SecurityGroup;
  public readonly cluster: ecs.Cluster;
  public readonly warmService: ecs.FargateService;
  public readonly coldTaskDefinition: ecs.FargateTaskDefinition;
  /** `http://lean-checker.minerval.internal:8080`, the API's LEAN_CHECKER_URL. */
  public readonly serviceUrl: string;
  public readonly pinId: string;
  /** Where RunTask must place cold-lane tasks. */
  public readonly coldSubnetIds: string[];

  constructor(scope: Construct, id: string, props: LeanCheckerStackProps) {
    super(scope, id, props);

    const pin = readPin();
    this.pinId = pin.pin_id;
    const imageTag = props.imageTag ?? pin.pin_id;

    // ---- Registry ---------------------------------------------------------
    this.repository = new ecr.Repository(this, "LeanCheckerRepo", {
      repositoryName: "minerval/lean-checker",
      // A pin tag names exactly one image forever; pushing a different image
      // under the same tag is refused.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
      lifecycleRules: [
        {
          rulePriority: 1,
          description:
            "Expire untagged layers. Tagged pin images have no rule and are never expired: retired pins stay so any historical verdict can be re-run (section 5.5).",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(14),
        },
      ],
    });

    // ---- Bearer token -----------------------------------------------------
    // Generated here, never typed by a person, read by the API task (as
    // LEAN_CHECKER_TOKEN) and by both checker task definitions. Rotate by
    // updating the secret value and forcing new deployments of both.
    this.tokenSecret = new secretsmanager.Secret(this, "LeanCheckerTokenSecret", {
      secretName: "episteme/lean-checker-token",
      description:
        "Bearer token the API presents to the Lean checker (docs/mathematics.md 5.3). Generated; rotate by updating and redeploying both services.",
      generateSecretString: {
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 48,
      },
    });

    // ---- Security groups --------------------------------------------------
    // The endpoints' group admits 443 from the whole VPC, not only from the
    // checker: with private DNS on, every ECR, Logs, and Secrets Manager
    // request from inside the VPC (the API's image pulls and secrets
    // included) resolves to these endpoints, and a narrower rule would break
    // the API's deployments.
    const endpointSg = new ec2.SecurityGroup(this, "LeanCheckerEndpointSg", {
      vpc: props.vpc,
      description: "VPC interface endpoints used by the Lean checker",
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "AWS API calls from inside the VPC"
    );

    const region = cdk.Stack.of(this).region;
    const s3PrefixListId: string | undefined =
      this.node.tryGetContext("s3PrefixListId") ?? S3_PREFIX_LISTS[region];
    if (!s3PrefixListId) {
      throw new Error(
        `No S3 prefix list known for region ${region}; pass -c s3PrefixListId=pl-... (see lean-checker-stack.ts)`
      );
    }

    // The checker's group. Ingress: the API only. Egress: the interface
    // endpoints and the S3 gateway only. There is deliberately no rule
    // naming albSg or apiSg as a destination, and no rule to any CIDR: that
    // absence is the no-callback rule, and infra/test asserts it.
    this.checkerSg = new ec2.SecurityGroup(this, "LeanCheckerSg", {
      vpc: props.vpc,
      description: "Lean checker: ingress from the API only, egress to VPC endpoints only",
      allowAllOutbound: false,
    });
    this.checkerSg.addIngressRule(props.apiSg, ec2.Port.tcp(CHECKER_PORT), "From the API");
    this.checkerSg.addEgressRule(endpointSg, ec2.Port.tcp(443), "ECR, Logs, Secrets Manager endpoints");
    this.checkerSg.addEgressRule(
      ec2.Peer.prefixList(s3PrefixListId),
      ec2.Port.tcp(443),
      "S3 gateway endpoint (image layers)"
    );
    // props.albSg is accepted so the intent is explicit at the call site:
    // nothing here references it, and nothing must.
    void props.albSg;

    // ---- VPC endpoints ----------------------------------------------------
    const isolated: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
    const endpoint = (name: string, service: ec2.InterfaceVpcEndpointAwsService) =>
      new ec2.InterfaceVpcEndpoint(this, name, {
        vpc: props.vpc,
        service,
        subnets: isolated,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    // Roughly $7 per interface endpoint per month (section 5.8).
    endpoint("EcrApiEndpoint", ec2.InterfaceVpcEndpointAwsService.ECR);
    endpoint("EcrDockerEndpoint", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER);
    endpoint("LogsEndpoint", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);
    // Fargate fetches a task's `secrets` over the task's own ENI, so a task
    // in an isolated subnet needs this endpoint to receive its token.
    endpoint("SecretsManagerEndpoint", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER);
    // Image layers come from S3; a gateway endpoint is free and adds a route
    // to the isolated subnets' tables only.
    new ec2.GatewayVpcEndpoint(this, "S3Endpoint", {
      vpc: props.vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [isolated],
    });

    // ---- Cluster and service discovery ----------------------------------------
    this.cluster = new ecs.Cluster(this, "LeanCheckerCluster", {
      vpc: props.vpc,
      // containerInsightsV2 is supported at runtime but types lag behind
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    } as ecs.ClusterProps);
    const namespace = this.cluster.addDefaultCloudMapNamespace({
      name: CHECKER_NAMESPACE,
      type: servicediscovery.NamespaceType.DNS_PRIVATE,
      vpc: props.vpc,
    });
    this.serviceUrl = `http://${CHECKER_DNS_NAME}.${CHECKER_NAMESPACE}:${CHECKER_PORT}`;

    const logGroup = new logs.LogGroup(this, "LeanCheckerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- Task definitions -------------------------------------------------
    const image = ecs.ContainerImage.fromEcrRepository(this.repository, imageTag);
    const environment = (lane: "warm" | "cold"): Record<string, string> => ({
      LEAN_CHECKER_LANE: lane,
      LEAN_CHECKER_PORT: String(CHECKER_PORT),
      LEAN_CHECKER_HOST: "0.0.0.0",
      // Reported on every verdict; the placeholder in the image's pin file
      // is what shows until this is set from the pushed image (README.md).
      ...(props.imageDigest ? { LEAN_CHECKER_IMAGE_DIGEST: props.imageDigest } : {}),
      ...(props.loogleUrl ? { LOOGLE_URL: props.loogleUrl } : {}),
      // Per-job limits (section 5.3): wall clock outside Lean, memory inside
      // it, heartbeats as the default a submission may raise within policy.
      LEAN_CHECKER_JOB_TIMEOUT_S: "600",
      LEAN_CHECKER_JOB_MEMORY_MB: "12288",
      LEAN_CHECKER_JOB_MAX_HEARTBEATS: "400000",
      // The daily CPU-hour cap; a spent cap answers 429 and fails queued
      // jobs as `error`, never as a verdict.
      LEAN_CHECKER_DAILY_CPU_HOURS: lane === "warm" ? "20" : "4",
      // Warm-lane instances never decide prizes (section 5.3).
      LEAN_CHECKER_REFUSE_PRIZE_ON_WARM: "1",
      // Cold lane: one check, then exit; or exit after 20 idle minutes if
      // the launcher never came back for it.
      LEAN_CHECKER_COLD_MAX_CHECKS: "1",
      LEAN_CHECKER_COLD_IDLE_S: "1200",
    });

    const makeTaskDefinition = (
      name: string,
      lane: "warm" | "cold",
      cpu: number,
      memoryLimitMiB: number
    ): ecs.FargateTaskDefinition => {
      const taskDef = new ecs.FargateTaskDefinition(this, name, {
        cpu,
        memoryLimitMiB,
        // Mathlib's oleans and the toolchain are most of the image; the
        // default 20 GiB is too tight for image plus work directory.
        ephemeralStorageGiB: 60,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      // Fargate has no tmpfs; an unnamed volume on the task's ephemeral
      // storage is the writable work directory instead. It exists for the
      // task's life only.
      taskDef.addVolume({ name: "work" });
      const linux = new ecs.LinuxParameters(this, `${name}Linux`, {
        // An init process reaps the `timeout`/`time`/`lean` trees a check leaves.
        initProcessEnabled: true,
      });
      linux.dropCapabilities(ecs.Capability.ALL);
      const container = taskDef.addContainer("lean-checker", {
        image,
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: `lean-checker-${lane}` }),
        environment: environment(lane),
        secrets: {
          LEAN_CHECKER_TOKEN: ecs.Secret.fromSecretsManager(this.tokenSecret),
        },
        linuxParameters: linux,
        // Read-only root: the image is immutable at run time; /work is the
        // only writable path.
        readonlyRootFilesystem: true,
        healthCheck: {
          command: ["CMD-SHELL", `curl -sf http://localhost:${CHECKER_PORT}/health || exit 1`],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          // The warm start (import Mathlib) is one of the measurements the
          // README asks for; two minutes is the allowance until it is known.
          startPeriod: cdk.Duration.seconds(120),
          retries: 3,
        },
      });
      container.addMountPoints({ containerPath: "/work", sourceVolume: "work", readOnly: false });
      container.addPortMappings({ containerPort: CHECKER_PORT });
      return taskDef;
    };

    // Warm lane: 2 vCPU, 16 GB, about $115 per month (section 5.8).
    const warmTaskDef = makeTaskDefinition("WarmTaskDef", "warm", 2048, 16384);
    // Cold lane: 4 vCPU, 16 GB, launched per check with RunTask; about
    // five minutes and $0.02 per check.
    this.coldTaskDefinition = makeTaskDefinition("ColdTaskDef", "cold", 4096, 16384);

    // ---- Warm-lane service --------------------------------------------------
    this.warmService = new ecs.FargateService(this, "WarmService", {
      cluster: this.cluster,
      taskDefinition: warmTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [this.checkerSg],
      vpcSubnets: isolated,
      // One 16 GB task at a time: replace rather than overlap.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: CHECKER_DNS_NAME,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    this.coldSubnetIds = props.vpc.selectSubnets(isolated).subnetIds;

    // ---- Outputs ------------------------------------------------------------
    new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri, description: "Push pin images here, tagged with the pin id" });
    new cdk.CfnOutput(this, "ServiceUrl", { value: this.serviceUrl, description: "LEAN_CHECKER_URL for the API" });
    new cdk.CfnOutput(this, "TokenSecretArn", { value: this.tokenSecret.secretArn, description: "LEAN_CHECKER_TOKEN secret" });
    new cdk.CfnOutput(this, "ClusterArn", { value: this.cluster.clusterArn, description: "Cluster for cold-lane RunTask" });
    new cdk.CfnOutput(this, "ColdTaskDefinitionArn", { value: this.coldTaskDefinition.taskDefinitionArn, description: "Task definition for cold-lane RunTask" });
    new cdk.CfnOutput(this, "CheckerSecurityGroupId", { value: this.checkerSg.securityGroupId, description: "Security group for cold-lane tasks" });
    new cdk.CfnOutput(this, "ColdSubnetIds", { value: cdk.Fn.join(",", this.coldSubnetIds), description: "Isolated subnets for cold-lane tasks" });
    new cdk.CfnOutput(this, "PinId", { value: this.pinId, description: "The pin this stack deploys" });
  }
}
